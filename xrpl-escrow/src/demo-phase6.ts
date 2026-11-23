// Phase 6 demo (EDR-016): signed job specs on the XRP Ledger testnet.
//
// Each job's acceptance criteria are a job spec v1 that the client writes and
// both parties sign. Its hash goes on the ledger in a memo on the EscrowCreate,
// and every oracle checks that memo before it verifies, decides each criterion
// by its checks, and signs a verdict that names the spec hash and each
// criterion's pass or fail. The kit judges the checks, never the words.
//
//   1. Both sign, the work passes: the provider finishes.
//   2. The provider hasn't signed: the SDK refuses to lock any XRP.
//   3. The registry's spec is changed after the lock: the oracle refuses, signs
//      nothing, and the client is refunded after the deadline.
//   4. A subjective criterion with no check: refused before any XRP moves.
//   5. "At least 2 of 3 criteria": passes with one criterion failed; finish.
//   6. A shared job (2 of 3 oracles) where oracle C is given a different spec:
//      C refuses, A and B still release; finish.
//   7. Verdict logs: each used verdict's spec hash matches the EscrowCreate memo.
//
// Uses the three local oracles of Phase 5 (run `npm run setup` once first). The
// run log goes to logs/<date>-phase6.txt, the transactions to logs/<date>-phase6-txs.json.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { xrpToDrops, type Client } from "xrpl";
import { sha256Hex } from "./auth.js";
import { EXPLORER_TX, connectTestnet } from "./config.js";
import type { Check } from "./demo.js";
import { type TxResult } from "./escrow.js";
import { HttpError, callJson } from "./http.js";
import { makeJobSpec, parseSpecMemo, ruleText, specHash, type Criterion, type JobSpecV1, type SpecRule } from "./job-spec.js";
import { DATA_DIR, ENV_FILE, ensureLocalSecrets, localOracleProfile, localOracleSet, LOCAL_ORACLES } from "./local-config.js";
import { ledgerTxLookup } from "./oracle/checks/xrpl-tx.js";
import type { SignedVerdict } from "./oracle/server.js";
import type { Job, OracleRef } from "./registry/db.js";
import { EscrowKit, type SharedVerification } from "./sdk/index.js";
import { startService, type Service } from "./services.js";
import { startSpecTamperProxy } from "./tamper-proxy.js";
import { loadOrFundAnchor, loadOrFundWallets, setupOtherOracles, xrpBalance, type Wallets } from "./wallets.js";

export interface Phase6Options {
  registryPort?: number;
  oraclePort?: number; // oracle A; B and C take the next two ports
  dataDir?: string;
  envFile?: string;
  log?: (line: string) => void;
}

const REPORT = (n: number) => JSON.stringify({
  summary: `Summary: testnet escrow fees, run ${n}`,
  sources: ["the EscrowCreate and EscrowFinish of this demo"],
  findings: ["a conditional EscrowFinish pays a higher fee", "a memo adds a few bytes and no fee tier"],
});

