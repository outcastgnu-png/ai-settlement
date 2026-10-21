import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Wallet } from "xrpl";
import { sha256Hex, signRequest } from "../src/auth.js";
import { HttpError, callJson } from "../src/http.js";
import type { Job, JobEvent } from "../src/registry/db.js";
import { startRegistry } from "../src/registry/server.js";
import { TOKENS } from "./helpers.js";

const client = Wallet.generate();
const provider = Wallet.generate();
const CONDITION = "A0258020" + "66687AADF862BD776C8FC18B8E9F8E20089714856EE233B3902A591D0D5F2925" + "810120";
const spec = { checks: [{ type: "sha256-match", sha256: sha256Hex("work") }] };
const newJob = (extra: Record<string, unknown> = {}) => ({
  client: client.address, provider: provider.address, priceDrops: "10000000", slaSeconds: 120, spec, ...extra,
});

let registry: Awaited<ReturnType<typeof startRegistry>>;
let url: string;
const call = <T = Job>(method: string, path: string, body?: unknown, token?: string) => callJson<T>(method, `${url}${path}`, body, token);
const status = (p: Promise<unknown>) => p.then(() => 200, (e: HttpError) => e.status);
const event = (id: string, body: Record<string, unknown>) =>
  call("POST", `/jobs/${id}/events`, body, body.source === "oracle" ? TOKENS.oracle : TOKENS.watcher);
const setCondition = (id: string, condition: string, token = TOKENS.oracle) => call("PUT", `/jobs/${id}/condition`, { condition }, token);
const deliver = (id: string, wallet: Wallet, content: string) =>
  call("POST", `/jobs/${id}/deliverable`, { content, auth: signRequest(wallet, "deliver", id, sha256Hex(content)) });

beforeAll(async () => {
  registry = await startRegistry({ dbPath: join(mkdtempSync(join(tmpdir(), "registry-")), "jobs.db"), port: 0, tokens: TOKENS });
  url = registry.url;
});
afterAll(() => registry.close());

