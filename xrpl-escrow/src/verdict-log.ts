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
// Since Phase 6 (EDR-016, entry version 2) a verdict entry also carries the
// hash, version and revision of the signed job spec the oracle judged, and each
// criterion's pass or fail. Phase 4 and 5 logs (version 1 entries) still verify.
//
// The functions here are pure: the oracle uses them to write the log, and the
// SDKs use them to check a copy. The Python SDK implements the same rules
// (xrpl_escrow/verdict_log.py) and is checked against test/vectors/verdict-log.json.
import { canonicalJson, sha256Hex, signPayload, verifyPayload } from "./auth.js";
import type { Wallet } from "xrpl";
import type { SignedVerdict } from "./oracle/server.js";

/**
 * Entry format version. 1: Phase 4 and 5 entries. 2 (Phase 6, EDR-016): verdict
 * entries also carry the judged spec's hash, version and revision, each
 * criterion's pass or fail, and each check's criterion. A log may hold v1 entries
 * followed by v2 entries (an oracle upgraded in place), never a v1 after a v2.
 */
export const LOG_VERSION = 2;
export const LOG_VERSIONS = [1, 2];
/** Version of the anchor memo on the ledger; unchanged since Phase 4. */
export const ANCHOR_VERSION = 1;
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
  checks: { type: string; pass: boolean; criterion?: string }[];
  evidenceHash: string;
  condition: string;
  provider: string;
  issuedAt: number;
  verdictHash: string; // sha256 of the canonical JSON of the full signed verdict
  /** v2 (EDR-016): the judged spec, null for an unsigned spec. */
  specHash?: string | null;
  specVersion?: number | null;
  specRevision?: number | null;
  criteria?: { id: string; kind: string; pass: boolean }[] | null;
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

/** The public form of a verdict's check results in an entry of version `v`. */
const publicChecks = (v: number, checks: SignedVerdict["checks"]) =>
  checks.map((c) => (v >= 2 && c.criterion !== undefined ? { type: c.type, pass: c.pass, criterion: c.criterion } : { type: c.type, pass: c.pass }));

/** The public form of a verdict's spec fields in a v2 entry. A verdict from before 0.6.0 has none: all null. */
const publicSpec = (verdict: SignedVerdict) => ({
  specHash: verdict.specHash ?? null, specVersion: verdict.specVersion ?? null, specRevision: verdict.specRevision ?? null,
  criteria: verdict.criteria ? verdict.criteria.map((c) => ({ id: c.id, kind: c.kind, pass: c.pass })) : null,
});

