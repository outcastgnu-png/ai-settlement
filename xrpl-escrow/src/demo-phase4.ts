// Phase 4 demo (EDR-014): the auditable verifier on the XRP Ledger testnet.
//
//   1. Transaction check passes: the job is "make this payment"; the provider
//      pays, hands in the transaction hash, the oracle finds it validated with
//      tesSUCCESS and every field right, and the provider claims the price.
//   2. Transaction failed: the provider's payment exists but failed (tec*), so
//      the oracle says fail and the client is refunded after the deadline.
//   3. Not validated yet: a transaction still in the open ledger fails the check.
//   4. Malformed hash: anything but 64 hex characters fails without a lookup.
//   5. Verdict log: the oracle anchors its log head on the testnet; the SDK
//      fetches the log and checks every signature, the chain and the anchor it
//      reads from the ledger itself; an edited copy of the log fails.
//
// Scenarios 1 and 2 run through the local services (registry, oracle, watcher)
// with real escrows; 3 and 4 run the check on the live ledger directly, since
// they need no escrow. The demo starts its own services and saves the run log
// to logs/<date>-phase4.txt.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client, Wallet, xrpToDrops, type Payment } from "xrpl";
import { EXPLORER_TX, connectTestnet } from "./config.js";
import { submitValidated, sleep, type TxResult } from "./escrow.js";
import { callJson } from "./http.js";
import { DATA_DIR, ENV_FILE, ensureLocalSecrets, readEnvFile } from "./local-config.js";
import type { Check } from "./demo.js";
import { ledgerTxLookup, xrplTxValidated, type TxCheckSpec } from "./oracle/checks/xrpl-tx.js";
import type { Job } from "./registry/db.js";
import { EscrowKit, type Anchor, type LogEntry } from "./sdk/index.js";
import { startService, type Service } from "./services.js";
import { loadOrFundAnchor, loadOrFundWallets, xrpBalance, type Wallets } from "./wallets.js";

export interface Phase4Options {
  registryPort?: number;
  oraclePort?: number;
  dataDir?: string;
  envFile?: string;
  log?: (line: string) => void;
}

const hexText = (text: string) => Buffer.from(text, "utf8").toString("hex").toUpperCase();

