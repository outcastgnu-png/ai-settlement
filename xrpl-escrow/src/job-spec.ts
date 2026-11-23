// Signed job spec, version 1 (EDR-016, Phase 6).
//
// A job spec v1 is a JSON document that states the acceptance criteria of one
// job and the machine checks that decide each criterion. The client writes it,
// the provider accepts it by signing its hash, the client signs it too, and the
// hash goes on the ledger in a memo on the EscrowCreate. Every oracle checks
// that memo before it verifies, and puts the hash in its signed verdict and log.
//
//   {
//     "specVersion": 1,                 the format of this document
//     "revision": 1,                    1, 2, 3...: a change is a new revision, signed again
//     "nonce": "<32 hex>",              makes two otherwise equal jobs' hashes differ
//     "title": "...",
//     "client": "r...", "provider": "r...", "priceDrops": "10000000", "slaSeconds": 300,
//     "criteria": [
//       { "id": "c1", "statement": "plain words", "kind": "objective" | "subjective",
//         "checks": [ ...the existing check types, plus size-range and contains-text... ] }
//     ],
//     "rule": "all" | { "atLeast": n }  over the criteria; a criterion passes when all its checks pass
//   }
//
// The spec hash is SHA-256 over the RFC 8785 (JCS) canonical form: keys sorted
// by UTF-16 code unit, no spaces, strings escaped as ECMAScript does. A v1 spec
// holds whole numbers only (no fractions or exponents), so the TypeScript and
// Python SDKs can't format a number differently; both check the shared vectors
// in test/vectors/job-spec.json.
//
// The kit judges the checks, never the statement. A subjective criterion ("useful
// research") is accepted only with at least one check that both parties sign as
// its stand-in; without one the spec is refused before any XRP moves.
//
// A spec is data. It is validated and hashed, and its checks are run by the
// oracle's fixed check code; nothing in it is ever executed or followed.
import { randomBytes } from "node:crypto";
import { deriveAddress, sign, verify } from "ripple-keypairs";
import { isValidClassicAddress, type Wallet } from "xrpl";
import { sha256Hex } from "./auth.js";
import { CHECK_TYPES, MAX_CHECKS, checkListProblem, checkProblem, isObject, type CheckSpec } from "./check-spec.js";

export const SPEC_VERSION = 1;
/** Memo type on the EscrowCreate that carries the spec hash, as text (written to the ledger as hex). */
export const SPEC_MEMO_TYPE = "xrpl-escrow/job-spec";
/** What a party signs: this prefix, the format version and the spec hash. */
export const SPEC_SIGN_PREFIX = "xrpl-escrow/job-spec";
export const MAX_CRITERIA = 8;
export const MAX_SPEC_BYTES = 32_768;
export const MAX_REVISION = 1000;

export type CriterionKind = "objective" | "subjective";
export type SpecRule = "all" | { atLeast: number };

export interface Criterion {
  id: string;
  statement: string;
  kind: CriterionKind;
  checks: CheckSpec[];
}

export interface JobSpecV1 {
  specVersion: 1;
  revision: number;
  nonce: string;
  title: string;
  client: string;
  provider: string;
  priceDrops: string;
  slaSeconds: number;
  criteria: Criterion[];
  rule: SpecRule;
}

/** One party's signature over a spec hash. */
export interface SpecSignature {
  address: string;
  publicKey: string;
  signature: string;
}

/** What the EscrowCreate memo says. */
export interface SpecMemo {
  specHash: string;
  specVersion: number;
  revision: number;
}

/** A criterion's outcome in a verdict: it passes when all of its checks pass. */
export interface CriterionResult {
  id: string;
  kind: CriterionKind;
  pass: boolean;
}

const SPEC_KEYS = ["specVersion", "revision", "nonce", "title", "client", "provider", "priceDrops", "slaSeconds", "criteria", "rule"];
const CRITERION_KEYS = ["id", "statement", "kind", "checks"];
const HEX64 = /^[0-9a-f]{64}$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const CRITERION_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** True for a job spec v1 (as opposed to the Phase 1 to 5 `{title?, checks}` shape). */
export const isSpecV1 = (spec: unknown): spec is JobSpecV1 => isObject(spec) && spec.specVersion !== undefined;

