import { EventEmitter } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Wallet, type Client } from "xrpl";
import { callJson } from "../src/http.js";
import type { Job } from "../src/registry/db.js";
import { startRegistry } from "../src/registry/server.js";
import { LedgerWatcher, eventForTx, eventsForLedger, toLedgerTx } from "../src/watcher.js";
import { tempDir } from "./helpers.js";
import { join } from "node:path";

const CLIENT = Wallet.generate().address;
const PROVIDER = Wallet.generate().address;
const COND = "A0258020" + "11".repeat(32) + "810120";

const job = (over: Partial<Job> = {}): Job => ({
  id: "j1", client: CLIENT, provider: PROVIDER, priceDrops: "10000000", slaSeconds: 120, spec: { checks: [] },
  condition: COND, offerSequence: null, cancelAfter: null, status: "draft", verdict: null, expiringSoon: false,
  createTx: null, finishTx: null, cancelTx: null, createdAt: 0, fundedAt: null, deliveredAt: null, verifiedAt: null,
  closedAt: null, updatedAt: 0, ...over,
});

const createMsg = (over: Record<string, unknown> = {}, result = "tesSUCCESS", validated = true) => ({
  type: "transaction", validated, hash: "H_CREATE", meta: { TransactionResult: result },
  tx_json: { TransactionType: "EscrowCreate", Account: CLIENT, Destination: PROVIDER, Amount: "10000000",
    Condition: COND, CancelAfter: 800_000_120, Sequence: 55, ...over },
});
const closeMsg = (type: "EscrowFinish" | "EscrowCancel", seq = 55) => ({
  type: "transaction", validated: true, hash: `H_${type}`, meta: { TransactionResult: "tesSUCCESS" },
  tx_json: { TransactionType: type, Account: PROVIDER, Owner: CLIENT, OfferSequence: seq },
});

describe("watcher event mapping", () => {
  it("normalises API v1, API v2 and account_tx shapes", () => {
    expect(toLedgerTx(createMsg())).toMatchObject({ hash: "H_CREATE", validated: true, result: "tesSUCCESS" });
    const v1 = { validated: true, meta: { TransactionResult: "tesSUCCESS" }, transaction: { hash: "H1", TransactionType: "Payment" } };
    expect(toLedgerTx(v1)?.hash).toBe("H1");
    expect(toLedgerTx({ validated: true, meta: "BLOB", tx_json: {}, hash: "x" })).toBeNull();
  });

  it("maps a matching validated EscrowCreate to funded", () => {
    const e = eventForTx(toLedgerTx(createMsg())!, [job()]);
    expect(e).toEqual({ jobId: "j1", body: expect.objectContaining({ source: "ledger", status: "funded", offerSequence: 55, cancelAfter: 800_000_120, txHash: "H_CREATE" }) });
  });

  it("ignores unvalidated, failed, or non-matching creates", () => {
    expect(eventForTx(toLedgerTx(createMsg({}, "tesSUCCESS", false))!, [job()])).toBeNull();
    expect(eventForTx(toLedgerTx(createMsg({}, "tecUNFUNDED"))!, [job()])).toBeNull();
    expect(eventForTx(toLedgerTx(createMsg({ Amount: "1" }))!, [job()])).toBeNull();
    expect(eventForTx(toLedgerTx(createMsg({ Condition: "A0258020" + "22".repeat(32) + "810120" }))!, [job()])).toBeNull();
    expect(eventForTx(toLedgerTx(createMsg({ Destination: CLIENT }))!, [job()])).toBeNull();
  });

  it("maps EscrowFinish to paid and EscrowCancel to refunded by owner and sequence", () => {
    const funded = job({ status: "funded", offerSequence: 55 });
    expect(eventForTx(toLedgerTx(closeMsg("EscrowFinish"))!, [funded])?.body).toMatchObject({ status: "paid", txHash: "H_EscrowFinish" });
    expect(eventForTx(toLedgerTx(closeMsg("EscrowCancel"))!, [funded])?.body).toMatchObject({ status: "refunded" });
    expect(eventForTx(toLedgerTx(closeMsg("EscrowFinish", 56))!, [funded])).toBeNull();
  });

  it("flags escrows nearing CancelAfter and expires unclaimed passes", () => {
    const open = job({ status: "delivered", cancelAfter: 1_000 });
    expect(eventsForLedger(960, [open])).toEqual([]);
    expect(eventsForLedger(975, [open])[0].body).toMatchObject({ expiringSoon: true });
    expect(eventsForLedger(975, [{ ...open, expiringSoon: true }])).toEqual([]);
    expect(eventsForLedger(1_001, [job({ status: "verified_pass", cancelAfter: 1_000 })])[0].body).toMatchObject({ status: "expired_unclaimed" });
    expect(eventsForLedger(1_001, [open])).toEqual([]); // a failed or undelivered job waits for its refund
    expect(eventsForLedger(1_001, [job({ status: "paid", cancelAfter: 1_000 })])).toEqual([]);
  });
});

/** Just enough of xrpl.Client for the watcher: subscribe, account_tx, and stream events. */
class FakeLedger extends EventEmitter {
  subscribed: string[] = [];
  history: Record<string, unknown[]> = {};
  async request(req: { command: string; accounts?: string[]; account?: string }) {
    if (req.command === "subscribe") this.subscribed.push(...(req.accounts ?? []));
    if (req.command === "account_tx") return { result: { transactions: this.history[req.account!] ?? [] } };
    return { result: {} };
  }
}

describe("LedgerWatcher against a registry", () => {
  let registry: Awaited<ReturnType<typeof startRegistry>>;
  beforeAll(async () => {
    registry = await startRegistry({ dbPath: join(tempDir(), "jobs.db"), port: 0 });
  });
  afterAll(() => registry.close());

  it("subscribes to job accounts, backfills, and follows the job to paid", async () => {
    const reg = registry.url;
    const created = await callJson<Job>("POST", `${reg}/jobs`, {
      client: CLIENT, provider: PROVIDER, priceDrops: "10000000", slaSeconds: 120,
      spec: { checks: [{ type: "max-latency", maxMs: 1000 }] },
    });
    await callJson("PUT", `${reg}/jobs/${created.id}/condition`, { condition: COND });
    const ledger = new FakeLedger();
    ledger.history[CLIENT] = [createMsg()]; // the create happened before the watcher was listening
    const watcher = new LedgerWatcher(ledger as unknown as Client, { registryUrl: reg, pollMs: 50, log: () => {} });
    await watcher.start();
    await watcher.idle();
    watcher.stop();
    expect(ledger.subscribed).toEqual(expect.arrayContaining([CLIENT, PROVIDER]));
    expect(await callJson<Job>("GET", `${reg}/jobs/${created.id}`)).toMatchObject({ status: "funded", offerSequence: 55, createTx: "H_CREATE" });

    ledger.emit("ledgerClosed", { ledger_time: 800_000_100 });
    await watcher.idle();
    expect((await callJson<Job>("GET", `${reg}/jobs/${created.id}`)).expiringSoon).toBe(true);

    ledger.emit("transaction", closeMsg("EscrowCancel"));
    await watcher.idle();
    expect(await callJson<Job>("GET", `${reg}/jobs/${created.id}`)).toMatchObject({ status: "refunded", cancelTx: "H_EscrowCancel" });

    ledger.emit("transaction", closeMsg("EscrowCancel")); // duplicate delivery is harmless
    await watcher.idle();
    expect((await callJson<Job>("GET", `${reg}/jobs/${created.id}`)).status).toBe("refunded");
  });
});
