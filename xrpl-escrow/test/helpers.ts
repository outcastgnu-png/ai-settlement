// Local registry + oracle on free ports with throwaway files, for tests that need no ledger.
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "xrpl";
import { callJson } from "../src/http.js";
import { startOracle } from "../src/oracle/server.js";
import { SecretVault } from "../src/oracle/vault.js";
import { startRegistry } from "../src/registry/server.js";
import type { Job } from "../src/registry/db.js";

export const tempDir = () => mkdtempSync(join(tmpdir(), "escrow-test-"));

export async function startLocal() {
  const dir = tempDir();
  const registry = await startRegistry({ dbPath: join(dir, "jobs.db"), port: 0 });
  const oracleWallet = Wallet.generate();
  const vaultKey = randomBytes(32);
  const vaultFile = join(dir, "vault.json");
  const verdictLog = join(dir, "verdicts.jsonl");
  const launchOracle = () => startOracle({
    port: 0, wallet: oracleWallet, vault: new SecretVault(vaultFile, vaultKey), registryUrl: registry.url, verdictLog,
  });
  let oracle = await launchOracle();
  return {
    dir, registry, oracleWallet, vaultFile, vaultKey, verdictLog,
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
  });
