// The check types a job may ask the oracle to run, and the rules the registry
// (and the SDK, before it signs anything) applies to each one. Moved here from
// the registry in Phase 6 so the signed job spec (src/job-spec.ts) uses the
// same rules. A check is data: it is validated, never executed.
import { isValidClassicAddress } from "xrpl";
import type { TxCheckSpec } from "./oracle/checks/xrpl-tx.js";
import { TX_TYPES } from "./oracle/checks/xrpl-tx.js";
import { schemaProblem } from "./schema-policy.js";

/** Phase 6 (EDR-016): the deliverable's size in UTF-8 bytes is from minBytes to maxBytes. */
export interface SizeRangeSpec {
  type: "size-range";
  minBytes: number;
  maxBytes: number;
}

/** Phase 6 (EDR-016): the deliverable holds this text, literally and case-sensitively. No regex. */
export interface ContainsTextSpec {
  type: "contains-text";
  text: string;
}

export type CheckSpec =
  | { type: "sha256-match"; sha256: string }
  | { type: "json-schema"; schema: Record<string, unknown> }
  | { type: "max-latency"; maxMs: number }
  | SizeRangeSpec
  | ContainsTextSpec
  | TxCheckSpec;

export const CHECK_TYPES = ["sha256-match", "json-schema", "max-latency", "xrpl-tx-validated", "size-range", "contains-text"];
/** Each json-schema check may hold the oracle's schema worker for up to its timeout, so a job gets a few checks, not hundreds (Gpno N9). */
export const MAX_CHECKS = 8;
/** Each xrpl-tx-validated check makes one ledger lookup, so a job gets at most this many (EDR-014). */
export const MAX_TX_CHECKS = 2;
/** The registry stores deliverables as text; nothing larger is worth a size check. */
export const MAX_SIZE_BYTES = 10_000_000;
export const MAX_CONTAINS_TEXT_BYTES = 256;

const TX_KEYS = ["type", "txType", "destination", "minDrops", "account", "destinationTag", "memo"];
export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const onlyKeys = (c: Record<string, unknown>, keys: string[]) => Object.keys(c).every((k) => keys.includes(k));
const wholeIn = (v: unknown, min: number, max: number) => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;

/** What is wrong with one check, or null if the registry accepts it. */
export function checkProblem(c: unknown): string | null {
  if (!isObject(c) || !CHECK_TYPES.includes(c.type as string)) return `a check must be one of: ${CHECK_TYPES.join(", ")}`;
  switch (c.type) {
    case "sha256-match":
      return typeof c.sha256 === "string" && /^[0-9a-fA-F]{64}$/.test(c.sha256) ? null : "sha256-match needs sha256, 64 hex characters";
    case "json-schema": {
      if (!isObject(c.schema)) return "json-schema needs a schema object";
      const problem = schemaProblem(c.schema);
      return problem ? `json-schema check refused: ${problem}` : null;
    }
    case "xrpl-tx-validated":
      return validTxCheck(c) ? null : "xrpl-tx-validated has a missing or malformed field";
    case "size-range":
      if (!onlyKeys(c, ["type", "minBytes", "maxBytes"])) return "size-range takes only minBytes and maxBytes";
      if (!wholeIn(c.minBytes, 0, MAX_SIZE_BYTES) || !wholeIn(c.maxBytes, 1, MAX_SIZE_BYTES) || (c.minBytes as number) > (c.maxBytes as number)) {
        return `size-range needs whole numbers 0 <= minBytes <= maxBytes <= ${MAX_SIZE_BYTES}`;
      }
      return null;
    case "contains-text":
      if (!onlyKeys(c, ["type", "text"])) return "contains-text takes only text";
      if (typeof c.text !== "string" || c.text.length === 0 || Buffer.byteLength(c.text) > MAX_CONTAINS_TEXT_BYTES) {
        return `contains-text needs text of 1 to ${MAX_CONTAINS_TEXT_BYTES} bytes (literal, case-sensitive, no regex)`;
      }
      return null;
    default: // max-latency
      return typeof c.maxMs === "number" && c.maxMs > 0 ? null : "max-latency needs maxMs above 0";
  }
}

export const validCheck = (c: unknown): c is CheckSpec => checkProblem(c) === null;

function validTxCheck(c: Record<string, unknown>): boolean {
  if (!onlyKeys(c, TX_KEYS)) return false;
  if (!(TX_TYPES as readonly unknown[]).includes(c.txType)) return false;
  if (typeof c.destination !== "string" || !isValidClassicAddress(c.destination)) return false;
  if (typeof c.minDrops !== "string" || !/^[1-9][0-9]{0,16}$/.test(c.minDrops)) return false;
  if (c.account !== undefined && (typeof c.account !== "string" || !isValidClassicAddress(c.account))) return false;
  if (c.destinationTag !== undefined && !(Number.isInteger(c.destinationTag) && (c.destinationTag as number) >= 0 && (c.destinationTag as number) <= 0xffffffff)) return false;
  if (c.memo !== undefined && (typeof c.memo !== "string" || c.memo.length === 0 || Buffer.byteLength(c.memo) > 256)) return false;
  return true;
}

/** The limits on a list of checks: how many, and how many ledger lookups. Null when they hold. */
export function checkListProblem(checks: unknown[], where = "spec.checks"): string | null {
  if (checks.length > MAX_CHECKS) return `${where} may hold at most ${MAX_CHECKS} checks`;
  if (checks.filter((c) => isObject(c) && c.type === "xrpl-tx-validated").length > MAX_TX_CHECKS) {
    return `${where} may hold at most ${MAX_TX_CHECKS} xrpl-tx-validated checks`;
  }
  return null;
}
