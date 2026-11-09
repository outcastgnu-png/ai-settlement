// Writes test/vectors/verdict-log.json: a verdict log chain, broken copies of
// it, anchor memos and account_tx rows, with what the TypeScript kit says about
// each, so the Python SDK can be checked against the same answers (EDR-014).
// Vector keys only (all-zero entropy), never funded.
// Run with: npx tsx test/vectors/make-verdict-log-vectors.ts
import { writeFileSync } from "node:fs";
import { Wallet, type ECDSA } from "xrpl";
import { canonicalJson, sha256Hex, signPayload } from "../../src/auth.js";
import type { SignedVerdict } from "../../src/oracle/server.js";
import {
  ANCHOR_MEMO_TYPE, anchorHistoryProblems, anchorMemos, anchorProblem, checkChain, findVerdict, genesisEntry, parseAnchorMemo,
  sealEntry, verdictEntry, verdictHash, verdictInLog, type LogEntry, type VerdictEntryBody,
} from "../../src/verdict-log.js";

const key = Wallet.fromEntropy(Buffer.from("00".repeat(16), "hex"), { algorithm: "ed25519" as ECDSA });
const other = Wallet.fromEntropy(Buffer.from("11".repeat(16), "hex"), { algorithm: "ed25519" as ECDSA });
const provider = Wallet.fromEntropy(Buffer.from("22".repeat(16), "hex"));
const anchorAccount = Wallet.fromEntropy(Buffer.from("33".repeat(16), "hex")).address;
const T0 = 1_762_500_000_000;

const verdict = (n: number, pass: boolean): SignedVerdict => {
  const body = {
    jobId: `6f7c1e9a-0000-4000-8000-00000000000${n}`, verdict: pass ? "pass" as const : "fail" as const,
    checks: [{ type: "sha256-match" as const, pass, detail: pass ? "sha256 matches the spec" : "sha256 dé… ✓ does not match" }],
    evidenceHash: sha256Hex(`work ${n}`), condition: `A0258020${sha256Hex(`c${n}`).toUpperCase()}810120`,
    provider: provider.address, oracle: key.address, publicKey: key.publicKey, issuedAt: T0 + n * 1000,
  };
  return { ...body, signature: signPayload(body, key) };
};

const verdicts = [verdict(1, true), verdict(2, false), verdict(3, true)];
const entries: LogEntry[] = [genesisEntry(key, { sha256: sha256Hex("old log\n"), bytes: 8 }, T0)];
for (const [i, v] of verdicts.entries()) entries.push(verdictEntry(key, entries[i], v, T0 + (i + 1) * 1000 + 1));

const clone = (): Record<string, unknown>[] => JSON.parse(JSON.stringify(entries));
const broken: { name: string; entries: unknown[] }[] = [];
{ const e = clone(); e[2].verdict = "pass"; broken.push({ name: "edited verdict", entries: e }); }
{ const e = clone(); e[1].at = (e[1].at as number) + 1; broken.push({ name: "edited timestamp", entries: e }); }
{ const e = clone(); e[3].hash = "00".repeat(32); broken.push({ name: "wrong stored hash", entries: e }); }
{ const e = clone(); broken.push({ name: "removed entry", entries: [e[0], e[1], e[3]] }); }
{ const e = clone(); broken.push({ name: "reordered", entries: [e[0], e[2], e[1], e[3]] }); }
{ const e = clone(); e[2].signature = "00".repeat(64); broken.push({ name: "bad signature", entries: e }); }
{
  const e = clone();
  e[2] = verdictEntry(other, entries[1], verdicts[1], T0 + 9) as unknown as Record<string, unknown>;
  broken.push({ name: "entry from another key", entries: e });
}
{ const e = clone(); e[0].kind = "verdict"; broken.push({ name: "no genesis", entries: e }); }
broken.push({ name: "empty", entries: [] });
broken.push({ name: "junk", entries: [null] });

const chainCases = [{ name: "good", entries, pinned: key.address }, ...broken.map((b) => ({ ...b, pinned: key.address })),
  { name: "pinned to another oracle", entries, pinned: other.address }]
  .map((c) => ({ ...c, expected: checkChain(c.entries, c.pinned) }));

const head = { seq: 2, hash: entries[2].hash };
const anchorCases = [
  { name: "matches", anchor: { v: 1, ...head, oracle: key.address } },
  { name: "different hash", anchor: { v: 1, seq: 2, hash: "ee".repeat(32), oracle: key.address } },
  { name: "beyond the log", anchor: { v: 1, seq: 7, hash: head.hash, oracle: key.address } },
  { name: "other oracle", anchor: { v: 1, ...head, oracle: other.address } },
  { name: "null entry at the anchored index (Gpno N27)", anchor: { v: 1, seq: 0, hash: entries[0].hash, oracle: key.address }, entries: [null] },
].map((c) => ({ ...c, expected: anchorProblem((c as { entries?: unknown[] }).entries ?? entries, c.anchor, key.address) }));

