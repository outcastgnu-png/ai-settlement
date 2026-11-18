// Shared verification, k of n oracles (EDR-015), with a local registry and three
// local oracles and no ledger: Shamir, share boxes, the registry's counting of
// signed verdicts, the oracle's share handling and the SDK's combining.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Wallet } from "xrpl";
import { canonicalJson, newJobHash, sha256Hex, signPayload, signRequest } from "../src/auth.js";
import { makeSecret, toCondition, toFulfillment } from "../src/condition.js";
import { HttpError, callJson } from "../src/http.js";
import type { Job } from "../src/registry/db.js";
import { choose, combine, decodeShare, encodeShare, gfDiv, gfMul, split } from "../src/shamir.js";
import { generateShareKey, open, seal, shareKeyPublic, signShareKey, verifyShareKey } from "../src/share-box.js";
import { EscrowKit, combineForCondition, type SignedVerdict } from "../src/sdk/index.js";
import { markFunded, startSharedLocal } from "./helpers.js";

const client = Wallet.generate();
const provider = Wallet.generate();
const WORK = "the work";
const spec = { checks: [{ type: "sha256-match" as const, sha256: sha256Hex(WORK) }] };

describe("Shamir over GF(256)", () => {
  it("field arithmetic: every non-zero element has an inverse", () => {
    for (let a = 1; a < 256; a++) expect(gfMul(a, gfDiv(1, a))).toBe(1);
    expect(gfMul(0x57, 0x83)).toBe(0xc1); // FIPS-197 example
  });

  it("any k of n shares rebuild the secret; fewer do not", () => {
    for (const [k, n] of [[2, 3], [3, 5], [2, 2], [5, 7]]) {
      const secret = makeSecret();
      const shares = split(secret, k, n);
      for (const pick of choose(shares, k)) expect(combine(pick).equals(secret)).toBe(true);
      if (k > 2) for (const pick of choose(shares, k - 1)) expect(combine(pick).equals(secret)).toBe(false);
    }
  });

  it("one share of a 2-of-3 split is not the secret, and two different splits differ", () => {
    const secret = makeSecret();
    const a = split(secret, 2, 3);
    const b = split(secret, 2, 3);
    expect(a[0].y.equals(secret)).toBe(false);
    expect(a[0].y.equals(b[0].y)).toBe(false);
  });

  it("refuses bad parameters and repeated shares", () => {
    expect(() => split(makeSecret(), 1, 3)).toThrow(/at least 2/);
    expect(() => split(makeSecret(), 4, 3)).toThrow(/at least the threshold/);
    const s = split(makeSecret(), 2, 3);
    expect(() => combine([s[0]])).toThrow(/at least 2/);
    expect(() => combine([s[0], s[0]])).toThrow(/twice/);
    expect(() => decodeShare("00".repeat(33))).toThrow(/not be 0/);
    expect(decodeShare(encodeShare(s[1]))).toEqual(s[1]);
  });

  it("matches the shared vectors (test/vectors/shamir.json)", () => {
    const v = JSON.parse(readFileSync("test/vectors/shamir.json", "utf8"));
    for (const c of v.splits) {
      const shares = split(Buffer.from(c.secret, "hex"), c.k, c.n, () => Buffer.from(c.coefficients, "hex"));
      expect(shares.map(encodeShare)).toEqual(c.shares);
      for (const pick of choose(c.shares as string[], c.k)) expect(combine(pick.map((h) => decodeShare(h))).toString("hex")).toBe(c.secret);
    }
  });
});