export async function runPhase4(client: Client, wallets: Wallets, anchorWallet: Wallet, opts: Phase4Options = {}): Promise<Check[]> {
  const log = opts.log ?? console.log;
  const registryPort = opts.registryPort ?? 8811;
  const oraclePort = opts.oraclePort ?? 8812;
  // The same data folder as npm run oracle and the other demos: one anchor account anchors one log (Gpno N29).
  const dataDir = resolve(opts.dataDir ?? DATA_DIR);
  const registryUrl = `http://127.0.0.1:${registryPort}`;
  const oracleUrl = `http://127.0.0.1:${oraclePort}`;
  const serviceEnv = {
    REGISTRY_PORT: String(registryPort), ORACLE_PORT: String(oraclePort), REGISTRY_URL: registryUrl,
    JOBS_DB: resolve(dataDir, "jobs.db"), VAULT_FILE: resolve(dataDir, "oracle-vault.json"),
    VERDICT_LOG: resolve(dataDir, "verdicts.jsonl"), VERDICT_CHAIN: resolve(dataDir, "verdict-log.jsonl"),
    ANCHOR_FILE: resolve(dataDir, "verdict-anchors.jsonl"), REPLAY_FILE: resolve(dataDir, "oracle-replay.json"),
    ANCHOR_INTERVAL_MS: "4000", ENV_FILE: resolve(opts.envFile ?? ENV_FILE),
  };
  const priceDrops = xrpToDrops(5);
  const { client: payer, provider, oracle: vendor } = wallets;
  const kit = new EscrowKit({
    xrpl: client, registryUrl, oracleUrl, anchorAddress: anchorWallet.address, statusTimeoutMs: 90_000,
    oracleAddress: readEnvFile(serviceEnv.ENV_FILE).ORACLE_VERDICT_ADDRESS,
  });
  const checks: Check[] = [];
  let scenario = "";
  const check = (label: string, ok: boolean, detail = "") => {
    checks.push({ scenario, label, ok, detail });
    log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` (${detail})` : ""}`);
  };
  const link = (hash: string) => `${EXPLORER_TX}${hash}`;
  const tx = (label: string, r: TxResult, expected: string) => check(`${label} -> ${expected}`, r.code === expected, `${r.code} ${link(r.hash)}`);
  const pay = (from: Wallet, to: string, drops: string, memo: string): Payment => ({
    TransactionType: "Payment", Account: from.address, Destination: to, Amount: drops,
    Memos: [{ Memo: { MemoData: hexText(memo) } }],
  });

  async function fundedJob(spec: TxCheckSpec, slaSeconds: number): Promise<Job> {
    const draft = await kit.createJob({ client: payer.address, provider: provider.address, priceDrops, slaSeconds, spec: { title: "make a payment", checks: [spec] } });
    const { tx: created, job } = await kit.fundJob(draft.id, payer);
    tx("EscrowCreate", created, "tesSUCCESS");
    check("watcher marked the job funded", job.status === "funded", `job ${job.id}`);
    return job;
  }

  const services: Partial<Record<"registry" | "oracle" | "watcher", Service>> = {};
  try {
    log("\nStarting local services on 127.0.0.1 ...");
    services.registry = await startService({ name: "registry", script: "src/registry/server.ts", env: serviceEnv, healthUrl: `${registryUrl}/health`, log });
    services.oracle = await startService({ name: "oracle", script: "src/oracle/server.ts", env: serviceEnv, healthUrl: `${oracleUrl}/health`, log });
    services.watcher = await startService({ name: "watcher", script: "src/watcher.ts", env: serviceEnv, readyLine: /\[watcher\] connected/, log });
    const info = await callJson<{ oracle: string; anchorAccount: string | null }>("GET", `${oracleUrl}/health`);
    check("oracle anchors from the pinned anchor account", info.anchorAccount === anchorWallet.address, `anchor ${anchorWallet.address}`);
    check("oracle signs with the pinned verdict address", info.oracle === kit.oracleAddress, `oracle ${info.oracle}`);

    // ---- 1. Pass and claim ------------------------------------------------------
    scenario = "1. Transaction check passes";
    const memo1 = `phase4 order ${Date.now()}`;
    log(`\n${scenario}: the provider pays 1 XRP to ${vendor.address} with memo "${memo1}", then hands in the hash`);
    const job1 = await fundedJob({ type: "xrpl-tx-validated", txType: "Payment", destination: vendor.address, minDrops: "1000000", account: provider.address, memo: memo1 }, 300);
    const paid1 = await submitValidated(client, provider, pay(provider, vendor.address, "1000000", memo1));
    tx("provider's Payment", paid1, "tesSUCCESS");
    const providerBefore = await xrpBalance(client, provider.address);
    const d1 = await kit.deliver(job1.id, provider, paid1.hash);
    check("oracle verdict is pass", d1.verdict.verdict === "pass", d1.verdict.checks.map((c) => c.detail).join("; "));
    check("verdict is signed by the pinned oracle and covers this deliverable", d1.verdictSignatureValid);
    if (d1.fulfillment) {
      const { tx: fin, job } = await kit.claim(job1.id, provider, d1.fulfillment);
      tx("EscrowFinish with the oracle's fulfillment", fin, "tesSUCCESS");
      check("watcher marked the job paid", job.status === "paid");
      const gained = (await xrpBalance(client, provider.address)) - providerBefore;
      check("provider gains the price minus the finish fee", gained > 4.99, `+${gained.toFixed(6)} XRP`);
    } else {
      check("fulfillment released", false);
    }

    // ---- 2. Failed transaction (tec*) -------------------------------------------------
    scenario = "2. Transaction failed";
    const nobody = Wallet.generate().address;
    log(`\n${scenario}: the provider's payment to an unfunded account ${nobody} fails with tecNO_DST_INSUF_XRP`);
    const job2 = await fundedJob({ type: "xrpl-tx-validated", txType: "Payment", destination: nobody, minDrops: "100000" }, 60);
    const failed2 = await submitValidated(client, provider, pay(provider, nobody, "100000", "too small to create the account"));
    tx("provider's Payment (validated, but failed)", failed2, "tecNO_DST_INSUF_XRP");
    const d2 = await kit.deliver(job2.id, provider, failed2.hash);
    check("oracle verdict is fail: the transaction did not succeed", d2.verdict.verdict === "fail" && /did not succeed/.test(d2.verdict.checks[0].detail), d2.verdict.checks[0].detail);
    check("no fulfillment, signed fail verdict", d2.fulfillment === null && d2.verdictSignatureValid);

    // ---- 3. Not validated yet -------------------------------------------------------
    scenario = "3. Not validated yet";
    log(`\n${scenario}: a transaction still in the open ledger does not count`);
    const lookup = ledgerTxLookup(client as never);
    const ctx = (content: string) => ({ job: { createdAt: Date.now() - 60_000 } as Job, content, deliveredAt: Date.now(), lookupTx: lookup });
    const spec3: TxCheckSpec = { type: "xrpl-tx-validated", txType: "Payment", destination: vendor.address, minDrops: "1" };
    let seenUnvalidated = false;
    for (let attempt = 1; attempt <= 3 && !seenUnvalidated; attempt++) {
      const prepared = await client.autofill(pay(payer, vendor.address, "1", `open ledger ${attempt}`));
      const signed = payer.sign(prepared);
      await client.request({ command: "submit", tx_blob: signed.tx_blob });
      for (let i = 0; i < 20; i++) {
        const found = await lookup(signed.hash);
        if (found.found && !found.validated) {
          const result = await xrplTxValidated(spec3, ctx(signed.hash));
          check("check fails on a transaction that is not in a validated ledger", !result.pass && /not in a validated ledger/.test(result.detail), `${result.detail}, ${link(signed.hash)}`);
          seenUnvalidated = true;
          break;
        }
        if (found.found) break; // validated already: too slow to catch it open, try again
        await sleep(150);
      }
      // let it validate, then the same check passes
      const done = await (async () => {
        for (let i = 0; i < 30; i++) {
          const r = await lookup(signed.hash);
          if (r.found && r.validated) return true;
          await sleep(1000);
        }
        return false;
      })();
      if (seenUnvalidated && done) {
        const later = await xrplTxValidated(spec3, ctx(signed.hash));
        check("once validated, the same transaction passes", later.pass, later.detail);
      }
    }
    if (!seenUnvalidated) check("caught a transaction before validation", false, "the ledger validated each try before the check ran");

    // ---- 4. Malformed hash ------------------------------------------------------------
    scenario = "4. Malformed hash";
    log(`\n${scenario}: anything but exactly 64 hex characters fails without a lookup`);
    for (const bad of [`${paid1.hash}\n`, paid1.hash.slice(2), `{"hash":"${paid1.hash}"}`]) {
      const result = await xrplTxValidated(spec3, { ...ctx(bad), lookupTx: async () => { throw new Error("no lookup expected"); } });
      check(`check fails on ${JSON.stringify(bad.length > 24 ? `${bad.slice(0, 12)}...${bad.slice(-6)}` : bad)}`, !result.pass && /not a transaction hash/.test(result.detail), result.detail);
    }

    // ---- 2. Refund after the deadline -------------------------------------------------
    scenario = "2. Transaction failed";
    log(`\n${scenario} (after the deadline)`);
    const { tx: cancel, job: refunded } = await kit.refund(job2.id, payer);
    tx("EscrowCancel after CancelAfter", cancel, "tesSUCCESS");
    check("watcher marked the job refunded", refunded.status === "refunded");

    // ---- 5. Verdict log ----------------------------------------------------------------
    scenario = "5. Verdict log";
    log(`\n${scenario}: the oracle anchors its log head on the testnet; the SDK checks the log against the ledger`);
    const head = await callJson<{ seq: number; hash: string; count: number }>("GET", `${oracleUrl}/verdicts/head`);
    log(`  log head: entry ${head.seq}, hash ${head.hash} (${head.count} entries)`);
    let anchor: Anchor | null = null;
    for (let i = 0; i < 60 && !(anchor && anchor.seq === head.seq); i++) {
      const listed = await callJson<{ anchors: Anchor[] }>("GET", `${oracleUrl}/verdicts/anchors`);
      anchor = listed.anchors[0] ?? null;
      if (!(anchor && anchor.seq === head.seq)) await sleep(2000);
    }
    check("oracle anchored the current head on the testnet", anchor?.seq === head.seq && anchor.hash === head.hash,
      anchor ? `entry ${anchor.seq} in ledger ${anchor.ledgerIndex}, ${link(anchor.txHash)}` : "no anchor");
    const res = await kit.verifyVerdictLog({ verdict: d1.verdict });
    check("every anchor this account put on the ledger agrees with the log", res.anchors.length > 0 && !res.problems.some((p) => /genesis|ledger anchored|covers entry/.test(p)),
      `${res.anchors.length} anchor(s) read from the ledger`);
    check("SDK verified the log: signatures, chain, and the anchor read from the ledger", res.ok,
      res.ok ? `${res.count} entries, anchored entry ${res.anchor?.seq} ${link(res.anchor?.txHash ?? "")}, ${res.unanchored} after it` : res.problems.join("; "));
    check("job 1's own signed verdict is in the log", res.verdictEntry?.seq !== undefined, `entry ${res.verdictEntry?.seq}`);
    const entries = await kit.fetchVerdictLog();
    const edited = JSON.parse(JSON.stringify(entries)) as (LogEntry & { verdict?: string; jobId?: string })[];
    const target = edited.findIndex((e) => e.kind === "verdict" && e.jobId === job2.id);
    edited[target].verdict = "pass";
    const tampered = await kit.verifyVerdictLog({ entries: edited });
    check("an edited copy of the log fails the check", !tampered.ok, tampered.problems[0] ?? "");
    const truncated = await kit.verifyVerdictLog({ entries: entries.slice(0, Math.max(1, (res.anchor?.seq ?? 1))) });
    check("a copy missing the anchored entry fails the check", !truncated.ok, truncated.problems[0] ?? "");
  } finally {
    for (const s of [services.watcher, services.oracle, services.registry]) await s?.stop();
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
  let base = `${stamp.slice(0, 10)}-phase4`;
  for (let n = 2; existsSync(resolve("logs", `${base}.txt`)); n++) base = `${stamp.slice(0, 10)}-phase4-${n}`;
  log(`npm run demo:phase4 — XRP Ledger testnet, ${stamp}`);
  const client = await connectTestnet();
  const txFile = resolve("logs", `${base}-txs.json`);
  try {
    log(`Connected to ${client.url} (testnet, network_id 1). Loading or funding wallets from the faucet...`);
    const wallets = await loadOrFundWallets(client);
    ensureLocalSecrets();
    const anchorWallet = await loadOrFundAnchor(client);
    for (const [role, w] of [...Object.entries(wallets), ["anchor", anchorWallet] as const]) {
      log(`  ${role.padEnd(8)} ${w.address}  ${(await xrpBalance(client, w.address)).toFixed(6)} XRP`);
    }
    const checks = await runPhase4(client, wallets, anchorWallet, { log });
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
