// Phase 3 testnet flows that were only run by hand before (Windows check,
// 2026-10-21): a passed job nobody claims goes expired_unclaimed and is then
// refunded, and the watcher keeps driving job status after its WebSocket drops.
// Registry, oracle and watcher run in-process on free ports with throwaway
// files; the oracle checks escrows on the real ledger. Needs the testnet
// servers and faucet; takes a few minutes.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Wallet, type Client, type ECDSA } from "xrpl";
import { ReplayGuard, sha256Hex } from "../src/auth.js";
import { connectTestnet } from "../src/config.js";
import { sleep } from "../src/escrow.js";
import { ledgerEscrowCheck, startOracle } from "../src/oracle/server.js";
import { SecretVault } from "../src/oracle/vault.js";
import { startRegistry } from "../src/registry/server.js";
import { EscrowKit } from "../src/sdk/index.js";
import { LedgerWatcher } from "../src/watcher.js";
import { loadOrFundWallets, type Wallets } from "../src/wallets.js";
import { TOKENS, tempDir } from "./helpers.js";

let xrpl: Client; // the parties' and the oracle's connection
let watcherClient: Client; // the watcher's own connection, so it can be cut alone
let wallets: Wallets;
let kit: EscrowKit;
let watcher: LedgerWatcher;
const watcherLog: string[] = [];
let close: () => Promise<void>;

beforeAll(async () => {
  xrpl = await connectTestnet();
  watcherClient = await connectTestnet();
  wallets = await loadOrFundWallets(xrpl);
  const dir = tempDir();
  const registry = await startRegistry({ dbPath: join(dir, "jobs.db"), port: 0, tokens: TOKENS });
  const verdictKey = Wallet.generate("ed25519" as ECDSA);
  const oracle = await startOracle({
    port: 0, verdictKey, vault: new SecretVault(join(dir, "vault.json"), randomBytes(32)), registryUrl: registry.url,
    verdictLog: join(dir, "verdicts.jsonl"), serviceToken: TOKENS.oracle, escrowCheck: ledgerEscrowCheck(xrpl),
    replay: new ReplayGuard(join(dir, "replay.json")),
  });
  watcher = new LedgerWatcher(watcherClient, { serviceToken: TOKENS.watcher, registryUrl: registry.url, log: (l) => watcherLog.push(l) });
  await watcher.start();
  kit = new EscrowKit({ xrpl, registryUrl: registry.url, oracleUrl: oracle.url, oracleAddress: verdictKey.address, statusTimeoutMs: 120_000 });
  close = async () => {
    watcher.stop();
    await oracle.close();
    await registry.close();
  };
}, 120_000);

afterAll(async () => {
  await close?.();
  await watcherClient?.disconnect();
  await xrpl?.disconnect();
});

const jobFor = (work: string, slaSeconds: number) => kit.createJob({
  client: wallets.client.address, provider: wallets.provider.address, priceDrops: "10000000", slaSeconds,
  spec: { checks: [{ type: "sha256-match", sha256: sha256Hex(work) }] },
});

it("a passed job nobody claims goes expired_unclaimed, is refunded, and still counts in reputation", async () => {
  const before = await kit.reputation(wallets.provider.address);
  const work = `unclaimed deliverable ${new Date().toISOString()}`;
  const job = await jobFor(work, 60);
  const funded = await kit.fundJob(job.id, wallets.client);
  expect(funded.tx.code).toBe("tesSUCCESS");
  expect(funded.job.status).toBe("funded");
  const delivered = await kit.deliver(job.id, wallets.provider, work);
  expect(delivered.job.status).toBe("verified_pass");
  expect(delivered.fulfillment).not.toBeNull(); // deliberately never used

  const expired = await kit.waitForStatus(job.id, ["expired_unclaimed"], 180_000);
  expect(expired.expiringSoon).toBe(true);
  const refund = await kit.refund(job.id, wallets.client);
  expect(refund.tx.code).toBe("tesSUCCESS");
  expect(refund.job.status).toBe("refunded");

  const statuses = (await kit.events(job.id)).map((e) => e.status).filter((s) => s !== null);
  expect(statuses).toEqual(["draft", "funded", "delivered", "verified_pass", "expired_unclaimed", "refunded"]);
  const after = await kit.reputation(wallets.provider.address);
  expect(after.expiredUnclaimed - before.expiredUnclaimed).toBe(1);
  expect(after.refunded - before.refunded).toBe(1);
}, 400_000);

it("the watcher resubscribes after its WebSocket drops and still marks the job funded and paid", async () => {
  const work = `reconnect deliverable ${new Date().toISOString()}`;
  const job = await jobFor(work, 300);
  const subscribed = () => watcherLog.filter((l) => l.startsWith("subscribed to")).length;
  for (let i = 0; i < 40 && !watcherLog.some((l) => l.startsWith("subscribed to") && l.includes(wallets.client.address)); i++) await sleep(250);
  const subsBeforeDrop = subscribed();

  const events: string[] = [];
  watcherClient.on("disconnected", (code: number) => events.push(`disconnected ${code}`));
  watcherClient.on("connected", () => events.push("connected"));
  // Abrupt drop with no close handshake (close 1006), like a network cut; xrpl.js reconnects on its own.
  (watcherClient as unknown as { connection: { ws: { terminate(): void } } }).connection.ws.terminate();
  for (let i = 0; i < 160 && !events.includes("connected"); i++) await sleep(250);
  expect(events[0]).toMatch(/^disconnected/);
  expect(events).toContain("connected");
  for (let i = 0; i < 40 && subscribed() === subsBeforeDrop; i++) await sleep(250);
  expect(subscribed()).toBeGreaterThan(subsBeforeDrop);

  const funded = await kit.fundJob(job.id, wallets.client);
  expect(funded.tx.code).toBe("tesSUCCESS");
  expect(funded.job.status).toBe("funded");
  const delivered = await kit.deliver(job.id, wallets.provider, work);
  const subsBeforeClaim = subscribed();
  const claim = await kit.claim(job.id, wallets.provider, delivered.fulfillment!);
  expect(claim.tx.code).toBe("tesSUCCESS");
  expect(claim.job.status).toBe("paid");
  expect(subscribed()).toBe(subsBeforeClaim); // paid came from the live stream, not a re-subscribe backfill
}, 300_000);
