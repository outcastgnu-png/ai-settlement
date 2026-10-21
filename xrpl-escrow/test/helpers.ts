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
  // Stands in for the ledger: by default every escrow "exists"; tests can make it fail.
  const ledger = { problem: null as string | null, checked: [] as string[] };
  const escrowCheck: EscrowCheck = async (job) => {
    ledger.checked.push(job.id);
    return ledger.problem;
  };
  const launchOracle = () => startOracle({
    port: 0, verdictKey, vault: new SecretVault(vaultFile, vaultKey), registryUrl: registry.url, verdictLog,
    serviceToken: TOKENS.oracle, escrowCheck, replay: new ReplayGuard(replayFile),
  });
  let oracle = await launchOracle();
  return {
    dir, registry, verdictKey, vaultFile, vaultKey, verdictLog, ledger,
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
