// Phase 5 demo (EDR-015): shared verification, 2 of 3 oracles, on the XRP Ledger testnet.
//
// The client makes each job's secret, splits it into three shares (any two rebuild
// it) and seals one share to each of three local oracles. Each oracle checks the
// work on its own, signs its own verdict, writes it to its own log, anchors that
// log from its own anchor wallet, and releases only its own share on its own pass.
// The provider checks every verdict against the oracle's pinned address and its
// log, combines two shares into the fulfillment and finishes the escrow.
//
//   1. All three pass: finish.
//   2. Two pass, one fails: finish. Oracle C runs as a dissenting oracle
//      (ORACLE_FAULT=fail signs fail on every job, and says so in the verdict).
//   3. One passes, two fail (B and C dissent): no fulfillment, refund after the deadline.
//   4. One oracle stopped: the two others still release.
//   5. Each oracle's verdict log, checked against its own anchors on the ledger,
//      and the list of jobs where the set split.
//
// Scenario 2 and 3 run first, because they need the dissenting oracles; the
// demo then restarts B and C as honest oracles. The run log goes to
// logs/<date>-phase5.txt. Run `npm run setup` once first (oracles B and C need
// their own keys and anchor wallets).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { xrpToDrops, type Client } from "xrpl";
import { EXPLORER_TX, connectTestnet } from "./config.js";
import { sleep, type TxResult } from "./escrow.js";
import { callJson } from "./http.js";
import { DATA_DIR, ENV_FILE, ensureLocalSecrets, localOracleProfile, localOracleSet, LOCAL_ORACLES } from "./local-config.js";
import type { Check } from "./demo.js";
import type { Job, OracleRef } from "./registry/db.js";
import { EscrowKit, type Anchor, type SharedVerification } from "./sdk/index.js";
import { startService, type Service } from "./services.js";
import { loadOrFundAnchor, loadOrFundWallets, setupOtherOracles, xrpBalance, type Wallets } from "./wallets.js";
import { sha256Hex } from "./auth.js";

export interface Phase5Options {
  registryPort?: number;
  oraclePort?: number; // oracle A; B and C take the next two ports
  dataDir?: string;
  envFile?: string;
  log?: (line: string) => void;
}

