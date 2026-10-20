import type { CheckSpec } from "../../registry/db.js";
import { jsonSchema } from "./json-schema.js";
import { maxLatency } from "./max-latency.js";
import { sha256Match } from "./sha256-match.js";
import type { CheckContext, CheckResult } from "./types.js";

export type { CheckContext, CheckResult } from "./types.js";

export function runCheck(spec: CheckSpec, ctx: CheckContext): CheckResult {
  switch (spec.type) {
    case "sha256-match": return sha256Match(spec, ctx);
    case "json-schema": return jsonSchema(spec, ctx);
    case "max-latency": return maxLatency(spec, ctx);
    default: return { type: (spec as { type: CheckSpec["type"] }).type, pass: false, detail: "unknown check type" };
  }
}

/** Every check must pass, and there must be at least one. */
export function runChecks(specs: CheckSpec[], ctx: CheckContext): { pass: boolean; results: CheckResult[] } {
  const results = specs.map((s) => runCheck(s, ctx));
  return { pass: results.length > 0 && results.every((r) => r.pass), results };
}
