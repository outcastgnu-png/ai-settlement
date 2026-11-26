// Signed job spec v1 (EDR-016) without services: canonical form and hash,
// validation, signatures, the EscrowCreate memo, criteria and rules, the two
// new checks, reading the memo from a validated EscrowCreate, and the v2
// verdict log (Phase 4 and 5 logs still verify).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Wallet } from "xrpl";
import { sha256Hex } from "../src/auth.js";
import {
  agreementProblems, jcs, makeJobSpec, meetsRule, parseSpecMemo, reviseJobSpec, signSpecHash, specHash, specMemos, specProblem,
  verifySpecSignature, type JobSpecV1,
} from "../src/job-spec.js";
import { runCriteria } from "../src/oracle/checks/index.js";
import type { Job } from "../src/registry/db.js";
import { escrowCreateSpecMemo, specAgainstMemo } from "../src/spec-ledger.js";
import { checkChain, entryMismatch, findVerdict, verdictHash, type LogEntry } from "../src/verdict-log.js";
import type { SignedVerdict } from "../src/oracle/server.js";

const V = JSON.parse(readFileSync("test/vectors/job-spec.json", "utf8"));
const client = Wallet.generate();
const provider = Wallet.generate();

const spec = (over: Partial<JobSpecV1> = {}) => makeJobSpec({
  title: "report", client: client.address, provider: provider.address, priceDrops: "5000000", slaSeconds: 120,
  criteria: [
    { id: "has-summary", statement: "The report has a summary", kind: "objective", checks: [{ type: "contains-text", text: "Summary:" }] },
    { id: "useful", statement: "The research is useful", kind: "subjective", checks: [{ type: "size-range", minBytes: 20, maxBytes: 1000 }] },
    { id: "exact", statement: "It is the agreed file", kind: "objective", checks: [{ type: "sha256-match", sha256: sha256Hex("x") }] },
  ],
  ...over,
});

describe("canonical form and hash (shared vectors, test/vectors/job-spec.json)", () => {
  it("matches every canonical form and spec hash", () => {
    for (const c of V.jcs) expect(jcs(c.value)).toBe(c.canonical);
    for (const s of V.specs) {
      expect(jcs(s.spec)).toBe(s.canonical);
      expect(specHash(s.spec)).toBe(s.specHash);
      expect(specProblem(s.spec)).toBeNull();
    }
  });

  it("refuses values two SDKs could encode differently", () => {
    for (const c of V.refusedJcs) expect(() => jcs(c.value)).toThrow(c.why);
    expect(() => jcs({ s: "\uD800" })).toThrow(/lone surrogate/);
    expect(() => jcs({ u: undefined })).toThrow(/undefined/);
  });

  it("key order and whitespace don't change the hash; any content change does", () => {
    const s = spec();
    const reordered = Object.fromEntries(Object.entries(s).reverse()) as JobSpecV1;
    expect(specHash(reordered)).toBe(specHash(s));
    expect(specHash(JSON.parse(JSON.stringify(s, null, 4)))).toBe(specHash(s));
    expect(specHash({ ...s, title: "report " })).not.toBe(specHash(s));
  });
});