const hex = (t: string) => Buffer.from(t, "utf8").toString("hex").toUpperCase();
const memoWith = (data: string, type = ANCHOR_MEMO_TYPE) => [{ Memo: { MemoType: hex(type), MemoData: hex(data) } }];
const memoCases = [
  { name: "good", memos: anchorMemos(head, key.address) },
  { name: "other memo type", memos: memoWith(canonicalJson({ v: 1, ...head, oracle: key.address }), "something-else") },
  { name: "not json", memos: memoWith("{nope") },
  { name: "extra field", memos: memoWith(canonicalJson({ v: 1, ...head, oracle: key.address, x: 1 })) },
  { name: "uppercase hash", memos: memoWith(canonicalJson({ v: 1, seq: 2, hash: head.hash.toUpperCase(), oracle: key.address })) },
  { name: "negative seq", memos: memoWith(canonicalJson({ v: 1, seq: -1, hash: head.hash, oracle: key.address })) },
  { name: "string seq", memos: memoWith(canonicalJson({ v: 1, seq: "2", hash: head.hash, oracle: key.address })) },
  { name: "version 2", memos: memoWith(canonicalJson({ v: 2, ...head, oracle: key.address })) },
  { name: "no memos", memos: null },
  { name: "odd-length MemoType (Gpno N28)", memos: [{ Memo: { ...anchorMemos(head, key.address)[0].Memo, MemoType: `${hex(ANCHOR_MEMO_TYPE)}0` } }] },
  { name: "odd-length MemoData", memos: [{ Memo: { ...anchorMemos(head, key.address)[0].Memo, MemoData: `${anchorMemos(head, key.address)[0].Memo.MemoData}0` } }] },
].map((c) => ({ ...c, expected: parseAnchorMemo(c.memos) }));

const row = (n: number, over: { validated?: boolean; result?: string; type?: string; account?: string; memos?: unknown }) => ({
  hash: sha256Hex(`anchor tx ${n}`).toUpperCase(), ledger_index: 9_000_000 - n, validated: over.validated ?? true,
  meta: { TransactionResult: over.result ?? "tesSUCCESS" },
  tx_json: { TransactionType: over.type ?? "AccountSet", Account: over.account ?? anchorAccount, Memos: over.memos ?? anchorMemos(head, key.address) },
});
// Newest first, as account_tx returns them with forward: false. The first usable one is row 5.
const accountTx = [
  row(0, { validated: false }), row(1, { result: "tecNO_PERMISSION" }), row(2, { type: "Payment" }),
  row(3, { account: provider.address }), row(4, { memos: anchorMemos(head, other.address) }),
  row(5, { memos: anchorMemos({ seq: 1, hash: entries[1].hash }, key.address) }), row(6, {}),
];

// Gpno N26: the verdict key signs an entry that names the fail verdict's hash but says "pass" in public.
const failV = verdicts[1];
const { signature: _s, hash: _h, ...body2 } = entries[2] as LogEntry & VerdictEntryBody;
const lie = sealEntry({ ...body2, verdict: "pass", checks: [{ type: "sha256-match", pass: true }] } as VerdictEntryBody, key);
const lyingLog = [entries[0], entries[1], lie];
const findCases = [
  { name: "honest log", entries, verdict: failV },
  { name: "public summary lies (Gpno N26)", entries: lyingLog, verdict: failV },
  { name: "verdict not logged", entries, verdict: { ...failV, issuedAt: 1 } },
].map((c) => ({ ...c, expected: { seq: findVerdict(c.entries, c.verdict).entry?.seq ?? null, mismatch: findVerdict(c.entries, c.verdict).mismatch } }));

// Gpno N29: every anchor must agree with the log, and only one genesis may be anchored.
const memo = (seq: number, hash: string) => ({ v: 1, seq, hash, oracle: key.address });
const historyCases = [
  { name: "all agree", anchors: [memo(3, entries[3].hash), memo(1, entries[1].hash), memo(0, entries[0].hash)] },
  { name: "an older anchor disagrees", anchors: [memo(3, entries[3].hash), memo(2, "ab".repeat(32))] },
  { name: "two geneses", anchors: [memo(2, entries[2].hash), memo(0, "cd".repeat(32)), memo(0, entries[0].hash)] },
  { name: "older anchor beyond the log", anchors: [memo(1, entries[1].hash), memo(9, "ab".repeat(32))] },
].map((c) => ({ ...c, expected: anchorHistoryProblems(entries, c.anchors, key.address) }));

const out = {
  note: "Generated by test/vectors/make-verdict-log-vectors.ts. Vector keys only, never funded.",
  oracle: key.address, anchorAccount, entries, verdicts, verdictHashes: verdicts.map(verdictHash),
  verdictInLog: verdicts.map((v) => verdictInLog(entries, v)?.seq ?? null).concat(verdictInLog(entries, { ...verdicts[0], issuedAt: 1 })?.seq ?? null),
  chainCases, anchorCases, memoCases, accountTx, expectedLatestAnchorRow: 5,
  expectedAnchorRows: accountTx.map((_r, i) => i).filter((i) => i >= 5), findCases, historyCases,
};
writeFileSync(new URL("./verdict-log.json", import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote a ${entries.length}-entry chain, ${chainCases.length} chain cases, ${anchorCases.length} anchor cases, ${memoCases.length} memo cases`);
