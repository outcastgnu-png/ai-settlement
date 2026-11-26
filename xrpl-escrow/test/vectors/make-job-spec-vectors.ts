// Writes test/vectors/job-spec.json (EDR-016): what the TypeScript kit produces
// for signed job specs, so the Python SDK can be checked byte for byte:
//
//   jcs          RFC 8785 canonical forms of tricky values (key order by UTF-16
//                code unit, escapes, non-ASCII), and values both SDKs refuse
//   specs        job specs v1 with their canonical form and hash
//   problems     specs both SDKs refuse, with a word the reason must contain
//   signatures   spec-hash signatures by fixed vector keys (deterministic)
//   memos        the EscrowCreate memo for a spec, and memos that must not parse
//   strictBadMemos  memos refused for their MemoFormat or non-canonical JSON (N41)
//   rules        criterion results and whether they meet a rule
//   log          a verdict log with Phase 5 (v1) entries followed by Phase 6 (v2)
//                entries, which must verify, and a v1-after-v2 log, which must not
//
// The keys come from fixed entropy; they are vector keys only and are never
// funded. Run with: npx tsx test/vectors/make-job-spec-vectors.ts
import { writeFileSync } from "node:fs";
import { Wallet, type ECDSA } from "xrpl";
import { sha256Hex, signPayload } from "../../src/auth.js";
import { jcs, meetsRule, signSpecHash, specHash, specMemos, specProblem, type JobSpecV1 } from "../../src/job-spec.js";
import { GENESIS_PREV, sealEntry, verdictEntry, verdictHash } from "../../src/verdict-log.js";
import type { SignedVerdict, VerdictBody } from "../../src/oracle/server.js";

const wallet = (algorithm: string, entropy: string) => Wallet.fromEntropy(Buffer.from(entropy, "hex"), { algorithm: algorithm as ECDSA });
const client = wallet("secp256k1", "22".repeat(16));
const provider = wallet("ed25519", "33".repeat(16));
const oracle = wallet("ed25519", "44".repeat(16));

const jcsCases = [
  { "b": 1, "a": [true, false, null], "A": "x" },
  { "é": 1, "€": 2, "😀": 3, "ﬀ": 4, "z": 5, "": 6 },
  { text: "quote \" backslash \\ slash / tab \t newline \n cr \r bs \b ff \f ctl \u0001 \u001f del \u007f" },
  { unicode: "café ünïcödé 日本語 😀    " },
  { nested: { z: { y: [1, -2, 0, 9007199254740991] }, a: {} }, empty: [] },
].map((value) => ({ value, canonical: jcs(value) }));

const refusedJcs = [
  { value: { n: 1.5 }, why: "whole numbers" },
  { value: { n: 1e21 }, why: "whole numbers" },
];

const base: JobSpecV1 = {
  specVersion: 1, revision: 1, nonce: "0123456789abcdef0123456789abcdef", title: "Research note on XRPL escrow fees",
  client: client.address, provider: provider.address, priceDrops: "5000000", slaSeconds: 300,
  criteria: [
    { id: "format", statement: "The note is a JSON object with summary, sources and findings", kind: "objective",
      checks: [{ type: "json-schema", schema: { type: "object", properties: { summary: { type: "string" }, sources: { type: "array" }, findings: { type: "array" } }, required: ["summary", "sources", "findings"] } }] },
    { id: "useful", statement: "The research is useful", kind: "subjective",
      checks: [{ type: "size-range", minBytes: 200, maxBytes: 20000 }, { type: "contains-text", text: "\"sources\"" }] },
    { id: "on-time", statement: "Delivered within 5 minutes of funding", kind: "objective", checks: [{ type: "max-latency", maxMs: 300000 }] },
  ],
  rule: { atLeast: 2 },
};
const specs = [
  base,
  { ...base, revision: 2, rule: "all" as const, title: "Résumé ✓ with non-ASCII" },
  {
    ...base, nonce: "ffffffffffffffffffffffffffffffff", criteria: [
      { id: "file", statement: "Delivered the file", kind: "objective" as const, checks: [{ type: "sha256-match" as const, sha256: sha256Hex("the file") }] },
    ], rule: "all" as const,
  },
].map((spec) => ({ spec, canonical: jcs(spec), specHash: specHash(spec) }));