describe("share boxes", () => {
  const key = generateShareKey();
  const pub = shareKeyPublic(key);
  const ctx = { jobId: "job-1", oracle: Wallet.generate().address, index: 2 };
  const share = Buffer.from(encodeShare(split(makeSecret(), 2, 3)[1]), "hex");

  it("open what was sealed to this key, for this job, oracle and index only", () => {
    const box = seal(share, pub, ctx);
    expect(open(box, key, ctx).equals(share)).toBe(true);
    expect(() => open(box, key, { ...ctx, index: 3 })).toThrow(/does not open/);
    expect(() => open(box, key, { ...ctx, jobId: "job-2" })).toThrow(/does not open/);
    expect(() => open(box, key, { ...ctx, oracle: Wallet.generate().address })).toThrow(/does not open/);
    expect(() => open(box, generateShareKey(), ctx)).toThrow(/does not open/);
    expect(() => open({ ...box, ct: `${box.ct.slice(0, -2)}${box.ct.endsWith("00") ? "01" : "00"}` }, key, ctx)).toThrow(/does not open/);
    expect(() => open({ v: 1 }, key, ctx)).toThrow(/not a share box/);
  });

  it("a share key is trusted only with its oracle's verdict signature", () => {
    const verdictKey = Wallet.generate("ed25519" as never);
    const { shareKey, shareKeySignature } = signShareKey(verdictKey, pub);
    expect(verifyShareKey(verdictKey.address, verdictKey.publicKey, shareKey, shareKeySignature)).toBe(true);
    expect(verifyShareKey(verdictKey.address, verdictKey.publicKey, shareKeyPublic(generateShareKey()), shareKeySignature)).toBe(false);
    const other = Wallet.generate("ed25519" as never);
    expect(verifyShareKey(verdictKey.address, other.publicKey, shareKey, signShareKey(other, pub).shareKeySignature)).toBe(false);
  });

  it("matches the shared vectors (test/vectors/share-box.json)", () => {
    const v = JSON.parse(readFileSync("test/vectors/share-box.json", "utf8"));
    for (const c of v.boxes) {
      expect(shareKeyPublic(c.recipientPrivate)).toBe(c.recipientPublic);
      expect(seal(Buffer.from(c.share, "hex"), c.recipientPublic, c.context, { ephemeral: c.ephemeralPrivate, iv: c.iv })).toEqual(c.box);
      expect(open(c.box, c.recipientPrivate, c.context).toString("hex")).toBe(c.share);
    }
  });
});

