// Runs every scenario against the live XRP Ledger testnet. Needs internet
// access to the testnet servers and faucet; takes a few minutes.
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Client } from "xrpl";
import { connectTestnet } from "../src/config.js";
import { runScenarios } from "../src/demo.js";
import { loadOrFundWallets } from "../src/wallets.js";

let client: Client;

beforeAll(async () => {
  client = await connectTestnet();
}, 60_000);

afterAll(async () => {
  await client?.disconnect();
});

it("all escrow scenarios behave as expected on testnet", async () => {
  const wallets = await loadOrFundWallets(client);
  const checks = await runScenarios(client, wallets, { log: () => {} });
  const failed = checks.filter((c) => !c.ok).map((c) => `${c.scenario}: ${c.label} ${c.detail}`);
  expect(failed).toEqual([]);
  expect(checks.length).toBeGreaterThan(10);
}, 600_000);