describe("job registry API", () => {
  it("binds to 127.0.0.1 only", () => {
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("creates, gets and lists draft jobs", async () => {
    const job = await call("POST", "/jobs", newJob());
    expect(job).toMatchObject({ status: "draft", condition: null, priceDrops: "10000000", client: client.address });
    expect(await call("GET", `/jobs/${job.id}`)).toEqual(job);
    const listed = await call<Job[]>("GET", `/jobs?provider=${provider.address}`);
    expect(listed.map((j) => j.id)).toContain(job.id);
    expect(await call<Job[]>("GET", "/jobs?status=paid")).toEqual([]);
  });

  it("rejects bad job input", async () => {
    expect(await status(call("POST", "/jobs", newJob({ client: "not-an-address" })))).toBe(400);
    expect(await status(call("POST", "/jobs", newJob({ provider: client.address })))).toBe(400);
    expect(await status(call("POST", "/jobs", newJob({ priceDrops: "1.5" })))).toBe(400);
    expect(await status(call("POST", "/jobs", newJob({ slaSeconds: 5 })))).toBe(400);
    expect(await status(call("POST", "/jobs", newJob({ spec: { checks: [] } })))).toBe(400);
    expect(await status(call("POST", "/jobs", newJob({ spec: { checks: [{ type: "run-code", code: "x" }] } })))).toBe(400);
    expect(await status(call("GET", "/jobs/nope"))).toBe(404);
  });

  it("never stores a secret, even if one is sent", async () => {
    expect(await status(call("POST", "/jobs", newJob({ secret: "00".repeat(32) })))).toBe(400);
    expect(await status(call("POST", "/jobs", newJob({ spec: { ...spec, Fulfillment: "A022" } })))).toBe(400);
    const columns = (registry.store.db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map((c) => c.name);
    expect(columns.some((c) => /secret|fulfillment|preimage/.test(c))).toBe(false);
  });

  it("accepts the condition once, only while draft", async () => {
    const job = await call("POST", "/jobs", newJob());
    expect(await status(setCondition(job.id, "abc"))).toBe(400);
    expect((await setCondition(job.id, CONDITION)).condition).toBe(CONDITION);
    expect(await status(setCondition(job.id, CONDITION))).toBe(200); // idempotent
    expect(await status(setCondition(job.id, CONDITION.replace("6668", "7778")))).toBe(409);
  });

  it("accepts internal writes only with the right service token", async () => {
    const job = await call("POST", "/jobs", newJob());
    expect(await status(setCondition(job.id, CONDITION, ""))).toBe(401);
    expect(await status(setCondition(job.id, CONDITION, TOKENS.watcher))).toBe(401);
    const funded = { source: "ledger", status: "funded", offerSequence: 1, cancelAfter: 800_000_000, txHash: "FAKE" };
    expect(await status(call("POST", `/jobs/${job.id}/events`, funded))).toBe(401);
    expect(await status(call("POST", `/jobs/${job.id}/events`, funded, TOKENS.oracle))).toBe(401);
    expect(await status(call("POST", `/jobs/${job.id}/events`, { source: "oracle", status: "verified_pass" }, TOKENS.watcher))).toBe(401);
    expect(await status(call("POST", `/jobs/${job.id}/events`, { source: "someone", status: "paid" }, TOKENS.watcher))).toBe(400);
    expect((await call("GET", `/jobs/${job.id}`)).status).toBe("draft");
    expect((await event(job.id, { ...funded, fundedAt: 1_700_000_000_000 })).fundedAt).toBe(1_700_000_000_000);
  });

  it("refuses job schemas that could make validation slow", async () => {
    const schemaJob = (schema: unknown) => call("POST", "/jobs", newJob({ spec: { checks: [{ type: "json-schema", schema }] } }));
    expect(await status(schemaJob({ type: "string", pattern: "^(a+)+$" }))).toBe(400);
    expect(await status(schemaJob({ type: "object", patternProperties: { "^x": {} } }))).toBe(400);
    expect(await status(schemaJob({ type: "array", uniqueItems: true }))).toBe(400);
    expect(await status(schemaJob({ type: "object", properties: { pattern: { type: "string" } } }))).toBe(200);
    expect(await status(schemaJob({ type: "object", description: "x".repeat(20_000) }))).toBe(400);
    const defs: Record<string, unknown> = { s0: { type: "string" } };
    for (let k = 1; k <= 22; k++) defs[`s${k}`] = { anyOf: [{ $ref: `#/$defs/s${k - 1}` }, { $ref: `#/$defs/s${k - 1}` }] };
    expect(await status(schemaJob({ $defs: defs, $ref: "#/$defs/s22" }))).toBe(400); // Gpno N1
    expect(await status(schemaJob({ $defs: { a: { items: { $ref: "#/$defs/a" } } }, $ref: "#/$defs/a" }))).toBe(400);
    expect(await status(schemaJob({ enum: [{ type: "string", pattern: "^(a+)+$" }], $ref: "#/enum/0" }))).toBe(400); // Gpno N8
  });

  it("limits how many checks a job may have (Gpno N9)", async () => {
    const checks = (n: number) => Array.from({ length: n }, () => ({ type: "json-schema", schema: { type: "object" } }));
    expect(await status(call("POST", "/jobs", newJob({ spec: { checks: checks(8) } })))).toBe(200);
    expect(await status(call("POST", "/jobs", newJob({ spec: { checks: checks(9) } })))).toBe(400);
  });

  it("walks a job through draft -> funded -> delivered -> verified_pass -> paid", async () => {
    const job = await call("POST", "/jobs", newJob());
    expect(await status(deliver(job.id, provider, "work"))).toBe(409); // not funded yet
    expect(await status(event(job.id, { source: "oracle", status: "funded" }))).toBe(400); // only the ledger funds
    const funded = await event(job.id, { source: "ledger", status: "funded", offerSequence: 42, cancelAfter: 800_000_000, txHash: "C1" });
    expect(funded).toMatchObject({ status: "funded", offerSequence: 42, cancelAfter: 800_000_000, createTx: "C1" });
    expect(funded.fundedAt).toBeGreaterThan(0);

    expect(await status(deliver(job.id, client, "work"))).toBe(403); // only the provider delivers
    const delivered = await deliver(job.id, provider, "work");
    expect(delivered.status).toBe("delivered");
    expect(await call<{ content: string; sha256: string }>("GET", `/jobs/${job.id}/deliverable`))
      .toMatchObject({ content: "work", sha256: sha256Hex("work") });
    expect(await status(deliver(job.id, provider, "again"))).toBe(409);

    expect(await status(event(job.id, { source: "ledger", status: "verified_pass" }))).toBe(400);
    expect((await event(job.id, { source: "oracle", status: "verified_pass" })).verdict).toBe("pass");
    expect(await status(event(job.id, { source: "oracle", status: "verified_fail" }))).toBe(409);
    const paid = await event(job.id, { source: "ledger", status: "paid", txHash: "F1" });
    expect(paid).toMatchObject({ status: "paid", finishTx: "F1" });
    expect(await status(event(job.id, { source: "ledger", status: "refunded" }))).toBe(409); // paid is final

    const history = await call<JobEvent[]>("GET", `/jobs/${job.id}/events`);
    expect(history.filter((e) => e.status).map((e) => e.status)).toEqual(["draft", "funded", "delivered", "verified_pass", "paid"]);
  });

  it("lets the ledger close a job from any open state, and records it", async () => {
    const job = await call("POST", "/jobs", newJob());
    await event(job.id, { source: "ledger", status: "funded", offerSequence: 43, cancelAfter: 800_000_000 });
    // A finish the oracle never approved (e.g. the fulfillment leaked) still shows as paid, because the ledger says so.
    const paid = await event(job.id, { source: "ledger", status: "paid", txHash: "X1" });
    expect(paid).toMatchObject({ status: "paid", finishTx: "X1" });
    const history = await call<JobEvent[]>("GET", `/jobs/${job.id}/events`);
    expect(history.at(-1)?.detail).toContain("ledger overrides funded");
  });

  it("only moves verified_pass to expired_unclaimed, and flags expiring escrows", async () => {
    const job = await call("POST", "/jobs", newJob());
    await event(job.id, { source: "ledger", status: "funded", offerSequence: 44, cancelAfter: 800_000_000 });
    expect(await status(event(job.id, { source: "ledger", status: "expired_unclaimed" }))).toBe(409);
    expect((await event(job.id, { source: "ledger", expiringSoon: true, detail: "20 s left before CancelAfter" })).expiringSoon).toBe(true);
    await deliver(job.id, provider, "work");
    await event(job.id, { source: "oracle", status: "verified_pass" });
    expect((await event(job.id, { source: "ledger", status: "expired_unclaimed" })).status).toBe("expired_unclaimed");
    expect((await event(job.id, { source: "ledger", status: "refunded" })).status).toBe("refunded");
  });

  it("computes the reputation stub from the registry", async () => {
    const other = Wallet.generate();
    const mk = () => call("POST", "/jobs", newJob({ provider: other.address }));
    const fundDeliver = async (id: string, seq: number) => {
      await event(id, { source: "ledger", status: "funded", offerSequence: seq, cancelAfter: 1 });
      await deliver(id, other, "w");
    };
    const [a, b, c] = [await mk(), await mk(), await mk()];
    await fundDeliver(a.id, 1);
    await event(a.id, { source: "oracle", status: "verified_pass" });
    await event(a.id, { source: "ledger", status: "paid" });
    await fundDeliver(b.id, 2);
    await event(b.id, { source: "oracle", status: "verified_fail" });
    await event(b.id, { source: "ledger", status: "refunded" });
    expect(c.status).toBe("draft");
    expect(await call("GET", `/providers/${other.address}/reputation`)).toEqual({
      provider: other.address, total: 3, passed: 1, failed: 1, paid: 1, refunded: 1, expiredUnclaimed: 0,
    });
  });

  it("still counts a job as expired_unclaimed after it is refunded", async () => {
    const other = Wallet.generate();
    const job = await call("POST", "/jobs", newJob({ provider: other.address }));
    await event(job.id, { source: "ledger", status: "funded", offerSequence: 3, cancelAfter: 1 });
    await deliver(job.id, other, "w");
    await event(job.id, { source: "oracle", status: "verified_pass" });
    await event(job.id, { source: "ledger", status: "expired_unclaimed" });
    expect((await call<{ expiredUnclaimed: number }>("GET", `/providers/${other.address}/reputation`)).expiredUnclaimed).toBe(1);
    await event(job.id, { source: "ledger", status: "refunded" });
    expect(await call("GET", `/providers/${other.address}/reputation`)).toEqual({
      provider: other.address, total: 1, passed: 1, failed: 0, paid: 0, refunded: 1, expiredUnclaimed: 1,
    });
  });
});
