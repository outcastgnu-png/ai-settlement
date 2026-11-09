// A job's first signed verdict is final (Gpno N25): not after a restart, not
// after a thousand other jobs, and not when the ledger later has a transaction
// that would pass. Also: the oracle refuses to start on a log that disagrees
// with the anchors already on the ledger (Gpno N29).
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Wallet } from "xrpl";
import { sha256Hex, signRequest } from "../src/auth.js";
import { RIPPLE_EPOCH_OFFSET } from "../src/config.js";
import { HttpError, callJson } from "../src/http.js";
import type { TxCheckSpec } from "../src/oracle/checks/xrpl-tx.js";
import type { SignedVerdict } from "../src/oracle/server.js";
import type { CheckSpec, Job } from "../src/registry/db.js";
import { TOKENS, fakeAnchor, markFunded, startLocal } from "./helpers.js";

const provider = Wallet.generate();
const client = Wallet.generate();
const vendor = Wallet.generate().address;
const txSpec: TxCheckSpec = { type: "xrpl-tx-validated", txType: "Payment", destination: vendor, minDrops: "1000000" };

describe("a job's first verdict is final", () => {
  let local: Awaited<ReturnType<typeof startLocal>>;
  beforeAll(async () => {
    local = await startLocal();
  });
  afterAll(() => local.close());

  async function delivered(content: string, checks: CheckSpec[], seq = 7) {
    const job = await callJson<Job>("POST", `${local.registry.url}/jobs`, {
      client: client.address, provider: provider.address, priceDrops: "1000000", slaSeconds: 60, spec: { checks },
    });
    await callJson("POST", `${local.oracle.url}/jobs/${job.id}/condition`);
    await markFunded(local.registry.url, job.id, seq);
    await callJson("POST", `${local.registry.url}/jobs/${job.id}/deliverable`, {
      content, auth: signRequest(provider, "deliver", job.id, sha256Hex(content)),
    });
    return job;
  }
  let nonce = 0;
  const verify = (id: string) => callJson<{ verdict: SignedVerdict; fulfillment?: string }>(
    "POST", `${local.oracle.url}/verify/${id}`, { auth: signRequest(provider, "verify", id, "", Date.now() + nonce++) });
  const status = async (id: string) => (await callJson<Job>("GET", `${local.registry.url}/jobs/${id}`)).status;
  const validPayment = (createdAt: number) => ({
    found: true as const, validated: true,
    tx: { TransactionType: "Payment", Account: provider.address, Destination: vendor, Amount: "1000000" },
    meta: { TransactionResult: "tesSUCCESS", delivered_amount: "1000000" },
    closeTime: Math.floor((createdAt + 5_000) / 1000) - RIPPLE_EPOCH_OFFSET,
  });

  it("keeps a fail after 1024 later verdicts, even once the transaction would pass", async () => {
    const hash = "A1".repeat(32);
    const victim = await delivered(hash, [txSpec]);
    const first = await verify(victim.id); // not found on the ledger yet
    expect(first.verdict.verdict).toBe("fail");
    expect(first.fulfillment).toBeUndefined();
    for (let i = 0; i < 1024; i++) {
      const job = await delivered(`other ${i}`, [{ type: "sha256-match", sha256: sha256Hex(`other ${i}`) }], 100 + i);
      await verify(job.id);
    }
    local.txs.set(hash, validPayment(victim.createdAt));
    const countBefore = local.oracle.store.count;
    const again = await verify(victim.id);
    expect(again.verdict).toEqual(first.verdict);
    expect(again.fulfillment).toBeUndefined();
    expect(local.oracle.store.count).toBe(countBefore);
    expect(await status(victim.id)).toBe("verified_fail");
  }, 180_000);

  it("keeps a fail across an oracle restart, from the log and its private signed copy", async () => {
    const hash = "B2".repeat(32);
    const victim = await delivered(hash, [txSpec]);
    local.txs.set(hash, { ...validPayment(victim.createdAt), validated: false });
    const first = await verify(victim.id);
    expect(first.verdict.checks[0].detail).toMatch(/not in a validated ledger/);
    await local.restartOracle();
    local.txs.set(hash, validPayment(victim.createdAt));
    const countBefore = local.oracle.store.count;
    const again = await verify(victim.id);
    expect(again.verdict).toEqual(first.verdict);
    expect(again.fulfillment).toBeUndefined();
    expect(local.oracle.store.count).toBe(countBefore);
  });

  it("keeps a pass too, and still returns the fulfillment for it after a restart", async () => {
    const job = await delivered("good", [{ type: "sha256-match", sha256: sha256Hex("good") }]);
    const first = await verify(job.id);
    await local.restartOracle();
    const again = await verify(job.id);
    expect(again.verdict).toEqual(first.verdict);
    expect(again.fulfillment).toBe(first.fulfillment);
  });

  it("answers 409 and releases nothing when the log has the job but the signed copy is gone", async () => {
    const job = await delivered("good", [{ type: "sha256-match", sha256: sha256Hex("good") }]);
    await verify(job.id);
    const signedPath = local.oracle.store.signedPath;
    const lines = readFileSync(signedPath, "utf8").trim().split("\n").filter((l) => !l.includes(job.id));
    writeFileSync(signedPath, `${lines.join("\n")}\n`);
    await local.restartOracle();
    const refused = await verify(job.id).then(() => 200, (e: HttpError) => e.status);
    expect(refused).toBe(409);
  });

  it("writes a signed verdict the log missed (a crash between the two writes) into the log on start", async () => {
    const job = await delivered("good", [{ type: "sha256-match", sha256: sha256Hex("good") }]);
    const { verdict } = await verify(job.id);
    const chainPath = local.verdictChain;
    await local.oracle.close(); // its shutdown anchor goes to the stand-in ledger, which is reset below
    const lines = readFileSync(chainPath, "utf8").trim().split("\n");
    expect(lines[lines.length - 1]).toContain(job.id);
    writeFileSync(chainPath, `${lines.slice(0, -1).join("\n")}\n`); // drop only the newest entry
    local.onLedger.length = 0; // the stand-in ledger never anchored that entry
    await local.restartOracle();
    expect(local.oracle.store.issued(job.id)?.verdict).toEqual(verdict);
    expect(local.oracle.store.count).toBe(lines.length);
  });

  it("refuses to re-verify a job that failed before the chained log existed", async () => {
    const job = await delivered("x", [{ type: "sha256-match", sha256: sha256Hex("y") }]);
    // As a 0.3.x oracle would have left it: verified_fail in the registry, nothing in the new log.
    await callJson("POST", `${local.registry.url}/jobs/${job.id}/events`, { source: "oracle", status: "verified_fail", detail: "old" },
      TOKENS.oracle);
    expect(await verify(job.id).then(() => 200, (e: HttpError) => e.status)).toBe(409);
  });
});

describe("the oracle checks the ledger's anchors before it anchors", () => {
  it("refuses to start when the anchor account already anchored a different log", async () => {
    const local = await startLocal();
    try {
      await local.oracle.anchorNow();
      // Someone (or a demo with a fresh data folder) anchored another genesis from the same account.
      local.onLedger.unshift(fakeAnchor({ seq: 0, hash: "ef".repeat(32) }, local.verdictKey.address));
      await expect(local.restartOracle()).rejects.toThrow(/refusing to start: the anchors on the ledger .* disagree/);
      local.onLedger.shift();
      await expect(local.restartOracle()).resolves.toBeTruthy();
    } finally {
      await local.close();
    }
  });
});