/**
 * RFC 8785 canonical JSON. Throws on anything the two SDKs could encode
 * differently: a number that is not a safe whole number, a string with a lone
 * surrogate, a value that is not JSON (undefined, a function, NaN).
 */
export function jcs(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`a job spec holds whole numbers only, not ${value}`);
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (typeof value === "string") {
    if (LONE_SURROGATE.test(value)) throw new Error("a job spec string must not hold a lone surrogate");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  if (isObject(value)) {
    const keys = Object.keys(value).sort(); // UTF-16 code unit order, as RFC 8785 asks
    return `{${keys.map((k) => {
      if (value[k] === undefined) throw new Error(`a job spec field (${k}) is undefined`);
      return `${jcs(k)}:${jcs(value[k])}`;
    }).join(",")}}`;
  }
  throw new Error(`a job spec cannot hold a ${typeof value}`);
}

/** SHA-256 of the canonical form, lowercase hex. */
export const specHash = (spec: JobSpecV1) => sha256Hex(jcs(spec));

const hexOf = (text: string) => Buffer.from(text, "utf8").toString("hex").toUpperCase();
const signMessage = (hash: string) => hexOf(`${SPEC_SIGN_PREFIX}|v${SPEC_VERSION}|${hash}`);

/** Sign a spec hash with an XRPL wallet. The signer must have read the spec the hash is of. */
export function signSpecHash(hash: string, wallet: Wallet): SpecSignature {
  if (!HEX64.test(hash)) throw new Error("a spec hash is 64 lowercase hex characters");
  return { address: wallet.address, publicKey: wallet.publicKey, signature: sign(signMessage(hash), wallet.privateKey) };
}

/** True when `sig` is `address`'s signature over `hash`. */
export function verifySpecSignature(hash: string, sig: unknown, address: string): boolean {
  const s = sig as Partial<SpecSignature> | null;
  if (!s || typeof s !== "object" || typeof s.publicKey !== "string" || typeof s.signature !== "string") return false;
  if (s.address !== address || !HEX64.test(hash)) return false;
  try {
    return deriveAddress(s.publicKey) === address && verify(signMessage(hash), s.signature, s.publicKey);
  } catch {
    return false;
  }
}

/** Both parties' signatures over the spec's hash check: what must hold before any XRP is locked. Returns the problems. */
export function agreementProblems(spec: JobSpecV1, sigs: { client?: unknown; provider?: unknown }): string[] {
  const hash = specHash(spec);
  const problems: string[] = [];
  if (!verifySpecSignature(hash, sigs.client, spec.client)) problems.push(`the client (${spec.client}) has not signed spec ${hash}`);
  if (!verifySpecSignature(hash, sigs.provider, spec.provider)) problems.push(`the provider (${spec.provider}) has not signed spec ${hash}`);
  return problems;
}

/**
 * What is wrong with a job spec v1, or null if it is acceptable. Applied by the
 * registry when a spec arrives and by the SDK before it creates or signs one.
 */