export function verdictEntry(key: Wallet, previous: LogHead, verdict: SignedVerdict, at = Date.now()): LogEntry {
  return sealEntry({
    v: LOG_VERSION, seq: previous.seq + 1, prev: previous.hash, at, oracle: key.address, publicKey: key.publicKey,
    kind: "verdict", jobId: verdict.jobId, verdict: verdict.verdict,
    checks: publicChecks(LOG_VERSION, verdict.checks),
    evidenceHash: verdict.evidenceHash, condition: verdict.condition, provider: verdict.provider,
    issuedAt: verdict.issuedAt, verdictHash: verdictHash(verdict), ...publicSpec(verdict),
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
  let version = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] as Partial<LogEntry> | null;
    if (!e || typeof e !== "object" || Array.isArray(e)) return fail("not an object", i);
    if (!LOG_VERSIONS.includes(e.v as number)) return fail(`unknown log version ${String(e.v)}`, i);
    if ((e.v as number) < version) return fail(`a version ${String(e.v)} entry after a version ${version} entry`, i);
    version = e.v as number;
    if (e.v === 2 && e.kind === "verdict") {
      const shape = v2SpecProblem(e as Partial<VerdictEntryBody>);
      if (shape) return fail(shape, i);
    }
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

/** The spec fields of a v2 verdict entry must all be there, null or well formed. */
function v2SpecProblem(e: Partial<VerdictEntryBody>): string | null {
  for (const k of ["specHash", "specVersion", "specRevision", "criteria"] as const) if (!(k in e)) return `a version 2 verdict entry has no ${k}`;
  if (e.specHash === null) {
    return e.specVersion === null && e.specRevision === null && e.criteria === null ? null : "an unsigned-spec entry has spec fields";
  }
  if (typeof e.specHash !== "string" || !HEX64.test(e.specHash)) return "specHash is not a sha256 hex string";
  if (!Number.isSafeInteger(e.specVersion) || !Number.isSafeInteger(e.specRevision)) return "specVersion or specRevision is not a whole number";
  if (!Array.isArray(e.criteria)) return "criteria is not a list";
  return null;
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
  const checks = publicChecks(entry.v, verdict.checks);
  const fields: [string, unknown, unknown][] = [
    ["jobId", entry.jobId, verdict.jobId], ["verdict", entry.verdict, verdict.verdict],
    ["evidenceHash", entry.evidenceHash, verdict.evidenceHash], ["condition", entry.condition, verdict.condition],
    ["provider", entry.provider, verdict.provider], ["issuedAt", entry.issuedAt, verdict.issuedAt],
    ["checks", canonicalJson(entry.checks), canonicalJson(checks)],
  ];
  if (entry.v >= 2) {
    const want = publicSpec(verdict);
    for (const k of ["specHash", "specVersion", "specRevision", "criteria"] as const) {
      fields.push([k, canonicalJson(entry[k] ?? null), canonicalJson(want[k])]);
    }
  } else if (verdict.specHash !== undefined || verdict.criteria !== undefined) {
    return "specHash"; // a v1 entry can't hold a Phase 6 verdict's spec fields
  }
  for (const [name, a, b] of fields) if (a !== b) return name;
  return null;
}

/**
 * The log entry for this signed verdict, if the log has it with every public
 * field matching the verdict. Every entry that carries the verdict's hash is
 * compared, not just the first: a later line that names it but says something
 * else in public is returned as `mismatch` (Gpno N37).
 */
export function findVerdict(entries: LogEntry[], verdict: SignedVerdict): { entry: LogEntry | null; mismatch: string | null } {
  const want = verdictHash(verdict);
  let found: LogEntry | null = null;
  for (const e of entries) {
    if (!e || e.kind !== "verdict" || e.verdictHash !== want) continue;
    const mismatch = entryMismatch(e, verdict);
    if (mismatch) return { entry: null, mismatch: `entry ${e.seq} names this verdict but its ${mismatch} differs from it` };
    found ??= e;
  }
  return { entry: found, mismatch: null };
}

/**
 * A job has one verdict, and the oracle writes one entry for it (Gpno N25), so
 * a log with two verdict entries for the same job is wrong whatever they say
 * (Gpno N37). One problem per job, naming its entries.
 */
export function duplicateJobProblems(entries: readonly unknown[]): string[] {
  const seqs = new Map<string, number[]>();
  for (const e of entries) {
    const v = e as Partial<VerdictLogEntry> | null;
    if (!v || typeof v !== "object" || v.kind !== "verdict" || typeof v.jobId !== "string") continue;
    const list = seqs.get(v.jobId) ?? [];
    list.push(v.seq as number);
    seqs.set(v.jobId, list);
  }
  return [...seqs].filter(([, s]) => s.length > 1)
    .map(([jobId, s]) => `job ${jobId} has ${s.length} verdict entries (${s.join(", ")}); a job has one verdict`);
}

/** The log entry for this signed verdict, only if every public field matches it. */
export function verdictInLog(entries: LogEntry[], verdict: SignedVerdict): LogEntry | null {
  return findVerdict(entries, verdict).entry;
}

const hexText = (text: string) => Buffer.from(text, "utf8").toString("hex").toUpperCase();
const textOfHex = (hex: string) => Buffer.from(hex, "hex").toString("utf8");

/** The Memos field of an anchor transaction for this head. */
export function anchorMemos(head: LogHead, oracle: string) {
  const memo: AnchorMemo = { v: ANCHOR_VERSION, seq: head.seq, hash: head.hash, oracle };
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
    if (d.v !== ANCHOR_VERSION || !Number.isSafeInteger(d.seq) || (d.seq as number) < 0) return null;
    if (typeof d.hash !== "string" || !HEX64.test(d.hash) || typeof d.oracle !== "string") return null;
    return { v: d.v, seq: d.seq as number, hash: d.hash, oracle: d.oracle };
  }
  return null;
}