describe("combineForCondition", () => {
  const secret = makeSecret();
  const condition = toCondition(secret);
  const shares = split(secret, 2, 3);
  const set = [0, 1, 2].map(() => ({ address: Wallet.generate().address, anchor: Wallet.generate().address, url: "http://127.0.0.1:1" }));
  const os = (i: number) => ({ oracle: set[i].address, share: encodeShare(shares[i]) });

  it("needs k shares", () => {
    expect(combineForCondition([os(0)], set, 2, condition)).toBeNull();
    expect(combineForCondition([os(0), os(2)], set, 2, condition)?.fulfillment).toBe(toFulfillment(secret));
  });

  it("never uses a share from an oracle outside the set, or at another position", () => {
    expect(() => combineForCondition([os(0), { oracle: Wallet.generate().address, share: encodeShare(shares[1]) }], set, 2, condition)).toThrow(/not in the job's oracle set/);
    expect(() => combineForCondition([os(0), { oracle: set[2].address, share: encodeShare(shares[1]) }], set, 2, condition)).toThrow(/holds share 3/);
  });

  it("skips a wrong share when k others are right", () => {
    const bad = { oracle: set[1].address, share: encodeShare({ x: 2, y: Buffer.alloc(32, 7) }) };
    const res = combineForCondition([os(0), bad, os(2)], set, 2, condition);
    expect(res?.fulfillment).toBe(toFulfillment(secret));
    expect(res?.used).toEqual([set[0].address, set[2].address]);
    expect(combineForCondition([os(0), bad], set, 2, condition)).toBeNull();
  });
});

describe("shared jobs: registry + three oracles, no ledger", () => {
  let local: Awaited<ReturnType<typeof startSharedLocal>>;
  let kit: EscrowKit;
  let seq = 100;
  beforeAll(async () => {
    local = await startSharedLocal(3);
    kit = new EscrowKit({ registryUrl: local.registry.url, oracleAddress: "unused", anchorAddress: "unused", statusTimeoutMs: 300, listAnchors: local.kitAnchors });
  });
  afterAll(() => local.close());

  const newJob = (threshold = 2) => kit.createSharedJob({
    client: client.address, provider: provider.address, priceDrops: "5000000", slaSeconds: 60, spec, oracles: local.set(), threshold,
  }, client);
  const fundedJob = async () => {
    const job = await newJob();
    await markFunded(local.registry.url, job.id, seq++);
    return job;
  };

  it("createSharedJob registers the set and the client's condition; every oracle holds only its own share", async () => {
    const job = await newJob();
    expect(job).toMatchObject({ status: "draft", threshold: 2, oracles: local.set() });
    expect(job.condition).toMatch(/^A0258020[0-9A-F]{64}810120$/);
    const stored = JSON.stringify(await kit.getJob(job.id)) + JSON.stringify(await kit.events(job.id));
    // Each vault holds one share, at its own x; any two rebuild the condition's secret.
    const { SecretVault } = await import("../src/oracle/vault.js");
    const { join } = await import("node:path");
    const held = local.oracles.map((o) => decodeShare(new SecretVault(join(o.dir, "vault.json"), o.vaultKey).get(job.id)!.toString("hex")));
    expect(held.map((s) => s.x)).toEqual([1, 2, 3]);
    for (const s of held) expect(stored).not.toContain(s.y.toString("hex"));
    expect(toCondition(combine([held[0], held[2]]))).toBe(job.condition);
  });

  it("the registry takes a shared job only signed by its client, and a condition only once", async () => {
    const body = { client: client.address, provider: provider.address, priceDrops: "5000000", slaSeconds: 60, spec, oracles: local.set(), threshold: 2, condition: toCondition(makeSecret()) };
    await expect(callJson("POST", `${local.registry.url}/jobs`, body)).rejects.toThrow(/signed auth/);
    await expect(callJson("POST", `${local.registry.url}/jobs`, { ...body, auth: signRequest(provider, "create", "", newJobHash(body)) })).rejects.toThrow(/provider|403/);
    await expect(callJson("POST", `${local.registry.url}/jobs`, { ...body, auth: signRequest(client, "create", "", newJobHash({ ...body, threshold: 3 })) })).rejects.toThrow(/bad signature/);
    await callJson("POST", `${local.registry.url}/jobs`, { ...body, auth: signRequest(client, "create", "", newJobHash(body)) });
    await expect(callJson("POST", `${local.registry.url}/jobs`, { ...body, auth: signRequest(client, "create", "", newJobHash(body), Date.now() + 1) })).rejects.toThrow(/already exists/);
    for (const [bad, msg] of [[{ threshold: 1 }, /threshold/], [{ threshold: 4 }, /threshold/], [{ oracles: local.set().slice(0, 1) }, /2 to/],
      [{ oracles: [local.set()[0], local.set()[0]] }, /its own/], [{ oracles: local.set().map((o) => ({ ...o, url: "http://example.com:80" })) }, /local only/]] as const) {
      const b = { ...body, ...bad, condition: toCondition(makeSecret()) };
      await expect(callJson("POST", `${local.registry.url}/jobs`, { ...b, auth: signRequest(client, "create", "", newJobHash(b)) })).rejects.toThrow(msg);
    }
  });

  it("an oracle's service token can neither set a shared job's condition nor its status", async () => {
    const job = await fundedJob();
    const { TOKENS } = await import("./helpers.js");
    await expect(callJson("PUT", `${local.registry.url}/jobs/${job.id}/condition`, { condition: job.condition }, TOKENS.oracle)).rejects.toThrow(/set by its client/);
    await callJson("POST", `${local.registry.url}/jobs/${job.id}/deliverable`, { content: WORK, auth: signRequest(provider, "deliver", job.id, sha256Hex(WORK)) });
    await expect(callJson("POST", `${local.registry.url}/jobs/${job.id}/events`, { source: "oracle", status: "verified_pass" }, TOKENS.oracle)).rejects.toThrow(/signed oracle verdicts/);
    await expect(callJson("POST", `${local.oracles[0].server!.url}/jobs/${job.id}/condition`)).rejects.toThrow(/made and split by its client/);
  });

  it("an oracle takes a share only from the client, sealed to it, at its own index, while the job is a draft", async () => {
    const job = await newJob();
    const o = local.oracles[1];
    const url = o.server!.url;
    const ctx = { jobId: job.id, oracle: o.verdictKey.address, index: 2 };
    const raw = Buffer.from(encodeShare({ x: 2, y: Buffer.alloc(32, 1) }), "hex");
    const box = seal(raw, shareKeyPublic(o.shareKey), ctx);
    const auth = (w: Wallet, b: unknown) => signRequest(w, "share", job.id, sha256Hex(canonicalJson(b)));
    await expect(callJson("POST", `${url}/jobs/${job.id}/share`, { index: 2, box, auth: auth(provider, box) })).rejects.toThrow(/403|provider/);
    await expect(callJson("POST", `${url}/jobs/${job.id}/share`, { index: 3, box, auth: auth(client, box) })).rejects.toThrow(/holds share 2/);
    const other = seal(raw, shareKeyPublic(local.oracles[2].shareKey), { ...ctx, oracle: local.oracles[2].verdictKey.address });
    await expect(callJson("POST", `${url}/jobs/${job.id}/share`, { index: 2, box: other, auth: auth(client, other) })).rejects.toThrow(/does not open/);
    // It already holds the client's real share: a different one is refused.
    await expect(callJson("POST", `${url}/jobs/${job.id}/share`, { index: 2, box, auth: auth(client, box) })).rejects.toThrow(/different share/);
  });

  it("all three pass: the provider combines two shares into the fulfillment", async () => {
    const job = await fundedJob();
    const res = await kit.deliverShared(job.id, provider, WORK);
    expect(res.reports.flatMap((r) => r.problems)).toEqual([]);
    expect(res.passed).toHaveLength(3);
    expect(res.fulfillment).toMatch(/^A0228020[0-9A-F]{64}$/);
    expect(res.reports.filter((r) => r.used)).toHaveLength(2);
    expect(res.job.status).toBe("verified_pass");
    expect(res.reports.every((r) => r.log?.ok)).toBe(true);
    expect((await kit.jobVerdicts(job.id))).toHaveLength(3);
  });

  it("an oracle asked after the set has decided still verifies (the job's status is the set's, not its own)", async () => {
    const job = await fundedJob();
    await callJson("POST", `${local.registry.url}/jobs/${job.id}/deliverable`, { content: WORK, auth: signRequest(provider, "deliver", job.id, sha256Hex(WORK)) });
    for (const o of local.oracles.slice(0, 2)) {
      await callJson("POST", `${o.server!.url}/verify/${job.id}`, { auth: signRequest(provider, "verify", job.id, o.verdictKey.address) });
    }
    expect((await kit.getJob(job.id)).status).toBe("verified_pass");
    const third = local.oracles[2];
    const late = await callJson<{ verdict: SignedVerdict; share?: string }>("POST", `${third.server!.url}/verify/${job.id}`,
      { auth: signRequest(provider, "verify", job.id, third.verdictKey.address) });
    expect(late.verdict.verdict).toBe("pass");
    expect(late.share).toBeDefined();
  });

  it("the provider can wait for anchored verdicts only (requireAnchored)", async () => {
    const job = await fundedJob();
    await callJson("POST", `${local.registry.url}/jobs/${job.id}/deliverable`, { content: WORK, auth: signRequest(provider, "deliver", job.id, sha256Hex(WORK)) });
    const early = await kit.requestSharedVerification(job.id, provider, WORK, { requireAnchored: true });
    expect(early.fulfillment).toBeNull();
    expect(early.rejected).toHaveLength(3);
    expect(early.reports[0].problems.join(" ")).toMatch(/not pinned on the ledger yet/);
    await local.anchorAll();
    const later = await kit.requestSharedVerification(job.id, provider, WORK, { requireAnchored: true });
    expect(later.fulfillment).not.toBeNull();
  });

  it("two pass and one fails: the job still releases, and the split is listed", async () => {
    await local.restart(2, "fail");
    try {
      const job = await fundedJob();
      const res = await kit.deliverShared(job.id, provider, WORK);
      expect(res.passed).toEqual([local.set()[0].address, local.set()[1].address]);
      expect(res.failed).toEqual([local.set()[2].address]);
      expect(res.fulfillment).not.toBeNull();
      expect(res.job.status).toBe("verified_pass");
      const failReport = res.reports[2];
      expect(failReport.verdict?.checks.at(-1)).toMatchObject({ type: "oracle-fault", pass: false });
      expect(failReport.used).toBe(false);
      const splits = await kit.splitJobs();
      expect(splits.find((s) => s.jobId === job.id)).toMatchObject({ passed: res.passed, failed: res.failed, threshold: 2 });
      // A fail is final at that oracle: asking again gives the same fail and no share.
      const again = await callJson<{ verdict: SignedVerdict; share?: string }>("POST", `${local.oracles[2].server!.url}/verify/${job.id}`,
        { auth: signRequest(provider, "verify", job.id, local.oracles[2].verdictKey.address) });
      expect(again.verdict.verdict).toBe("fail");
      expect(again.share).toBeUndefined();
    } finally {
      await local.restart(2);
    }
  });

  it("one passes and two fail: no fulfillment, the job is verified_fail", async () => {
    await local.restart(1, "fail");
    await local.restart(2, "fail");
    try {
      const job = await fundedJob();
      const res = await kit.deliverShared(job.id, provider, WORK);
      expect(res.passed).toHaveLength(1);
      expect(res.failed).toHaveLength(2);
      expect(res.fulfillment).toBeNull();
      expect(res.job.status).toBe("verified_fail");
    } finally {
      await local.restart(1);
      await local.restart(2);
    }
  });

  it("bad work fails at every oracle and no share is released", async () => {
    const job = await fundedJob();
    const res = await kit.deliverShared(job.id, provider, "something else");
    expect(res.failed).toHaveLength(3);
    expect(res.fulfillment).toBeNull();
    for (const o of local.oracles) {
      const again = await callJson<{ share?: string }>("POST", `${o.server!.url}/verify/${job.id}`, { auth: signRequest(provider, "verify", job.id, o.verdictKey.address) });
      expect(again.share).toBeUndefined();
    }
  });

  it("one oracle is stopped: the other two still release", async () => {
    const job = await fundedJob();
    await local.stop(2);
    try {
      const res = await kit.deliverShared(job.id, provider, WORK);
      expect(res.unreachable).toEqual([local.set()[2].address]);
      expect(res.passed).toHaveLength(2);
      expect(res.fulfillment).not.toBeNull();
    } finally {
      await local.restart(2);
    }
  });

  it("an oracle whose verdict log does not check is not used", async () => {
    // Oracle 1's anchor account now shows a head its log does not have.
    const o = local.oracles[0];
    const { fakeAnchor } = await import("./helpers.js");
    o.onLedger.unshift({ ...fakeAnchor({ seq: 0, hash: "ab".repeat(32) }, o.verdictKey.address), account: o.anchorAddress });
    try {
      const job = await fundedJob();
      const res = await kit.deliverShared(job.id, provider, WORK);
      expect(res.rejected).toEqual([o.verdictKey.address]);
      expect(res.reports[0].problems.join(" ")).toMatch(/verdict log/);
      expect(res.reports[0].used).toBe(false);
      expect(res.fulfillment).not.toBeNull(); // from oracles 2 and 3
    } finally {
      o.onLedger.shift();
    }
  });

  it("the registry refuses a verdict from outside the set, unsigned, or for other work", async () => {
    const job = await fundedJob();
    const res = await kit.deliverShared(job.id, provider, WORK);
    const v = res.reports[0].verdict!;
    const post = (verdict: unknown) => callJson<Job>("POST", `${local.registry.url}/jobs/${job.id}/verdicts`, { verdict });
    const stranger = Wallet.generate("ed25519" as never);
    const { signature: _s, ...body } = v;
    const forged = { ...body, oracle: stranger.address, publicKey: stranger.publicKey };
    await expect(post({ ...forged, signature: signPayload(forged, stranger) })).rejects.toThrow(/not in this job's oracle set/);
    await expect(post({ ...v, verdict: "fail" })).rejects.toThrow(/signature/);
    const resigned = { ...body, evidenceHash: sha256Hex("other") };
    await expect(post({ ...resigned, signature: signPayload(resigned, local.oracles[0].verdictKey) })).rejects.toThrow(/delivered work/);
    // A second, different verdict signed by the same oracle: the first stands, and it is recorded.
    const second = { ...body, issuedAt: body.issuedAt + 1 };
    await expect(post({ ...second, signature: signPayload(second, local.oracles[0].verdictKey) })).rejects.toThrow(/first stands/);
    expect((await kit.events(job.id)).some((e) => /second, different verdict/.test(e.detail))).toBe(true);
    expect(await post(v)).toMatchObject({ status: "verified_pass" });
  });

  it("the provider refuses a set other than the one it pinned", async () => {
    const job = await fundedJob();
    await callJson("POST", `${local.registry.url}/jobs/${job.id}/deliverable`, { content: WORK, auth: signRequest(provider, "deliver", job.id, sha256Hex(WORK)) });
    const pinned = local.set().map((o, i) => (i === 2 ? { ...o, address: Wallet.generate().address } : o));
    await expect(kit.requestSharedVerification(job.id, provider, WORK, { oracles: pinned })).rejects.toThrow(/not the set you pinned/);
  });

  it("createSharedJob refuses an oracle whose identity or share key does not check", async () => {
    const set = local.set();
    const input = { client: client.address, provider: provider.address, priceDrops: "5000000", slaSeconds: 60, spec, threshold: 2 };
    await expect(kit.createSharedJob({ ...input, oracles: [set[0], set[1], { ...set[2], address: Wallet.generate().address }] }, client)).rejects.toThrow(/not the pinned/);
    await expect(kit.createSharedJob({ ...input, oracles: [set[0], set[1], { ...set[2], anchor: Wallet.generate().address }] }, client)).rejects.toThrow(/anchors from/);
    await expect(kit.createSharedJob({ ...input, oracles: set }, provider)).rejects.toThrow(/only the job's client/);
  });

  it("a single-oracle request signature can't be replayed at another oracle of the set", async () => {
    const job = await fundedJob();
    await callJson("POST", `${local.registry.url}/jobs/${job.id}/deliverable`, { content: WORK, auth: signRequest(provider, "deliver", job.id, sha256Hex(WORK)) });
    const auth = signRequest(provider, "verify", job.id, local.oracles[0].verdictKey.address);
    await expect(callJson("POST", `${local.oracles[1].server!.url}/verify/${job.id}`, { auth })).rejects.toThrow(HttpError);
  });
});
