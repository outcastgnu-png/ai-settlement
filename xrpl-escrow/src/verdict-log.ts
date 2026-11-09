// The oracle's public verdict log (EDR-014). A JSONL file of entries, each
// holding a sequence number, the hash of the entry before it, and a signature
// by the oracle's verdict key, so dropping, reordering or editing an entry
// breaks the chain. The first entry is a genesis entry that names the hash of
// the older, unchained verdicts.jsonl, if there was one; that file is kept as
// it was and no longer written to.
//
// An entry holds hashes and outcomes only: the job id, condition, provider,
// each check's type and pass/fail, the evidence hash, and the hash of the full
// signed verdict the provider received. Check details are left out, because a
// detail can quote the deliverable (a JSON Schema error names the failing
// path). A party holding its own signed verdict can still find it in the log
// by that hash (`findVerdict`), and every public field of the entry must agree
// with that verdict (Gpno N26).
//
// The functions here are pure: the oracle uses them to write the log, and the
// SDKs use them to check a copy. The Python SDK implements the same rules
// (xrpl_escrow/verdict_log.py) and is checked against test/vectors/verdict-log.json.
import { canonicalJson, sha256Hex, signPayload, verifyPayload } from "./auth.js";
import type { Wallet } from "xrpl";
import type { SignedVerdict } from "./oracle/server.js";

export const LOG_VERSION = 1;
export const GENESIS_PREV = "0".repeat(64);
/** Memo type of an anchor transaction, as text (it is written to the ledger as hex). */
export const ANCHOR_MEMO_TYPE = "xrpl-escrow/verdict-log-head";

interface EntryBase {
  v: number;
  seq: number;
  prev: string; // hash of the entry before, GENESIS_PREV for the first
  at: number; // unix ms when the oracle wrote the entry
  oracle: string; // verdict key address
  publicKey: string;
}

export interface GenesisBody extends EntryBase {
  kind: "genesis";
  /** The older unchained log, if one existed when the chain started. */
  legacyLog: { sha256: string; bytes: number } | null;
}

export interface VerdictEntryBody extends EntryBase {
  kind: "verdict";
  jobId: string;
  verdict: "pass" | "fail";
  checks: { type: string; pass: boolean }[];
  evidenceHash: string;
  condition: string;
  provider: string;
  issuedAt: number;
  verdictHash: string; // sha256 of the canonical JSON of the full signed verdict
}

export type EntryBody = GenesisBody | VerdictEntryBody;
export type LogEntry = EntryBody & { signature: string; hash: string };
export type VerdictLogEntry = VerdictEntryBody & { signature: string; hash: string };

export interface LogHead {
  seq: number;
  hash: string;
}

/** What an anchor transaction's memo says. */
export interface AnchorMemo {
  v: number;
  seq: number;
  hash: string;
  oracle: string;
}