const problems = [
  { spec: { ...base, rule: "all", criteria: [{ id: "useful", statement: "The research is useful", kind: "subjective", checks: [] }] }, contains: "can't judge" },
  { spec: { ...base, rule: "all", criteria: [{ id: "x", statement: "Done", kind: "objective", checks: [] }] }, contains: "names no check" },
  { spec: { ...base, rule: { atLeast: 4 } }, contains: "rule" },
  { spec: { ...base, specVersion: 2 }, contains: "specVersion" },
  { spec: { ...base, extra: true }, contains: "unknown fields" },
  { spec: { ...base, nonce: "abc" }, contains: "nonce" },
  { spec: { ...base, provider: base.client }, contains: "differ" },
  { spec: { ...base, criteria: [base.criteria[0], { ...base.criteria[1], id: "format" }] }, contains: "used twice" },
  { spec: { ...base, rule: "all", criteria: [{ ...base.criteria[2], checks: [{ type: "max-latency", maxMs: 1.5 }] }] }, contains: "whole numbers" },
  { spec: { ...base, rule: "all", criteria: [{ ...base.criteria[1], checks: [{ type: "contains-text", text: "" }] }] }, contains: "contains-text" },
  { spec: { ...base, rule: "all", criteria: [{ ...base.criteria[1], checks: [{ type: "size-range", minBytes: 10, maxBytes: 5 }] }] }, contains: "size-range" },
  { spec: { ...base, rule: "all", criteria: [{ ...base.criteria[1], checks: Array.from({ length: 9 }, () => ({ type: "size-range", minBytes: 0, maxBytes: 9 })) }] }, contains: "at most 8" },
];
for (const p of problems) {
  const got = specProblem(p.spec);
  if (!got || !got.includes(p.contains)) throw new Error(`vector problem mismatch: ${got} does not contain ${p.contains}`);
}

const signatures = [client, provider].flatMap((w) => specs.map((s) => ({ address: w.address, specHash: s.specHash, signature: signSpecHash(s.specHash, w) })));

const memos = specs.map((s) => ({ spec: s.specHash, revision: s.spec.revision, memos: specMemos(s.spec) }));
const hexText = (t: string) => Buffer.from(t, "utf8").toString("hex").toUpperCase();
const T = hexText("xrpl-escrow/job-spec");
// These carry MemoFormat application/json, so each is refused for its own reason.
const F = hexText("application/json");
const badMemos = [
  [{ Memo: { MemoType: T, MemoFormat: F, MemoData: hexText("not json") } }],
  [{ Memo: { MemoType: T, MemoFormat: F, MemoData: hexText(JSON.stringify({ specHash: specs[0].specHash, specVersion: 1 })) } }],
  [{ Memo: { MemoType: T, MemoFormat: F, MemoData: hexText(JSON.stringify({ specHash: specs[0].specHash.toUpperCase(), specVersion: 1, revision: 1 })) } }],
  [...specMemos(specs[0].spec), ...specMemos(specs[2].spec)],
];
// Memos that a lax reader accepts but both SDKs must refuse (Gpno N41): each is a
// correct spec memo for specs[0] apart from the one thing its name says.
const h0 = specs[0].specHash;
const strictMemo = (data: string, format: string | null = F) => [{ Memo: { MemoType: T, ...(format === null ? {} : { MemoFormat: format }), MemoData: hexText(data) } }];
const canonical0 = `{"revision":1,"specHash":"${h0}","specVersion":1}`;
const strictBadMemos = [
  { name: "no MemoFormat", memos: strictMemo(canonical0, null), problem: "format" },
  { name: "MemoFormat text/plain", memos: strictMemo(canonical0, hexText("text/plain")), problem: "format" },
  { name: "MemoFormat not hex", memos: strictMemo(canonical0, "application/json"), problem: "format" },
  { name: "duplicate revision key, last one wins in JSON.parse", memos: strictMemo(`{"revision":2,"revision":1,"specHash":"${h0}","specVersion":1}`), problem: "canonical" },
  { name: "duplicate specHash key", memos: strictMemo(`{"revision":1,"specHash":"${"0".repeat(64)}","specHash":"${h0}","specVersion":1}`), problem: "canonical" },
  { name: "spaces in the JSON", memos: strictMemo(`{"revision": 1, "specHash": "${h0}", "specVersion": 1}`), problem: "canonical" },
  { name: "keys out of order", memos: strictMemo(`{"specHash":"${h0}","specVersion":1,"revision":1}`), problem: "canonical" },
];

const rules = [
  { rule: "all", results: [true, true, true], meets: true },
  { rule: "all", results: [true, false, true], meets: false },
  { rule: { atLeast: 2 }, results: [true, false, true], meets: true },
  { rule: { atLeast: 2 }, results: [false, false, true], meets: false },
  { rule: { atLeast: 1 }, results: [false], meets: false },
].map((r) => {
  const got = meetsRule(r.rule as never, r.results.map((pass) => ({ pass })));
  if (got !== r.meets) throw new Error("rule vector mismatch");
  return r;
});

