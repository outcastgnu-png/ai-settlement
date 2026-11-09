// Runs the Phase 4 scenarios (EDR-014) through the local services against the
// live XRP Ledger testnet: the xrpl-tx-validated check passing, failing on a
// tec* transaction, an unvalidated one and a malformed hash, and the verdict
// log anchored on the ledger and checked by the SDK. Takes a few minutes.
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Client } from "xrpl";
import { connectTestnet } from "../src/config.js";
import { runPhase4 } from "../src/demo-phase4.js";
import { ensureLocalSecrets } from "../src/local-config.js";
import { loadOrFundWallets } from "../src/wallets.js";
import { tempDir, throwawayOracleEnv } from "./helpers.js";

let client: Client;

beforeAll(async () => {
  client = await connectTestnet();
}, 60_000);

afterAll(async () => {
  await client?.disconnect();
});

it("all Phase 4 scenarios pass through the local services on testnet", async () => {
  const wallets = await loadOrFundWallets(client);
  ensureLocalSecrets();
  // Separate ports, a fresh data folder, and a fresh verdict key and anchor wallet for that new log,
  // so the test never touches services you started by hand or the log your anchor account anchors.
  const { envFile, anchor } = await throwawayOracleEnv(client);
  const checks = await runPhase4(client, wallets, anchor, { registryPort: 18811, oraclePort: 18812, dataDir: tempDir(), envFile, log: () => {} });
  const failed = checks.filter((c) => !c.ok).map((c) => `${c.scenario}: ${c.label} ${c.detail}`);
  expect(failed).toEqual([]);
  expect(checks.length).toBeGreaterThan(25);
}, 600_000);
