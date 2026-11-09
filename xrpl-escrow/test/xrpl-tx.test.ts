// The xrpl-tx-validated check (EDR-014) against a stand-in ledger: every way a
// transaction can fail to count, the strict hash rule, and the oracle's 503
// when the lookup itself fails. test/xrpl-tx-flow.test.ts runs it on testnet.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Wallet } from "xrpl";
import { sha256Hex, signRequest } from "../src/auth.js";
import { RIPPLE_EPOCH_OFFSET } from "../src/config.js";
import { HttpError, callJson } from "../src/http.js";
import { CheckUnavailable } from "../src/oracle/checks/json-schema.js";
import { xrplTxValidated, type TxCheckSpec, type TxLookupResult } from "../src/oracle/checks/xrpl-tx.js";
import type { SignedVerdict } from "../src/oracle/server.js";
import type { Job } from "../src/registry/db.js";
import { parseNewJob } from "../src/registry/server.js";
import { markFunded, startLocal } from "./helpers.js";

const dest = Wallet.generate().address;
const sender = Wallet.generate().address;
const HASH = "AB".repeat(32);
const createdAt = 1_761_000_000_000;
const rippleSecs = (unixMs: number) => Math.floor(unixMs / 1000) - RIPPLE_EPOCH_OFFSET;
const hexText = (t: string) => Buffer.from(t, "utf8").toString("hex").toUpperCase();

const spec = (over: Partial<TxCheckSpec> = {}): TxCheckSpec =>
  ({ type: "xrpl-tx-validated", txType: "Payment", destination: dest, minDrops: "1000000", ...over });

const payment = (over: { tx?: Record<string, unknown>; meta?: Record<string, unknown>; validated?: boolean; closeTime?: number | null } = {}): TxLookupResult => ({
  found: true, validated: over.validated ?? true,
  tx: { TransactionType: "Payment", Account: sender, Destination: dest, Amount: "1000000", DestinationTag: 42,
    Memos: [{ Memo: { MemoData: hexText("order 7") } }], ...over.tx },
  meta: { TransactionResult: "tesSUCCESS", delivered_amount: "1000000", ...over.meta },
  closeTime: over.closeTime === undefined ? rippleSecs(createdAt + 60_000) : over.closeTime,
});

const run = (s: TxCheckSpec, result: TxLookupResult | Error, content = HASH) => xrplTxValidated(s, {
  job: { createdAt } as Job, content, deliveredAt: createdAt + 90_000,
  lookupTx: async (h) => {
    expect(h).toBe(content.toUpperCase());
    if (result instanceof Error) throw result;
    return result;
  },
});

describe("xrpl-tx-validated check", () => {
  it("passes on a validated, successful payment with every field matching", async () => {
    expect(await run(spec({ account: sender, destinationTag: 42, memo: "order 7" }), payment())).toMatchObject({ pass: true });
    expect((await run(spec(), payment(), HASH.toLowerCase())).pass).toBe(true);
  });

  it("parses the deliverable strictly as a 64-hex-character hash and reads nothing else", async () => {
    for (const bad of [`${HASH}\n`, ` ${HASH}`, HASH.slice(1), `${HASH}00`, `0x${HASH.slice(2)}`, "ZZ".repeat(32), "", `{"hash":"${HASH}"}`]) {
      const result = await xrplTxValidated(spec(), {
        job: { createdAt } as Job, content: bad, deliveredAt: 0,
        lookupTx: async () => { throw new Error("must not be called"); },
      });
      expect(result, JSON.stringify(bad)).toMatchObject({ pass: false, detail: expect.stringContaining("not a transaction hash") });
    }
  });

  it("fails when the transaction is missing, unvalidated, or failed (tec*)", async () => {
    expect(await run(spec(), { found: false })).toMatchObject({ pass: false, detail: expect.stringContaining("not found") });
    expect(await run(spec(), payment({ validated: false }))).toMatchObject({ pass: false, detail: expect.stringContaining("not in a validated ledger") });
    expect(await run(spec(), payment({ meta: { TransactionResult: "tecNO_DST_INSUF_XRP" } }))).toMatchObject({
      pass: false, detail: expect.stringContaining("tecNO_DST_INSUF_XRP"),
    });
  });

  it("fails when type, destination, sender, tag or memo differ", async () => {
    expect((await run(spec({ txType: "EscrowCreate" }), payment())).detail).toMatch(/not a EscrowCreate/);
    expect((await run(spec({ destination: sender }), payment())).detail).toMatch(/destination/);
    expect((await run(spec({ account: dest }), payment())).detail).toMatch(/not sent by/);
    expect((await run(spec({ destinationTag: 43 }), payment())).detail).toMatch(/destination tag/);
    expect((await run(spec({ memo: "order 8" }), payment())).detail).toMatch(/no memo/);
    expect((await run(spec({ memo: "order 7" }), payment({ tx: { Memos: undefined } }))).pass).toBe(false);
  });

  it("counts what a payment delivered, not its Amount field (partial payments)", async () => {
    const partial = payment({ tx: { Amount: "5000000", Flags: 0x00020000 }, meta: { delivered_amount: "1" } });
    expect((await run(spec({ minDrops: "5000000" }), partial)).detail).toMatch(/moved 1 drops, less than/);
    expect((await run(spec(), payment({ meta: { delivered_amount: { currency: "USD", issuer: sender, value: "5" } } }))).detail).toMatch(/did not move XRP/);
    expect((await run(spec({ minDrops: "1000001" }), payment())).pass).toBe(false);
  });

  it("uses the Amount of an EscrowCreate", async () => {
    const escrow = payment({ tx: { TransactionType: "EscrowCreate", Amount: "2000000" }, meta: { delivered_amount: undefined } });
    expect((await run(spec({ txType: "EscrowCreate", minDrops: "2000000" }), escrow)).pass).toBe(true);
  });

  it("fails on a transaction validated before the job was created", async () => {
    expect((await run(spec(), payment({ closeTime: rippleSecs(createdAt - 60_000) }))).detail).toMatch(/before the job was created/);
    expect((await run(spec(), payment({ closeTime: rippleSecs(createdAt - 5_000) }))).pass).toBe(true); // within close-time rounding
    expect((await run(spec(), payment({ closeTime: null }))).pass).toBe(false);
  });

  it("throws CheckUnavailable when the lookup fails or times out, so no verdict is signed", async () => {
    await expect(run(spec(), new Error("socket hang up"))).rejects.toBeInstanceOf(CheckUnavailable);
    const slow = xrplTxValidated(spec(), {
      job: { createdAt } as Job, content: HASH, deliveredAt: 0, lookupTx: () => new Promise(() => {}),
    }, 50);
    await expect(slow).rejects.toThrow(/longer than 50 ms/);
    await expect(xrplTxValidated(spec(), { job: { createdAt } as Job, content: HASH, deliveredAt: 0 })).rejects.toBeInstanceOf(CheckUnavailable);
  });
});