describe("what a spec may say", () => {
  it("refuses every vector problem with its reason", () => {
    for (const p of V.problems) expect(specProblem(p.spec), JSON.stringify(p.spec.criteria)).toContain(p.contains);
  });

  it("a subjective criterion without a check is refused, in plain words, before anything is sent", () => {
    expect(() => spec({ criteria: [{ id: "useful", statement: "The research is useful", kind: "subjective", checks: [] }] }))
      .toThrow(/subjective .* names no check\. This kit can't judge that statement/);
  });

  it("limits checks across all criteria, and ledger lookups", () => {
    const tx = { type: "xrpl-tx-validated" as const, txType: "Payment" as const, destination: provider.address, minDrops: "1" };
    expect(() => spec({ rule: "all", criteria: [{ id: "a", statement: "paid", kind: "objective", checks: [tx, tx, tx] }] })).toThrow(/at most 2 xrpl-tx-validated/);
  });

  it("revisions count up and keep the parties and nonce", () => {
    const s = spec();
    const r = reviseJobSpec(s, { priceDrops: "6000000" });
    expect(r).toMatchObject({ revision: 2, nonce: s.nonce, client: s.client, priceDrops: "6000000" });
    expect(specHash(r)).not.toBe(specHash(s));
  });
});

describe("signatures over the spec hash", () => {
  it("match the vectors (deterministic signatures by fixed keys)", () => {
    for (const sig of V.signatures) expect(verifySpecSignature(sig.specHash, sig.signature, sig.address)).toBe(true);
    const s = V.signatures[0];
    expect(verifySpecSignature(V.specs[1].specHash, s.signature, s.address)).toBe(false);
    expect(verifySpecSignature(s.specHash, { ...s.signature, address: V.parties.provider.address }, V.parties.provider.address)).toBe(false);
  });

  it("both parties must sign the exact hash before funds are locked", () => {
    const s = spec();
    const h = specHash(s);
    expect(agreementProblems(s, {})).toHaveLength(2);
    expect(agreementProblems(s, { client: signSpecHash(h, client) })).toEqual([expect.stringMatching(/provider .* has not signed/)]);
    expect(agreementProblems(s, { client: signSpecHash(h, client), provider: signSpecHash(h, provider) })).toEqual([]);
    // A signature by the wrong party, or over another revision, does not count.
    expect(agreementProblems(s, { client: signSpecHash(h, client), provider: signSpecHash(h, client) })).toHaveLength(1);
    const r = reviseJobSpec(s, { title: "report v2" });
    expect(agreementProblems(r, { client: signSpecHash(h, client), provider: signSpecHash(h, provider) })).toHaveLength(2);
  });
});

describe("the EscrowCreate memo", () => {
  it("matches the vectors and reads back; malformed or doubled memos are refused", () => {
    for (const m of V.memos) {
      const s = V.specs.find((x: { specHash: string }) => x.specHash === m.spec).spec;
      expect(specMemos(s)).toEqual(m.memos);
      expect(parseSpecMemo(m.memos)).toEqual({ specHash: m.spec, specVersion: 1, revision: m.revision });
    }
    for (const bad of V.badMemos) expect(parseSpecMemo(bad)).toHaveProperty("problem");
    expect(parseSpecMemo(undefined)).toBeNull();
    expect(parseSpecMemo([{ Memo: { MemoType: "AB", MemoData: "CD" } }])).toBeNull();
  });

  it("refuses a spec memo whose MemoFormat is not application/json, or whose JSON is not canonical (N41)", () => {
    expect(V.strictBadMemos.length).toBeGreaterThan(0);
    for (const bad of V.strictBadMemos) {
      expect(parseSpecMemo(bad.memos), bad.name).toHaveProperty("problem", expect.stringContaining(bad.problem));
    }
  });

  const s = spec();
  const condition = `A0258020${"CD".repeat(32)}810120`;
  const tx = (over: Record<string, unknown> = {}) => ({
    found: true as const, validated: true, closeTime: 1, meta: { TransactionResult: "tesSUCCESS" },
    tx: { TransactionType: "EscrowCreate", Account: client.address, Destination: provider.address, Condition: condition, Sequence: 9, Amount: "5000000", Memos: specMemos(s), ...over },
  });
  const expect_ = { owner: client.address, destination: provider.address, condition, offerSequence: 9, amount: "5000000" };

  it("is read only from the job's own validated, successful EscrowCreate", async () => {
    const H = "AB".repeat(32);
    expect(await escrowCreateSpecMemo(async () => tx(), H, expect_)).toEqual({ memo: { specHash: specHash(s), specVersion: 1, revision: 1 } });
    for (const [lookup, why] of [
      [{ found: false }, /not on the ledger/], [{ ...tx(), validated: false }, /not in a validated/],
      [{ ...tx(), meta: { TransactionResult: "tecNO_PERMISSION" } }, /did not succeed/],
      [tx({ TransactionType: "Payment" }), /not an EscrowCreate/], [tx({ Account: provider.address }), /client/],
      [tx({ Destination: client.address }), /provider/], [tx({ Condition: `A0258020${"EF".repeat(32)}810120` }), /condition/],
      [tx({ Sequence: 10 }), /sequence/], [tx({ Memos: undefined }), /no job spec memo/],
    ] as const) {
      const got = await escrowCreateSpecMemo(async () => lookup as never, H, expect_);
      expect(got, String(why)).toHaveProperty("problem", expect.stringMatching(why));
    }
  });

  it("an oracle refuses a registry spec whose hash is not the one locked on the ledger", () => {
    const h = specHash(s);
    const job = {
      id: "j", client: client.address, provider: provider.address, priceDrops: s.priceDrops, slaSeconds: s.slaSeconds, spec: s,
      specSignatures: { client: signSpecHash(h, client), provider: signSpecHash(h, provider) },
    } as unknown as Job;
    const memo = { specHash: h, specVersion: 1, revision: 1 };
    expect(specAgainstMemo(job, memo)).toBeNull();
    // The registry's copy edited after the lock: same revision, different content.
    const edited = { ...job, spec: { ...s, criteria: s.criteria.slice(0, 1), rule: "all" } } as Job;
    expect(specAgainstMemo(edited, memo)).toMatch(/is not the spec locked on the ledger/);
    expect(specAgainstMemo({ ...job, specSignatures: { client: job.specSignatures!.client, provider: null } }, memo)).toMatch(/provider .* has not signed/);
    // N41: the memo's revision must be the registry spec's revision too, not only its hash.
    expect(specAgainstMemo(job, { ...memo, revision: 2 })).toMatch(/is not the spec locked on the ledger/);
  });
});

describe("criteria and rules", () => {
  it("match the rule vectors", () => {
    for (const r of V.rules) expect(meetsRule(r.rule, r.results.map((pass: boolean) => ({ pass })))).toBe(r.meets);
  });

  const ctx = (content: string) => ({ job: {} as Job, content, deliveredAt: 0 });

  it("a criterion passes when all its checks pass; atLeast 2 of 3 passes with one failed", async () => {
    const s = spec({ rule: { atLeast: 2 } });
    const work = "Summary: three findings, each with its source transaction.";
    const out = await runCriteria(s, ctx(work));
    expect(out.criteria).toEqual([
      { id: "has-summary", kind: "objective", pass: true }, { id: "useful", kind: "subjective", pass: true }, { id: "exact", kind: "objective", pass: false },
    ]);
    expect(out.pass).toBe(true);
    expect(out.results.map((r) => r.criterion)).toEqual(["has-summary", "useful", "exact"]);
    expect((await runCriteria({ ...s, rule: "all" }, ctx(work))).pass).toBe(false);
    expect((await runCriteria(s, ctx("summary: too short"))).pass).toBe(false);
  });

  it("size-range counts UTF-8 bytes; contains-text is literal and case-sensitive", async () => {
    const s = spec({
      rule: "all", criteria: [
        { id: "size", statement: "a small file", kind: "objective", checks: [{ type: "size-range", minBytes: 4, maxBytes: 4 }] },
        { id: "text", statement: "names the method", kind: "objective", checks: [{ type: "contains-text", text: "a.*b" }] },
      ],
    });
    expect((await runCriteria(s, ctx("éé"))).criteria[0].pass).toBe(true); // 2 characters, 4 bytes
    expect((await runCriteria(s, ctx("abcd"))).criteria[1].pass).toBe(false); // no regex
    expect((await runCriteria(s, ctx("xa.*b"))).criteria[1].pass).toBe(true);
    const caseCheck = spec({ rule: "all", criteria: [{ id: "t", statement: "s", kind: "objective", checks: [{ type: "contains-text", text: "Summary" }] }] });
    expect((await runCriteria(caseCheck, ctx("summary"))).pass).toBe(false);
  });
});

describe("verdict log v2 (EDR-016)", () => {
  const log = V.log;
  it("a log of Phase 5 (v1) entries followed by Phase 6 (v2) entries verifies; a v1 entry after a v2 does not", () => {
    expect(checkChain(log.mixed, V.oracle)).toMatchObject({ ok: true, count: 4 });
    expect(checkChain(log.downgrade, V.oracle).problem).toMatch(/entry 3: a version 1 entry after a version 2 entry/);
  });

  it("Phase 4 and 5 logs (test/vectors/verdict-log.json) still verify", () => {
    const old = JSON.parse(readFileSync("test/vectors/verdict-log.json", "utf8"));
    expect(old.entries.every((e: { v: number }) => e.v === 1)).toBe(true);
    expect(checkChain(old.entries, old.oracle).ok).toBe(true);
  });

  it("each entry agrees with its verdict, spec fields included", () => {
    const [oldV, newV, unsignedV] = log.verdicts as SignedVerdict[];
    const entries = log.mixed as LogEntry[];
    expect(log.verdictHashes.slice(0, 3)).toEqual([oldV, newV, unsignedV].map(verdictHash));
    expect(findVerdict(entries, oldV).entry?.seq).toBe(1);
    expect(findVerdict(entries, newV).entry?.seq).toBe(2);
    expect(entries[2]).toMatchObject({ specHash: newV.specHash, specRevision: 1, criteria: newV.criteria });
    expect(entries[3]).toMatchObject({ specHash: null, criteria: null });
    expect(entryMismatch(entries[2], { ...newV, specHash: "00".repeat(32) })).toBe("verdictHash");
    // A v2 entry whose public spec hash differs from its verdict's, re-signed: caught by field.
    const forged = { ...entries[2], specHash: "11".repeat(32) } as LogEntry;
    expect(entryMismatch(forged, newV)).toBe("specHash");
    const forgedCriteria = { ...entries[2], criteria: newV.criteria!.map((c) => ({ ...c, pass: true })) } as LogEntry;
    expect(entryMismatch(forgedCriteria, newV)).toBe("criteria");
  });

  it("a v2 verdict entry must carry every spec field", () => {
    const { specHash: _drop, ...missing } = log.mixed[2];
    expect(checkChain([log.mixed[0], log.mixed[1], missing], V.oracle).problem).toMatch(/entry 2/);
  });
});