// A log as an oracle upgraded from 0.5.0 to 0.6.0 writes it: v1 entries, then v2.
const at = 1_763_800_000_000;
const condition = `A0258020${"AB".repeat(32)}810120`;
const sign = (body: VerdictBody): SignedVerdict => ({ ...body, signature: signPayload(body, oracle) });
const oldVerdict = sign({
  jobId: "job-phase5", verdict: "pass", checks: [{ type: "sha256-match", pass: true, detail: "sha256 matches the spec" }],
  evidenceHash: sha256Hex("old work"), condition, provider: provider.address, oracle: oracle.address, publicKey: oracle.publicKey, issuedAt: at,
});
const newVerdict = sign({
  jobId: "job-phase6", verdict: "pass",
  checks: [
    { type: "json-schema", pass: true, detail: "valid", criterion: "format" },
    { type: "size-range", pass: false, detail: "120 bytes (allowed 200 to 20000)", criterion: "useful" },
    { type: "contains-text", pass: true, detail: "the agreed text is in the deliverable", criterion: "useful" },
    { type: "max-latency", pass: true, detail: "delivered 4000 ms after funding (limit 300000 ms)", criterion: "on-time" },
  ],
  evidenceHash: sha256Hex("new work"), condition, provider: provider.address, oracle: oracle.address, publicKey: oracle.publicKey, issuedAt: at + 2,
  specHash: specs[0].specHash, specVersion: 1, specRevision: 1,
  criteria: [{ id: "format", kind: "objective", pass: true }, { id: "useful", kind: "subjective", pass: false }, { id: "on-time", kind: "objective", pass: true }],
  judged: "checks",
});
const unsignedVerdict = sign({
  jobId: "job-unsigned", verdict: "fail", checks: [{ type: "sha256-match", pass: false, detail: "no match" }],
  evidenceHash: sha256Hex("other work"), condition, provider: provider.address, oracle: oracle.address, publicKey: oracle.publicKey, issuedAt: at + 3,
  specHash: null, specVersion: null, specRevision: null, criteria: null, judged: "checks",
});
// Entries as 0.5.0 wrote them (v1): no spec fields, checks without criteria.
const v1Entry = (prev: { seq: number; hash: string }, verdict: SignedVerdict, when: number) => sealEntry({
  v: 1, seq: prev.seq + 1, prev: prev.hash, at: when, oracle: oracle.address, publicKey: oracle.publicKey, kind: "verdict",
  jobId: verdict.jobId, verdict: verdict.verdict, checks: verdict.checks.map((c) => ({ type: c.type, pass: c.pass })),
  evidenceHash: verdict.evidenceHash, condition: verdict.condition, provider: verdict.provider, issuedAt: verdict.issuedAt,
  verdictHash: verdictHash(verdict),
}, oracle);
const g = sealEntry({ v: 1, seq: 0, prev: GENESIS_PREV, at, oracle: oracle.address, publicKey: oracle.publicKey, kind: "genesis", legacyLog: null }, oracle);
const e1 = v1Entry(g, oldVerdict, at + 1);
const e2 = verdictEntry(oracle, e1, newVerdict, at + 2);
const e3 = verdictEntry(oracle, e2, unsignedVerdict, at + 3);
const mixedLog = [g, e1, e2, e3];
const laterOld = sign({ ...(({ signature: _s, ...b }) => b)(oldVerdict), jobId: "job-phase5-late", issuedAt: at + 4 });
const downgradeLog = [g, e1, e2, v1Entry(e2, laterOld, at + 4)];

writeFileSync("test/vectors/job-spec.json", `${JSON.stringify({
  note: "Signed job spec v1 vectors (EDR-016). Keys from fixed entropy; vector keys only, never funded. Regenerate with npx tsx test/vectors/make-job-spec-vectors.ts",
  parties: { client: { address: client.address, publicKey: client.publicKey }, provider: { address: provider.address, publicKey: provider.publicKey } },
  oracle: oracle.address,
  jcs: jcsCases, refusedJcs, specs, problems, signatures, memos, badMemos, strictBadMemos, rules,
  log: {
    mixed: mixedLog, downgrade: downgradeLog,
    verdicts: [oldVerdict, newVerdict, unsignedVerdict, laterOld], verdictHashes: [oldVerdict, newVerdict, unsignedVerdict, laterOld].map(verdictHash),
  },
}, null, 2)}\n`);
console.log("wrote test/vectors/job-spec.json");