describe("registry rules for xrpl-tx-validated", () => {
  const job = (checks: unknown[]) => ({
    client: sender, provider: Wallet.generate().address, priceDrops: "1000000", slaSeconds: 60, spec: { checks },
  });
  it("accepts a well-formed spec", () => {
    expect(parseNewJob(job([spec({ account: sender, destinationTag: 0, memo: "x" })])).spec.checks).toHaveLength(1);
  });
  it("refuses malformed specs and more than two transaction checks per job", () => {
    for (const bad of [
      spec({ txType: "AccountSet" as never }), spec({ destination: "rNotAnAddress" }), spec({ minDrops: "0" }),
      spec({ minDrops: "1.5" }), spec({ minDrops: 5 as never }), spec({ account: "x" }), spec({ destinationTag: -1 }),
      spec({ destinationTag: 2 ** 32 }), spec({ memo: "" }), spec({ memo: "m".repeat(257) }),
      { ...spec(), extra: true },
    ]) {
      expect(() => parseNewJob(job([bad])), JSON.stringify(bad)).toThrow(HttpError);
    }
    expect(() => parseNewJob(job([spec(), spec(), spec()]))).toThrow(/at most 2 xrpl-tx-validated/);
  });
});

describe("oracle with xrpl-tx-validated", () => {
  let local: Awaited<ReturnType<typeof startLocal>>;
  const provider = Wallet.generate();
  const client = Wallet.generate();
  beforeAll(async () => {
    local = await startLocal();
  });
  afterAll(() => local.close());

  async function deliveredTxJob(content: string) {
    const job = await callJson<Job>("POST", `${local.registry.url}/jobs`, {
      client: client.address, provider: provider.address, priceDrops: "1000000", slaSeconds: 60, spec: { checks: [spec()] },
    });
    await callJson("POST", `${local.oracle.url}/jobs/${job.id}/condition`);
    await markFunded(local.registry.url, job.id);
    await callJson("POST", `${local.registry.url}/jobs/${job.id}/deliverable`, {
      content, auth: signRequest(provider, "deliver", job.id, sha256Hex(content)),
    });
    return job;
  }
  const verify = (id: string) =>
    callJson<{ verdict: SignedVerdict; fulfillment?: string }>("POST", `${local.oracle.url}/verify/${id}`, { auth: signRequest(provider, "verify", id) });

  it("passes and releases the fulfillment when the ledger has the transaction", async () => {
    const hash = "CD".repeat(32);
    const job = await deliveredTxJob(hash);
    local.txs.set(hash, payment({ closeTime: rippleSecs(job.createdAt + 5_000) }));
    const res = await verify(job.id);
    expect(res.verdict.verdict).toBe("pass");
    expect(res.fulfillment).toBeDefined();
  });

  it("answers 503 with no verdict when the ledger lookup fails, then verifies on a retry", async () => {
    const hash = "EF".repeat(32);
    const job = await deliveredTxJob(hash);
    const countBefore = local.oracle.store.count;
    local.txs.set(hash, new Error("connection lost"));
    expect(await verify(job.id).then(() => 200, (e: HttpError) => e.status)).toBe(503);
    expect(local.oracle.store.count).toBe(countBefore);
    expect((await callJson<Job>("GET", `${local.registry.url}/jobs/${job.id}`)).status).toBe("delivered");
    local.txs.set(hash, { found: false });
    const res = await verify(job.id);
    expect(res.verdict).toMatchObject({ verdict: "fail", checks: [{ detail: expect.stringContaining("not found") }] });
    expect(local.oracle.store.count).toBe(countBefore + 1);
  });
});
