// Runs the Phase 6 scenarios (EDR-016) through the local services and three
// local oracles against the live XRP Ledger testnet: signed specs locked in the
// EscrowCreate memo, a lock refused without the provider's signature, a spec
// changed after the lock refused by the oracle and refunded, a subjective
// criterion with no check refused, an "at least 2 of 3" job, and a shared job
// where one oracle is given a different spec. Takes a few minutes.
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Client } from "xrpl";
import { connectTestnet } from "../src/config.js";
import { runPhase6 } from "../src/demo-phase6.js";
import { ensureLocalSecrets } from "../src/local-config.js";
import { loadOrFundWallets, setupOtherOracles } from "../src/wallets.js";
import { tempDir, throwawayOracleEnv } from "./helpers.js";

let client: Client;

beforeAll(async () => {
  client = await connectTestnet();
}, 60_000);

afterAll(async () => {
  await client?.disconnect();
});

it("all Phase 6 scenarios pass with three local oracles on testnet", async () => {
  const wallets = await loadOrFundWallets(client);
  ensureLocalSecrets();
  // Separate ports, a fresh data folder, and fresh keys and anchor wallets for all three new logs (Gpno N29).
  const { envFile } = await throwawayOracleEnv(client);
  await setupOtherOracles(client, envFile);
  const checks = await runPhase6(client, wallets, { registryPort: 18831, oraclePort: 18832, dataDir: tempDir(), envFile, log: () => {} });
  const failed = checks.filter((c) => !c.ok).map((c) => `${c.scenario}: ${c.label} ${c.detail}`);
  expect(failed).toEqual([]);
  expect(checks.length).toBe(43);
}, 900_000);
