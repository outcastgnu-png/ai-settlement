// Runs the Phase 5 scenarios (EDR-015) through the local services and three
// local oracles against the live XRP Ledger testnet: 2 of 3 pass and finish,
// 1 of 3 and refund, 3 of 3, one oracle stopped, and every oracle's log
// checked against its own anchors. Takes a few minutes.
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Client } from "xrpl";
import { connectTestnet } from "../src/config.js";
import { runPhase5 } from "../src/demo-phase5.js";
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

it("all Phase 5 scenarios pass with three local oracles on testnet", async () => {
  const wallets = await loadOrFundWallets(client);
  ensureLocalSecrets();
  // Separate ports, a fresh data folder, and fresh keys and anchor wallets for all three new logs,
  // so the test never touches services you started by hand or the logs your anchor accounts anchor.
  const { envFile } = await throwawayOracleEnv(client);
  await setupOtherOracles(client, envFile);
  const checks = await runPhase5(client, wallets, { registryPort: 18821, oraclePort: 18822, dataDir: tempDir(), envFile, log: () => {} });
  const failed = checks.filter((c) => !c.ok).map((c) => `${c.scenario}: ${c.label} ${c.detail}`);
  expect(failed).toEqual([]);
  expect(checks.length).toBe(39);
}, 900_000);
