// Local registry + oracle on free ports with throwaway files, for tests that need no ledger.
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet, type ECDSA } from "xrpl";
import { ReplayGuard } from "../src/auth.js";
import { callJson } from "../src/http.js";
import { startOracle, type EscrowCheck } from "../src/oracle/server.js";
import { SecretVault } from "../src/oracle/vault.js";
import { startRegistry } from "../src/registry/server.js";
import type { Job } from "../src/registry/db.js";
import type { TxLookupResult } from "../src/oracle/checks/xrpl-tx.js";
import type { Anchorer } from "../src/oracle/verdict-store.js";
import type { Anchor, LogHead } from "../src/verdict-log.js";

export const tempDir = () => mkdtempSync(join(tmpdir(), "escrow-test-"));

export const TOKENS = { oracle: randomBytes(32).toString("hex"), watcher: randomBytes(32).toString("hex") };

export async function startLocal() {
  const dir = tempDir();
  const registry = await startRegistry({ dbPath: join(dir, "jobs.db"), port: 0, tokens: TOKENS });
  const verdictKey = Wallet.generate("ed25519" as ECDSA);
  const vaultKey = randomBytes(32);
  const vaultFile = join(dir, "vault.json");
  const verdictLog = join(dir, "verdicts.jsonl");
  const replayFile = join(dir, "replay.json");
  const verdictChain = join(dir, "verdict-log.jsonl");
  const anchorFile = join(dir, "anchors.jsonl");
  // Stands in for the anchor transactions: records each head it was asked to anchor.
  const anchorWallet = Wallet.generate();
  const anchored: LogHead[] = [];
  // What the stand-in ledger holds, newest first; tests can add conflicting anchors to it.
  const onLedger: Anchor[] = [];
  const anchorer: Anchorer = async (head) => {
    anchored.push(head);
    const anchor = { ...fakeAnchor(head, verdictKey.address), account: anchorWallet.address };
    onLedger.unshift(anchor);
    return anchor;
  };
  // Stands in for testnet transaction lookups: tests put results here by hash.
  const txs = new Map<string, TxLookupResult | Error>();
  const lookupTx = async (hash: string): Promise<TxLookupResult> => {
    const r = txs.get(hash) ?? { found: false };
    if (r instanceof Error) throw r;
    return r;
  };
  // Stands in for the ledger: by default every escrow "exists"; tests can make it fail.
  const ledger = { problem: null as string | null, checked: [] as string[] };
  const escrowCheck: EscrowCheck = async (job) => {
    ledger.checked.push(job.id);
    return ledger.problem;
  };
  const launchOracle = () => startOracle({
    port: 0, verdictKey, vault: new SecretVault(vaultFile, vaultKey), registryUrl: registry.url, verdictLog,
    serviceToken: TOKENS.oracle, escrowCheck, replay: new ReplayGuard(replayFile),
    verdictChain, anchorFile, anchorer, anchorAddress: anchorWallet.address, anchorIntervalMs: 0, lookupTx,
    anchorHistory: async () => [...onLedger],
  });
  let oracle = await launchOracle();
  return {
    dir, registry, verdictKey, vaultFile, vaultKey, verdictLog, verdictChain, anchorFile, anchored, onLedger, txs, ledger, launchOracle,
    get oracle() {
      return oracle;
    },
    async restartOracle() {
      await oracle.close();
      oracle = await launchOracle();
      return oracle;
    },
    async close() {
      await oracle.close();
      await registry.close();
    },
  };
}

/** Pretend the watcher saw a validated EscrowCreate. */
export const markFunded = (registryUrl: string, jobId: string, offerSequence = 7) =>
  callJson<Job>("POST", `${registryUrl}/jobs/${jobId}/events`, {
    source: "ledger", status: "funded", offerSequence, cancelAfter: 900_000_000, txHash: "AB".repeat(32),
  }, TOKENS.watcher);

let fakeLedgerIndex = 1_000;
/** An anchor as the ledger would hold it, with a made-up transaction hash. */
export const fakeAnchor = (head: LogHead, oracle: string): Anchor => ({
  v: 1, seq: head.seq, hash: head.hash, oracle, txHash: randomBytes(32).toString("hex").toUpperCase(),
  ledgerIndex: fakeLedgerIndex++, account: "",
});

/**
 * A copy of .env with a fresh verdict key and a fresh faucet-funded anchor wallet,
 * for testnet tests that start a new verdict log in a temp folder. One anchor
 * account anchors one log, so a new log needs its own (Gpno N29).
 */
export async function throwawayOracleEnv(xrpl: import("xrpl").Client, base = ".env"): Promise<{ envFile: string; anchor: Wallet }> {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { loadOrFundAnchor } = await import("../src/wallets.js");
  const keep = readFileSync(base, "utf8").split("\n").filter((l) => !/^ORACLE_(VERDICT|ANCHOR)_(SEED|ADDRESS)=/.test(l));
  const verdictKey = Wallet.generate("ed25519" as ECDSA);
  const envFile = join(tempDir(), ".env");
  writeFileSync(envFile, `${[...keep.filter((l) => l !== ""), `ORACLE_VERDICT_SEED=${verdictKey.seed}`, `ORACLE_VERDICT_ADDRESS=${verdictKey.address}`].join("\n")}\n`, { mode: 0o600 });
  const anchor = await loadOrFundAnchor(xrpl, envFile);
  return { envFile, anchor };
}