export async function runPhase5(client: Client, wallets: Wallets, opts: Phase5Options = {}): Promise<Check[]> {
  const log = opts.log ?? console.log;
  const registryPort = opts.registryPort ?? 8821;
  const oraclePort = opts.oraclePort ?? 8822;
  const envFile = resolve(opts.envFile ?? ENV_FILE);
  // Oracle A uses the same data folder as npm run oracle: one anchor account anchors one log (Gpno N29).
  const dataDir = resolve(opts.dataDir ?? DATA_DIR);
  const registryUrl = `http://127.0.0.1:${registryPort}`;
  const base = { envFile, dataDir, port: oraclePort };
  const set: OracleRef[] = localOracleSet(base);
  const names = ["A", "B", "C"];
  const commonEnv = { REGISTRY_PORT: String(registryPort), REGISTRY_URL: registryUrl, JOBS_DB: resolve(dataDir, "jobs.db"), ANCHOR_INTERVAL_MS: "4000" };
  const oracleEnv = (i: number, fault: boolean) => {
    const p = localOracleProfile(LOCAL_ORACLES[i], base);
    return {
      ...commonEnv, ENV_FILE: p.envFile, DATA_DIR: p.dataDir, ORACLE_PORT: String(p.port), ORACLE_FAULT: fault ? "fail" : "",
      VAULT_FILE: resolve(p.dataDir, "oracle-vault.json"), VERDICT_LOG: resolve(p.dataDir, "verdicts.jsonl"),
      VERDICT_CHAIN: resolve(p.dataDir, "verdict-log.jsonl"), ANCHOR_FILE: resolve(p.dataDir, "verdict-anchors.jsonl"),
      REPLAY_FILE: resolve(p.dataDir, "oracle-replay.json"),
    };
  };
  const priceDrops = xrpToDrops(5);
  const { client: payer, provider } = wallets;
  const kit = new EscrowKit({ xrpl: client, registryUrl, oracleAddress: set[0].address, anchorAddress: set[0].anchor, statusTimeoutMs: 90_000 });
  const checks: Check[] = [];
  let scenario = "";
  const check = (label: string, ok: boolean, detail = "") => {
    checks.push({ scenario, label, ok, detail });
    log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` (${detail})` : ""}`);
  };
  const link = (hash: string) => `${EXPLORER_TX}${hash}`;
  const tx = (label: string, r: TxResult, expected: string) => check(`${label} -> ${expected}`, r.code === expected, `${r.code} ${link(r.hash)}`);
  const WORK = JSON.stringify({ answer: "the shared-verification report", at: Date.now() });
  const spec = { title: "deliver the report", checks: [{ type: "sha256-match" as const, sha256: sha256Hex(WORK) }] };

  const services: { registry?: Service; watcher?: Service; oracles: (Service | undefined)[] } = { oracles: [] };
  const startOracle = async (i: number, fault: boolean) => {
    services.oracles[i] = await startService({
      name: `oracle ${names[i]}`, script: "src/oracle/server.ts", env: oracleEnv(i, fault), healthUrl: `${set[i].url}/health`,
      log: (line) => log(line.replace("    |", `    ${names[i]} |`)),
    });
  };
  const stopOracle = async (i: number) => {
    await services.oracles[i]?.stop();
    services.oracles[i] = undefined;
  };

  async function fundedJob(slaSeconds: number): Promise<Job> {
    const draft = await kit.createSharedJob({ client: payer.address, provider: provider.address, priceDrops, slaSeconds, spec, oracles: set, threshold: 2 }, payer);
    check("client split the secret 2 of 3 and every oracle took its own sealed share", draft.status === "draft" && draft.threshold === 2, `job ${draft.id}`);
    const { tx: created, job } = await kit.fundJob(draft.id, payer);
    tx("EscrowCreate with the client's condition", created, "tesSUCCESS");
    check("watcher marked the job funded", job.status === "funded");
    return job;
  }

  const report = (res: SharedVerification) => {
    for (const r of res.reports) {
      const n = names[r.index - 1];
      const head = r.log?.head ? `log entry ${r.log.verdictEntry?.seq ?? "?"} of ${r.log.count}, head ${r.log.head.hash.slice(0, 16)}...` : "";
      const anchor = r.log?.anchor ? `, last anchor entry ${r.log.anchor.seq} ${link(r.log.anchor.txHash)}` : r.log ? ", no anchor yet" : "";
      log(`    oracle ${n} ${r.oracle.address}: ${r.status}${r.verdict ? ` (${r.verdict.checks.map((c) => `${c.type}: ${c.pass ? "pass" : "fail"}`).join(", ")})` : ""}`
        + `${r.used ? ", share used" : ""}${head ? `; ${head}${anchor}` : ""}${r.problems.length ? `; ${r.problems.join("; ")}` : ""}`);
    }
  };

  async function claim(job: Job, res: SharedVerification) {
    if (!res.fulfillment) return check("fulfillment combined from two shares", false);
    check("fulfillment combined from two shares of passing oracles", true, `shares of ${res.reports.filter((r) => r.used).map((r) => names[r.index - 1]).join(" and ")}`);
    const before = await xrpBalance(client, provider.address);
    const { tx: fin, job: paid } = await kit.claim(job.id, provider, res.fulfillment);
    tx("EscrowFinish with the combined fulfillment", fin, "tesSUCCESS");
    check("watcher marked the job paid", paid.status === "paid");
    const gained = (await xrpBalance(client, provider.address)) - before;
    check("provider gains the price minus the finish fee", gained > 4.99, `+${gained.toFixed(6)} XRP`);
  }

  try {
    log("\nStarting the registry, the watcher and three local oracles on 127.0.0.1 ...");
    for (const [i, o] of set.entries()) log(`  oracle ${names[i]}: verdict key ${o.address}, anchor account ${o.anchor}, ${o.url}`);
    services.registry = await startService({ name: "registry", script: "src/registry/server.ts", env: { ...commonEnv, ENV_FILE: envFile }, healthUrl: `${registryUrl}/health`, log });
    services.watcher = await startService({ name: "watcher", script: "src/watcher.ts", env: { ...commonEnv, ENV_FILE: envFile }, readyLine: /\[watcher\] connected/, log });
    await startOracle(0, false);
    await startOracle(1, false);
    await startOracle(2, true);

    // ---- 2. Two pass, one fails ------------------------------------------------------
    scenario = "2. Two pass, one fails";
    log(`\n${scenario}: oracle C dissents (ORACLE_FAULT=fail); A and B pass the work`);
    const job2 = await fundedJob(300);
    const d2 = await kit.deliverShared(job2.id, provider, WORK);
    report(d2);
    check("A and B pass, C fails", d2.passed.length === 2 && d2.failed.length === 1 && d2.failed[0] === set[2].address);
    check("C's signed fail says it was a fault, not the work", d2.reports[2].verdict?.checks.some((c) => c.type === "oracle-fault") ?? false);
    check("registry: verified_pass after 2 of 3 signed passes", d2.job.status === "verified_pass");
    await claim(job2, d2);

    // ---- 3. One passes, two fail -------------------------------------------------------
    await stopOracle(1);
    await startOracle(1, true);
    scenario = "3. One passes, two fail";
    log(`\n${scenario}: oracles B and C dissent; only A passes`);
    const job3 = await fundedJob(60);
    const d3 = await kit.deliverShared(job3.id, provider, WORK);
    report(d3);
    check("only A passes", d3.passed.length === 1 && d3.failed.length === 2);
    check("one share can't rebuild the secret: no fulfillment", d3.fulfillment === null);
    check("registry: verified_fail once 2 of 3 failed", d3.job.status === "verified_fail");

    // ---- 1. All three pass ---------------------------------------------------------------
    await stopOracle(1);
    await stopOracle(2);
    await startOracle(1, false);
    await startOracle(2, false);
    scenario = "1. All three pass";
    log(`\n${scenario}`);
    const job1 = await fundedJob(300);
    const d1 = await kit.deliverShared(job1.id, provider, WORK);
    report(d1);
    check("all three oracles pass, every verdict and log checks", d1.passed.length === 3 && d1.rejected.length === 0);
    await claim(job1, d1);

    // ---- 4. One oracle stopped -------------------------------------------------------------
    scenario = "4. One oracle stopped";
    log(`\n${scenario}: oracle C is stopped after the client gave it its share`);
    const job4 = await fundedJob(300);
    await stopOracle(2);
    const d4 = await kit.deliverShared(job4.id, provider, WORK, { attempts: 1 });
    report(d4);
    check("C is unreachable, A and B pass", d4.unreachable.length === 1 && d4.unreachable[0] === set[2].address && d4.passed.length === 2);
    await claim(job4, d4);
    await startOracle(2, false);

    // ---- 3. Refund after the deadline ------------------------------------------------------
    scenario = "3. One passes, two fail";
    log(`\n${scenario} (after the deadline)`);
    const { tx: cancel, job: refunded } = await kit.refund(job3.id, payer);
    tx("EscrowCancel after CancelAfter", cancel, "tesSUCCESS");
    check("watcher marked the job refunded", refunded.status === "refunded");

    // ---- 5. Verdict logs and splits ----------------------------------------------------------
    scenario = "5. Verdict logs and splits";
    log(`\n${scenario}: each oracle anchors its own log; the SDK checks each log against its own anchors`);
    for (const [i, o] of set.entries()) {
      const head = await callJson<{ seq: number; hash: string; count: number }>("GET", `${o.url}/verdicts/head`);
      let anchor: Anchor | null = null;
      for (let t = 0; t < 60 && !(anchor && anchor.seq === head.seq); t++) {
        anchor = (await callJson<{ anchors: Anchor[] }>("GET", `${o.url}/verdicts/anchors`)).anchors[0] ?? null;
        if (!(anchor && anchor.seq === head.seq)) await sleep(2000);
      }
      const k = new EscrowKit({ xrpl: client, registryUrl, oracleUrl: o.url, oracleAddress: o.address, anchorAddress: o.anchor });
      const res = await k.verifyVerdictLog({ verdict: d1.reports[i].verdict });
      check(`oracle ${names[i]}'s log checks, with its job 1 verdict anchored`, res.ok && res.verdictAnchored === true,
        res.ok ? `${res.count} entries, head ${head.hash.slice(0, 16)}..., anchor ${link(res.anchor?.txHash ?? "")}` : res.problems.join("; "));
    }
    const splits = await kit.splitJobs();
    const s2 = splits.find((s) => s.jobId === job2.id);
    const s3 = splits.find((s) => s.jobId === job3.id);
    check("the splits tool lists job 2 (2 pass, 1 fail) and job 3 (1 pass, 2 fail)", s2?.failed.length === 1 && s3?.failed.length === 2,
      `${splits.length} split job(s) in this registry`);
    check("job 1 (all pass) is not a split", !splits.some((s) => s.jobId === job1.id));
  } finally {
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
  let base = `${stamp.slice(0, 10)}-phase5`;
  for (let n = 2; existsSync(resolve("logs", `${base}.txt`)); n++) base = `${stamp.slice(0, 10)}-phase5-${n}`;
  log(`npm run demo:phase5 — XRP Ledger testnet, ${stamp}`);
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
    const checks = await runPhase5(client, wallets, { log });
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
