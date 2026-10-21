// Runs the four Phase 2 scenarios through the HTTP services against the live
// XRP Ledger testnet. Needs the testnet servers and faucet; takes a few minutes.
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Client } from "xrpl";
import { connectTestnet } from "../src/config.js";
import { runPhase2 } from "../src/demo-phase2.js";
import { ensureLocalSecrets } from "../src/local-config.js";
import { loadOrFundWallets } from "../src/wallets.js";
import { tempDir } from "./helpers.js";

let client: Client;

beforeAll(async () => {
  client = await connectTestnet();
}, 60_000);

afterAll(async () => {
  await client?.disconnect();
});

it("all Phase 2 scenarios pass through the local services on testnet", async () => {
  const wallets = await loadOrFundWallets(client);
  ensureLocalSecrets();
  const dir = tempDir();
  // Separate ports and files so the test never touches a registry you started by hand.
  const checks = await runPhase2(client, wallets, {
    registryPort: 18801, oraclePort: 18802, dataDir: dir, verdictLog: join(dir, "verdicts.jsonl"), log: () => {},
  });
  const failed = checks.filter((c) => !c.ok).map((c) => `${c.scenario}: ${c.label} ${c.detail}`);
  expect(failed).toEqual([]);
  expect(checks.length).toBeGreaterThan(45);
}, 600_000);