export async function runPhase6(client: Client, wallets: Wallets, opts: Phase6Options = {}): Promise<Check[]> {
  const log = opts.log ?? console.log;
  const registryPort = opts.registryPort ?? 8831;
  const oraclePort = opts.oraclePort ?? 8832;
  const envFile = resolve(opts.envFile ?? ENV_FILE);
  // Oracle A uses the same data folder as npm run oracle: one anchor account anchors one log (Gpno N29).
  const dataDir = resolve(opts.dataDir ?? DATA_DIR);
  const registryUrl = `http://127.0.0.1:${registryPort}`;
  const jobsDb = resolve(dataDir, "jobs-phase6.db");
  const base = { envFile, dataDir, port: oraclePort };
  const set: OracleRef[] = localOracleSet(base);
  const names = ["A", "B", "C"];
  const commonEnv = { REGISTRY_PORT: String(registryPort), REGISTRY_URL: registryUrl, JOBS_DB: jobsDb, ANCHOR_INTERVAL_MS: "4000" };
  const oracleEnv = (i: number, registry = registryUrl) => {
    const p = localOracleProfile(LOCAL_ORACLES[i], base);
    return {
      ...commonEnv, REGISTRY_URL: registry, ENV_FILE: p.envFile, DATA_DIR: p.dataDir, ORACLE_PORT: String(p.port), ORACLE_FAULT: "",
      VAULT_FILE: resolve(p.dataDir, "oracle-vault.json"), VERDICT_LOG: resolve(p.dataDir, "verdicts.jsonl"),
      VERDICT_CHAIN: resolve(p.dataDir, "verdict-log.jsonl"), ANCHOR_FILE: resolve(p.dataDir, "verdict-anchors.jsonl"),
      REPLAY_FILE: resolve(p.dataDir, "oracle-replay.json"),
    };
  };
  const priceDrops = xrpToDrops(5);
  const { client: payer, provider } = wallets;
  const kit = new EscrowKit({
    xrpl: client, registryUrl, oracleUrl: set[0].url, oracleAddress: set[0].address, anchorAddress: set[0].anchor, statusTimeoutMs: 90_000,
  });
  const lookupTx = ledgerTxLookup(client as never);
  const checks: Check[] = [];
  let scenario = "";
  const check = (label: string, ok: boolean, detail = "") => {
    checks.push({ scenario, label, ok, detail });
    log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` (${detail})` : ""}`);
    return ok;
  };
  const link = (hash: string) => `${EXPLORER_TX}${hash}`;
  const tx = (label: string, r: TxResult, expected: string) => check(`${label} -> ${expected}`, r.code === expected, `${r.code} ${link(r.hash)}`);
  const refusal = async (what: () => Promise<unknown>): Promise<string | null> => {
    try {
      await what();
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  const criteria = (n: number): Criterion[] => [
    { id: "format", statement: "A JSON report with a summary, sources and findings", kind: "objective",
      checks: [{ type: "json-schema", schema: { type: "object", properties: { summary: { type: "string" }, sources: { type: "array" }, findings: { type: "array" } }, required: ["summary", "sources", "findings"] } }] },
    { id: "useful", statement: "The research is useful", kind: "subjective",
      checks: [{ type: "size-range", minBytes: 100, maxBytes: 20_000 }, { type: "contains-text", text: "Summary:" }] },
    { id: "exact", statement: "It is the exact report agreed in advance", kind: "objective", checks: [{ type: "sha256-match", sha256: sha256Hex(REPORT(n)) }] },
  ];
  const spec = (n: number, slaSeconds: number, rule: SpecRule = "all"): JobSpecV1 => makeJobSpec({
    title: `Phase 6 demo job ${n}: testnet fee research`, client: payer.address, provider: provider.address, priceDrops, slaSeconds, criteria: criteria(n), rule,
  });

  const showSpec = (s: JobSpecV1) => {
    log(`    spec v${s.specVersion} revision ${s.revision}, hash ${specHash(s)}; rule: ${ruleText(s.rule, s.criteria.length)}`);
    for (const c of s.criteria) log(`      ${c.id} (${c.kind}): "${c.statement}" decided by ${c.checks.map((x) => x.type).join(", ")}`);
  };
  const showVerdict = (who: string, v: SignedVerdict | undefined) => {
    if (!v) return;
    log(`    ${who}: ${v.verdict} on spec ${v.specHash ?? "(unsigned)"} revision ${v.specRevision ?? "-"}, judged the ${v.judged ?? "checks"}`);
    for (const c of v.criteria ?? []) {
      log(`      ${c.id} (${c.kind}): ${c.pass ? "pass" : "fail"} [${v.checks.filter((r) => r.criterion === c.id).map((r) => `${r.type}: ${r.pass ? "pass" : "fail"}`).join(", ")}]`);
    }
  };

  /** Create, sign by both, fund. Prints the spec, both signers and the EscrowCreate with its memo read back from the ledger. */
  async function signedFundedJob(s: JobSpecV1, shared = false): Promise<Job> {
    showSpec(s);
    const draft = shared ? await kit.createSharedJob({ spec: s, oracles: set, threshold: 2 }, payer) : await kit.createSignedJob(s, payer);
    const signed = await kit.signSpec(draft.id, provider, specHash(s));
    check("client and provider both signed the spec hash", !!signed.specSignatures?.client && !!signed.specSignatures?.provider,
      `client ${signed.specSignatures?.client?.address}, provider ${signed.specSignatures?.provider?.address}`);
    const { tx: created, job } = await kit.fundJob(draft.id, payer, { specHash: specHash(s) });
    tx("EscrowCreate with the spec memo", created, "tesSUCCESS");
    const onLedger = await lookupTx(created.hash);
    const memo = onLedger.found ? parseSpecMemo(onLedger.tx.Memos) : null;
    check("the validated EscrowCreate's memo holds the spec hash and revision", !!memo && !("problem" in memo) && memo.specHash === specHash(s),
      memo && !("problem" in memo) ? `memo ${JSON.stringify(memo)}` : JSON.stringify(memo));
    check("watcher marked the job funded", job.status === "funded");
    return job;
  }

  async function claim(job: Job, fulfillment: string | null) {
    if (!fulfillment) return check("fulfillment released", false);
    const before = await xrpBalance(client, provider.address);
    const { tx: fin, job: paid } = await kit.claim(job.id, provider, fulfillment);
    tx("EscrowFinish", fin, "tesSUCCESS");
    check("watcher marked the job paid", paid.status === "paid");
    const gained = (await xrpBalance(client, provider.address)) - before;
    check("provider gains the price minus the finish fee", gained > 4.99, `+${gained.toFixed(6)} XRP`);
  }

  const services: { registry?: Service; watcher?: Service; oracles: (Service | undefined)[] } = { oracles: [] };
  const startOracle = async (i: number, registry = registryUrl) => {
    services.oracles[i] = await startService({
      name: `oracle ${names[i]}`, script: "src/oracle/server.ts", env: oracleEnv(i, registry), healthUrl: `${set[i].url}/health`,
      log: (line) => log(line.replace("    |", `    ${names[i]} |`)),
    });
  };
  let proxy: Awaited<ReturnType<typeof startSpecTamperProxy>> | null = null;
  const used: { job: Job; verdict: SignedVerdict; oracle: OracleRef }[] = [];

  try {
    log("\nStarting the registry, the watcher and three local oracles on 127.0.0.1 ...");
    for (const [i, o] of set.entries()) log(`  oracle ${names[i]}: verdict key ${o.address}, anchor account ${o.anchor}, ${o.url}`);
    services.registry = await startService({ name: "registry", script: "src/registry/server.ts", env: { ...commonEnv, ENV_FILE: envFile }, healthUrl: `${registryUrl}/health`, log });
    services.watcher = await startService({ name: "watcher", script: "src/watcher.ts", env: { ...commonEnv, ENV_FILE: envFile }, readyLine: /\[watcher\] connected/, log });
    for (const i of [0, 1, 2]) await startOracle(i);

    // ---- 3 starts first: it waits for its deadline --------------------------------------
    scenario = "3. Spec changed after the lock";
    log(`\n${scenario}: both sign and the client funds; then the registry's copy of the spec is loosened`);
    const s3 = spec(3, 60);
    const job3 = await signedFundedJob(s3);
    const loose = { ...s3, rule: "all", criteria: [{ id: "anything", statement: "Anything at all", kind: "objective", checks: [{ type: "size-range", minBytes: 1, maxBytes: 1_000_000 }] }] };
    const db = new Database(jobsDb);
    db.prepare("UPDATE jobs SET spec = ? WHERE id = ?").run(JSON.stringify(loose), job3.id);
    db.close();
    log(`    the registry now serves a spec with hash ${specHash(loose as JobSpecV1)} (one criterion: "anything at all")`);
    const why3 = await refusal(() => kit.deliver(job3.id, provider, "not the report"));
    check("the oracle refuses the job and signs nothing", !!why3 && /spec check failed: .* is not the spec locked on the ledger/.test(why3), why3 ?? "it verified");
    const log3 = await callJson<{ entries: { jobId?: string }[] }>("GET", `${set[0].url}/verdicts?from=0&limit=500`);
    check("no verdict for job 3 in oracle A's public log", !log3.entries.some((e) => e.jobId === job3.id));

    // ---- 1. Both sign, the work passes ------------------------------------------------
    scenario = "1. Both sign, the work passes";
    log(`\n${scenario}`);
    const s1 = spec(1, 300);
    const job1 = await signedFundedJob(s1);
    const d1 = await kit.deliver(job1.id, provider, REPORT(1));
    showVerdict("oracle A", d1.verdict);
    check("signed verdict: pass, on the signed spec hash, every criterion passed",
      d1.verdictSignatureValid && d1.specMatches && d1.verdict.verdict === "pass" && (d1.verdict.criteria ?? []).every((c) => c.pass));
    await claim(job1, d1.fulfillment);
    used.push({ job: job1, verdict: d1.verdict, oracle: set[0] });

    // ---- 2. The provider hasn't signed ------------------------------------------------
    scenario = "2. The provider hasn't signed";
    log(`\n${scenario}`);
    const s2 = spec(2, 300);
    showSpec(s2);
    const job2 = await kit.createSignedJob(s2, payer);
    const before2 = await xrpBalance(client, payer.address);
    const why2 = await refusal(() => kit.fundJob(job2.id, payer));
    check("the SDK refuses to lock XRP", !!why2 && /refusing to lock XRP .* provider .* has not signed/.test(why2), why2 ?? "it funded");
    check("no EscrowCreate was sent: the client's balance is unchanged", (await xrpBalance(client, payer.address)) === before2);

    // ---- 4. Subjective criterion with no check ----------------------------------------------
    scenario = "4. Subjective criterion with no check";
    log(`\n${scenario}: "The research is useful", with no check behind it`);
    const vague = { ...spec(4, 300), criteria: [{ id: "useful", statement: "The research is useful", kind: "subjective", checks: [] }] };
    const why4sdk = await refusal(() => kit.createJob({ spec: vague as unknown as JobSpecV1 }));
    check("the SDK refuses it before anything is sent", !!why4sdk && /can't judge that statement/.test(why4sdk), why4sdk ?? "accepted");
    const why4reg = await refusal(() => callJson("POST", `${registryUrl}/jobs`, { client: payer.address, provider: provider.address, priceDrops, slaSeconds: 300, spec: vague }));
    check("the registry refuses it too, in plain words", !!why4reg && /can't judge that statement/.test(why4reg), why4reg ?? "accepted");

    // ---- 5. At least 2 of 3 criteria ------------------------------------------------------
    scenario = "5. At least 2 of 3 criteria";
    log(`\n${scenario}: the report is useful and well formed, but not the exact file agreed`);
    const s5 = spec(5, 300, { atLeast: 2 });
    const job5 = await signedFundedJob(s5);
    const d5 = await kit.deliver(job5.id, provider, REPORT(55));
    showVerdict("oracle A", d5.verdict);
    const c5 = d5.verdict.criteria ?? [];
    check("criteria: format pass, useful pass, exact fail; the rule is met", c5.map((c) => c.pass).join() === "true,true,false" && d5.verdict.verdict === "pass");
    await claim(job5, d5.fulfillment);
    used.push({ job: job5, verdict: d5.verdict, oracle: set[0] });

    // ---- 6. Shared job, one oracle given a different spec ----------------------------------------
    scenario = "6. Shared job, one oracle given a different spec";
    log(`\n${scenario}: oracle C reads jobs through a stand-in registry that loosens every spec`);
    proxy = await startSpecTamperProxy(registryUrl, (s) => ({ ...s, rule: "all", criteria: [{ id: "anything", statement: "Anything at all", kind: "objective", checks: [{ type: "size-range", minBytes: 1, maxBytes: 1_000_000 }] }] }));
    await services.oracles[2]?.stop();
    await startOracle(2, proxy.url);
    const s6 = spec(6, 300);
    const job6 = await signedFundedJob(s6, true);
    const d6: SharedVerification = await kit.deliverShared(job6.id, provider, REPORT(6));
    for (const r of d6.reports) {
      if (r.verdict) showVerdict(`oracle ${names[r.index - 1]}`, r.verdict);
      else log(`    oracle ${names[r.index - 1]}: ${r.status}: ${r.problems.join("; ")}`);
    }
    check("oracle C refuses: the spec it was given is not the one locked on the ledger",
      d6.refused.length === 1 && d6.refused[0] === set[2].address && /not the spec locked on the ledger/.test(d6.reports[2].problems.join()));
    check("A and B pass on the signed spec hash", d6.passed.length === 2 && d6.reports.slice(0, 2).every((r) => r.verdict?.specHash === specHash(s6)));
    check("two shares rebuild the fulfillment", !!d6.fulfillment, `shares of ${d6.reports.filter((r) => r.used).map((r) => names[r.index - 1]).join(" and ")}`);
    await claim(job6, d6.fulfillment);
    for (const r of d6.reports.filter((x) => x.used)) used.push({ job: job6, verdict: r.verdict!, oracle: r.oracle });
    await services.oracles[2]?.stop();
    await startOracle(2);

    // ---- 3. Refund ---------------------------------------------------------------------------
    scenario = "3. Spec changed after the lock";
    log(`\n${scenario} (after the deadline)`);
    const { tx: cancel, job: refunded } = await kit.refund(job3.id, payer);
    tx("EscrowCancel after CancelAfter", cancel, "tesSUCCESS");
    check("watcher marked the job refunded", refunded.status === "refunded");

    // ---- 7. Verdict logs against the ledger --------------------------------------------------
    scenario = "7. Verdict logs and spec memos";
    log(`\n${scenario}: each used verdict is in its oracle's log (v2 entries), and its spec hash is the one in the EscrowCreate memo`);
    for (const u of used) {
      const job = await kit.getJob(u.job.id);
      const k = new EscrowKit({ xrpl: client, registryUrl, oracleUrl: u.oracle.url, oracleAddress: u.oracle.address, anchorAddress: u.oracle.anchor });
      const res = await k.verifyVerdictLog({ verdict: u.verdict, job, allowUnanchored: true });
      const n = names[set.findIndex((o) => o.address === u.oracle.address)];
      check(`oracle ${n}, job ${job.id.slice(0, 8)}: log checks, entry v${res.verdictEntry?.v} names spec ${u.verdict.specHash?.slice(0, 16)}..., memo matches`,
        res.ok && res.specOnLedger === true && res.verdictEntry?.v === 2, res.ok ? `entry ${res.verdictEntry?.seq} of ${res.count}` : res.problems.join("; "));
    }
    const splits = await kit.splitJobs();
    check("no job split: honest oracles that judge the same signed spec agree", !splits.some((s) => [job1.id, job5.id, job6.id].includes(s.jobId)));
  } catch (err) {
    if (err instanceof HttpError) log(`  HTTP ${err.status}: ${err.message}`);
    throw err;
  } finally {
    await proxy?.close();
    for (const s of [services.watcher, ...services.oracles, services.registry]) await s?.stop();
  }
  return checks;
}

async function main() {
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
    console.log(line);
  };
  const stamp = new Date().toISOString();
  let base = `${stamp.slice(0, 10)}-phase6`;
  for (let n = 2; existsSync(resolve("logs", `${base}.txt`)); n++) base = `${stamp.slice(0, 10)}-phase6-${n}`;
  log(`npm run demo:phase6 — XRP Ledger testnet, ${stamp}`);
  const client = await connectTestnet();
  const txFile = resolve("logs", `${base}-txs.json`);
  try {
    log(`Connected to ${client.url} (testnet, network_id 1). Loading or funding wallets from the faucet...`);
    const wallets = await loadOrFundWallets(client);
    ensureLocalSecrets();
    const anchor = await loadOrFundAnchor(client);
    const others = await setupOtherOracles(client);
    for (const [role, w] of [...Object.entries(wallets), ["anchor-a", anchor] as const, ...others]) {
      log(`  ${role.padEnd(8)} ${w.address}  ${(await xrpBalance(client, w.address)).toFixed(6)} XRP`);
    }
    const checks = await runPhase6(client, wallets, { log });
    const failed = checks.filter((c) => !c.ok);
    log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
    for (const c of failed) log(`  FAILED  ${c.scenario}: ${c.label} ${c.detail}`);
    process.exitCode = failed.length ? 1 : 0;
  } catch (err) {
    log(`\nRun aborted: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    mkdirSync("logs", { recursive: true });
    const hashes = [...new Set(lines.join("\n").match(/(?<=\/transactions\/)[0-9A-F]{64}/g) ?? [])];
    const txs: unknown[] = [];
    for (const hash of hashes) {
      try {
        txs.push((await client.request({ command: "tx", transaction: hash })).result);
      } catch (err) {
        txs.push({ hash, error: err instanceof Error ? err.message : String(err) });
      }
    }
    writeFileSync(txFile, `${JSON.stringify(txs, null, 1)}\n`);
    await client.disconnect();
    const file = resolve("logs", `${base}.txt`);
    writeFileSync(file, `${lines.join("\n")}\n`);
    console.log(`\nRun log saved to ${file}`);
    console.log(`Transaction JSON saved to ${txFile}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