/** An anchor found on a validated ledger. */
export interface Anchor extends AnchorMemo {
  txHash: string;
  ledgerIndex: number;
  account: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** The hash that links an entry into the chain: sha256 of its canonical JSON, signature included. */
export const entryHash = (entry: EntryBody & { signature: string }) => sha256Hex(canonicalJson(entry));

/** sha256 of the canonical JSON of a full signed verdict, as written into its log entry. */
export const verdictHash = (verdict: SignedVerdict) => sha256Hex(canonicalJson(verdict));

const strip = <T extends { hash?: string; signature?: string }>(e: T) => {
  const { hash: _h, signature: _s, ...body } = e;
  return body;
};

/** Sign a body and work out its hash. */
export function sealEntry(body: EntryBody, key: Wallet): LogEntry {
  const signature = signPayload(body, key);
  return { ...body, signature, hash: entryHash({ ...body, signature }) } as LogEntry;
}

export function genesisEntry(key: Wallet, legacyLog: GenesisBody["legacyLog"], at = Date.now()): LogEntry {
  return sealEntry({
    v: LOG_VERSION, seq: 0, prev: GENESIS_PREV, at, oracle: key.address, publicKey: key.publicKey, kind: "genesis", legacyLog,
  }, key);
}

export function verdictEntry(key: Wallet, previous: LogHead, verdict: SignedVerdict, at = Date.now()): LogEntry {
  return sealEntry({
    v: LOG_VERSION, seq: previous.seq + 1, prev: previous.hash, at, oracle: key.address, publicKey: key.publicKey,
    kind: "verdict", jobId: verdict.jobId, verdict: verdict.verdict,
    checks: verdict.checks.map((c) => ({ type: c.type, pass: c.pass })),
    evidenceHash: verdict.evidenceHash, condition: verdict.condition, provider: verdict.provider,
    issuedAt: verdict.issuedAt, verdictHash: verdictHash(verdict),
  }, key);
}

export interface ChainCheck {
  ok: boolean;
  /** The first thing that is wrong, with the entry's position. Null when ok. */
  problem: string | null;
  head: LogHead | null;
  count: number;
}

/**
 * Check a whole log from its genesis entry: sequence numbers count up from 0,
 * each entry names the hash of the one before, each hash is right, and every
 * entry is signed by the pinned `oracleAddress`. Stops at the first problem.
 */
export function checkChain(entries: unknown[], oracleAddress: string): ChainCheck {
  const fail = (problem: string, i: number): ChainCheck => ({ ok: false, problem: `entry ${i}: ${problem}`, head: null, count: entries.length });
  if (!oracleAddress) return { ok: false, problem: "no pinned oracle address", head: null, count: entries.length };
  if (entries.length === 0) return { ok: false, problem: "the log is empty", head: null, count: 0 };
  let prev = GENESIS_PREV;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as Partial<LogEntry> | null;
    if (!e || typeof e !== "object" || Array.isArray(e)) return fail("not an object", i);
    if (e.v !== LOG_VERSION) return fail(`unknown log version ${String(e.v)}`, i);
    if (e.seq !== i) return fail(`sequence number is ${String(e.seq)}, expected ${i}`, i);
    if (e.prev !== prev) return fail("does not link to the entry before it", i);
    if (i === 0 ? e.kind !== "genesis" : e.kind !== "verdict") return fail(`kind ${String(e.kind)} is not allowed here`, i);
    if (e.oracle !== oracleAddress) return fail(`signed by ${String(e.oracle)}, not the pinned oracle ${oracleAddress}`, i);
    if (typeof e.signature !== "string" || typeof e.publicKey !== "string") return fail("has no signature", i);
    const body = strip(e);
    if (!verifyPayload(body, e.signature, e.publicKey, oracleAddress)) return fail("signature does not verify", i);
    if (typeof e.hash !== "string" || e.hash !== entryHash({ ...(body as EntryBody), signature: e.signature })) {
      return fail("hash does not match its content", i);
    }
    prev = e.hash;
  }
  return { ok: true, problem: null, head: { seq: entries.length - 1, hash: prev }, count: entries.length };
}

/**
 * Compare a log with an anchor read from the ledger. The anchored entry must
 * be in the log with exactly the anchored hash; a log shorter than the anchor
 * has lost entries. Returns null when they agree, otherwise what is wrong.
 */
export function anchorProblem(entries: readonly unknown[], anchor: AnchorMemo, oracleAddress: string): string | null {
  if (anchor.oracle !== oracleAddress) return `the anchor names oracle ${anchor.oracle}, not the pinned ${oracleAddress}`;
  if (anchor.seq >= entries.length) return `the anchor covers entry ${anchor.seq}, but the log has only ${entries.length} entries`;
  const entry = entries[anchor.seq] as { hash?: unknown } | null;
  // A log that fails checkChain can still reach here; a missing entry is a problem, not a crash (Gpno N27).
  if (!entry || typeof entry !== "object") return `entry ${anchor.seq} is missing or not an object`;
  if (entry.hash !== anchor.hash) return `entry ${anchor.seq} has hash ${String(entry.hash)}, the ledger anchored ${anchor.hash}`;
  return null;
}

/**
 * Compare a log with every anchor found on the ledger, not only the newest
 * (Gpno N29). Each anchor must match the log at its sequence number, so an
 * older anchor of an entry that has since been rewritten, or of another chain
 * under the same verdict key, is a problem. More than one anchored genesis
 * means the operator has published more than one chain. Returns the problems,
 * newest anchor first.
 */
export function anchorHistoryProblems(entries: readonly unknown[], anchors: AnchorMemo[], oracleAddress: string): string[] {
  const problems: string[] = [];
  const geneses = new Set(anchors.filter((a) => a.oracle === oracleAddress && a.seq === 0).map((a) => a.hash));
  if (geneses.size > 1) problems.push(`the ledger has ${geneses.size} different genesis entries anchored for this oracle: it has published more than one log`);
  for (const a of anchors) {
    const p = anchorProblem(entries, a, oracleAddress);
    if (p && !problems.includes(p)) problems.push(p);
  }
  return problems;
}