export function specProblem(spec: unknown): string | null {
  if (!isObject(spec)) return "the job spec must be a JSON object";
  if (spec.specVersion !== SPEC_VERSION) return `specVersion must be ${SPEC_VERSION}`;
  const extra = Object.keys(spec).filter((k) => !SPEC_KEYS.includes(k));
  if (extra.length) return `the job spec has unknown fields: ${extra.join(", ")}`;
  const missing = SPEC_KEYS.filter((k) => spec[k] === undefined);
  if (missing.length) return `the job spec is missing: ${missing.join(", ")}`;
  if (!Number.isSafeInteger(spec.revision) || (spec.revision as number) < 1 || (spec.revision as number) > MAX_REVISION) return `revision must be a whole number from 1 to ${MAX_REVISION}`;
  if (typeof spec.nonce !== "string" || !/^[0-9a-f]{32}$/.test(spec.nonce)) return "nonce must be 32 lowercase hex characters";
  if (typeof spec.title !== "string" || spec.title.length === 0 || spec.title.length > 200) return "title must be 1 to 200 characters";
  if (typeof spec.client !== "string" || !isValidClassicAddress(spec.client)) return "client must be an XRPL address";
  if (typeof spec.provider !== "string" || !isValidClassicAddress(spec.provider)) return "provider must be an XRPL address";
  if (spec.client === spec.provider) return "client and provider must differ";
  if (typeof spec.priceDrops !== "string" || !/^[1-9][0-9]{0,16}$/.test(spec.priceDrops)) return "priceDrops must be a positive drop string";
  if (!Number.isInteger(spec.slaSeconds) || (spec.slaSeconds as number) < 30 || (spec.slaSeconds as number) > 86_400) return "slaSeconds must be an integer from 30 to 86400";
  const criteria = spec.criteria;
  if (!Array.isArray(criteria) || criteria.length === 0 || criteria.length > MAX_CRITERIA) return `criteria must list 1 to ${MAX_CRITERIA} criteria`;
  const ids = new Set<string>();
  const allChecks: unknown[] = [];
  for (const [i, c] of criteria.entries()) {
    const at = `criterion ${i + 1}`;
    if (!isObject(c)) return `${at} must be an object`;
    if (!Object.keys(c).every((k) => CRITERION_KEYS.includes(k))) return `${at} may hold only ${CRITERION_KEYS.join(", ")}`;
    if (typeof c.id !== "string" || !CRITERION_ID.test(c.id)) return `${at}: id must be 1 to 32 of a-z, 0-9 and -, starting with a letter or digit`;
    if (ids.has(c.id)) return `${at}: id ${c.id} is used twice`;
    ids.add(c.id);
    if (typeof c.statement !== "string" || c.statement.trim().length === 0 || c.statement.length > 500) return `${at} (${c.id}): statement must be 1 to 500 characters`;
    if (c.kind !== "objective" && c.kind !== "subjective") return `${at} (${c.id}): kind must be objective or subjective`;
    if (!Array.isArray(c.checks)) return `${at} (${c.id}): checks must be a list`;
    if (c.checks.length === 0) {
      return c.kind === "subjective"
        ? `criterion ${c.id} is subjective ("${c.statement}") and names no check. This kit can't judge that statement: add at least one `
          + "check that both parties accept as its stand-in (a json-schema with required sections, a size-range, contains-text, "
          + "or a source transaction), or leave the criterion out"
        : `criterion ${c.id} is objective but names no check; add the check that decides it`;
    }
    for (const check of c.checks) {
      const problem = checkProblem(check);
      if (problem) return `${at} (${c.id}): ${problem}`;
    }
    allChecks.push(...c.checks);
  }
  const listProblem = checkListProblem(allChecks, "the criteria together");
  if (listProblem) return listProblem;
  if (allChecks.length > MAX_CHECKS) return `the criteria together may hold at most ${MAX_CHECKS} checks`;
  const rule = spec.rule;
  if (rule !== "all") {
    if (!isObject(rule) || Object.keys(rule).join() !== "atLeast" || !Number.isSafeInteger(rule.atLeast)
      || (rule.atLeast as number) < 1 || (rule.atLeast as number) > criteria.length) {
      return `rule must be "all" or {"atLeast": n} with n from 1 to the number of criteria (${criteria.length})`;
    }
  }
  let text: string;
  try {
    text = jcs(spec);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (Buffer.byteLength(text) > MAX_SPEC_BYTES) return `the job spec is larger than ${MAX_SPEC_BYTES} bytes`;
  return null;
}

export interface SpecInput {
  title: string;
  client: string;
  provider: string;
  priceDrops: string;
  slaSeconds: number;
  criteria: Criterion[];
  rule?: SpecRule;
}

/** A new spec at revision 1 with a fresh nonce. Throws with the reason if it is not acceptable. */
export function makeJobSpec(input: SpecInput): JobSpecV1 {
  const spec: JobSpecV1 = {
    specVersion: 1, revision: 1, nonce: randomBytes(16).toString("hex"), title: input.title,
    client: input.client, provider: input.provider, priceDrops: input.priceDrops, slaSeconds: input.slaSeconds,
    criteria: input.criteria, rule: input.rule ?? "all",
  };
  const problem = specProblem(spec);
  if (problem) throw new Error(problem);
  return spec;
}

/** The next revision of a spec, with the changes applied. The old revision's signatures don't carry over. */
export function reviseJobSpec(spec: JobSpecV1, changes: Partial<Omit<JobSpecV1, "specVersion" | "revision" | "nonce" | "client" | "provider">>): JobSpecV1 {
  const next: JobSpecV1 = { ...spec, ...changes, specVersion: 1, revision: spec.revision + 1 };
  const problem = specProblem(next);
  if (problem) throw new Error(problem);
  return next;
}

/** Whether a set of criterion results meets the spec's rule. */
export function meetsRule(rule: SpecRule, results: { pass: boolean }[]): boolean {
  const passed = results.filter((r) => r.pass).length;
  return rule === "all" ? results.length > 0 && passed === results.length : passed >= rule.atLeast;
}

/** Plain words for a rule, for reports. */
export const ruleText = (rule: SpecRule, n: number) => (rule === "all" ? `all ${n} criteria` : `at least ${rule.atLeast} of ${n} criteria`);

const hexText = (text: string) => Buffer.from(text, "utf8").toString("hex").toUpperCase();
const textOfHex = (hex: string) => Buffer.from(hex, "hex").toString("utf8");

/** The Memos field of the EscrowCreate for this spec: one memo with its hash and version. */
export function specMemos(spec: JobSpecV1) {
  const memo: SpecMemo = { specHash: specHash(spec), specVersion: spec.specVersion, revision: spec.revision };
  return [{ Memo: { MemoType: hexText(SPEC_MEMO_TYPE), MemoFormat: hexText("application/json"), MemoData: hexText(jcs(memo)) } }];
}

/**
 * Read the spec memo out of a transaction's Memos. Ledger data is data: only
 * the exact memo type is looked at, its JSON must have exactly the expected
 * fields and types, and more than one spec memo is refused (which spec would
 * count?). Returns the memo, null when there is none, or a problem string.
 */
export function parseSpecMemo(memos: unknown): SpecMemo | null | { problem: string } {
  if (memos === undefined) return null;
  if (!Array.isArray(memos)) return { problem: "Memos is not a list" };
  const found: SpecMemo[] = [];
  for (const wrapper of memos) {
    const m = (wrapper as { Memo?: { MemoType?: unknown; MemoData?: unknown } } | null)?.Memo;
    if (!m || typeof m.MemoType !== "string") continue;
    if (!/^([0-9A-Fa-f]{2})*$/.test(m.MemoType) || textOfHex(m.MemoType) !== SPEC_MEMO_TYPE) continue;
    if (typeof m.MemoData !== "string" || !/^([0-9A-Fa-f]{2}){1,1024}$/.test(m.MemoData)) return { problem: "the spec memo's data is not hex" };
    let d: Partial<SpecMemo>;
    try {
      d = JSON.parse(textOfHex(m.MemoData));
    } catch {
      return { problem: "the spec memo's data is not JSON" };
    }
    if (!isObject(d) || Object.keys(d).sort().join(",") !== "revision,specHash,specVersion") return { problem: "the spec memo has the wrong fields" };
    if (typeof d.specHash !== "string" || !HEX64.test(d.specHash) || d.specVersion !== SPEC_VERSION
      || !Number.isSafeInteger(d.revision) || (d.revision as number) < 1) return { problem: "the spec memo has a malformed field" };
    found.push({ specHash: d.specHash, specVersion: d.specVersion, revision: d.revision as number });
  }
  if (found.length > 1) return { problem: "the EscrowCreate carries more than one spec memo" };
  return found[0] ?? null;
}

export { CHECK_TYPES };