/**
 * Where a log entry disagrees with the signed verdict it names, or null when
 * every public field matches (Gpno N26). The entry's `verdictHash` alone is not
 * enough: a signed entry could pair the hash of a fail with a public "pass".
 */
export function entryMismatch(entry: LogEntry, verdict: SignedVerdict): string | null {
  if (entry.kind !== "verdict") return "not a verdict entry";
  if (entry.verdictHash !== verdictHash(verdict)) return "verdictHash";
  const checks = verdict.checks.map((c) => ({ type: c.type, pass: c.pass }));
  const fields: [string, unknown, unknown][] = [
    ["jobId", entry.jobId, verdict.jobId], ["verdict", entry.verdict, verdict.verdict],
    ["evidenceHash", entry.evidenceHash, verdict.evidenceHash], ["condition", entry.condition, verdict.condition],
    ["provider", entry.provider, verdict.provider], ["issuedAt", entry.issuedAt, verdict.issuedAt],
    ["checks", canonicalJson(entry.checks), canonicalJson(checks)],
  ];
  for (const [name, a, b] of fields) if (a !== b) return name;
  return null;
}

/**
 * The log entry for this signed verdict, if the log has it with every public
 * field matching the verdict. An entry that carries the verdict's hash but says
 * something else in public is returned as `mismatch`.
 */
export function findVerdict(entries: LogEntry[], verdict: SignedVerdict): { entry: LogEntry | null; mismatch: string | null } {
  const want = verdictHash(verdict);
  const candidate = entries.find((e) => e && e.kind === "verdict" && e.verdictHash === want) ?? null;
  if (!candidate) return { entry: null, mismatch: null };
  const mismatch = entryMismatch(candidate, verdict);
  return mismatch ? { entry: null, mismatch: `entry ${candidate.seq} names this verdict but its ${mismatch} differs from it` } : { entry: candidate, mismatch: null };
}

/** The log entry for this signed verdict, only if every public field matches it. */
export function verdictInLog(entries: LogEntry[], verdict: SignedVerdict): LogEntry | null {
  return findVerdict(entries, verdict).entry;
}

const hexText = (text: string) => Buffer.from(text, "utf8").toString("hex").toUpperCase();
const textOfHex = (hex: string) => Buffer.from(hex, "hex").toString("utf8");

/** The Memos field of an anchor transaction for this head. */
export function anchorMemos(head: LogHead, oracle: string) {
  const memo: AnchorMemo = { v: LOG_VERSION, seq: head.seq, hash: head.hash, oracle };
  return [{ Memo: { MemoType: hexText(ANCHOR_MEMO_TYPE), MemoFormat: hexText("application/json"), MemoData: hexText(canonicalJson(memo)) } }];
}

/**
 * Read an anchor memo out of a transaction's Memos, or null if it has none.
 * Ledger data is data: only the exact memo type is looked at, and its JSON
 * must have exactly the expected fields and types.
 */
export function parseAnchorMemo(memos: unknown): AnchorMemo | null {
  if (!Array.isArray(memos)) return null;
  for (const wrapper of memos) {
    const m = (wrapper as { Memo?: { MemoType?: unknown; MemoData?: unknown } } | null)?.Memo;
    if (!m || typeof m.MemoType !== "string" || typeof m.MemoData !== "string") continue;
    // Whole bytes only: Buffer.from(hex) would drop an odd trailing nibble (Gpno N28).
    if (!/^([0-9A-Fa-f]{2})*$/.test(m.MemoType) || textOfHex(m.MemoType) !== ANCHOR_MEMO_TYPE) continue;
    if (!/^([0-9A-Fa-f]{2}){1,1024}$/.test(m.MemoData)) return null;
    let data: unknown;
    try {
      data = JSON.parse(textOfHex(m.MemoData));
    } catch {
      return null;
    }
    const d = data as Partial<AnchorMemo>;
    if (!d || typeof d !== "object" || Object.keys(d).sort().join(",") !== "hash,oracle,seq,v") return null;
    if (d.v !== LOG_VERSION || !Number.isSafeInteger(d.seq) || (d.seq as number) < 0) return null;
    if (typeof d.hash !== "string" || !HEX64.test(d.hash) || typeof d.oracle !== "string") return null;
    return { v: d.v, seq: d.seq as number, hash: d.hash, oracle: d.oracle };
  }
  return null;
}
