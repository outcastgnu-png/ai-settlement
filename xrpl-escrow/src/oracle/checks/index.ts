import type { CheckSpec } from "../../registry/db.js";
import { jsonSchema } from "./json-schema.js";
import { maxLatency } from "./max-latency.js";
import { sha256Match } from "./sha256-match.js";
import type { CheckContext, CheckResult } from "./types.js";

export type { CheckContext, CheckResult } from "./types.js";
export { CheckUnavailable, stopSchemaWorker } from "./json-schema.js";

export interface CheckOptions {
  timeoutMs?: number; // for checks that run in a worker
}

export async function runCheck(spec: CheckSpec, ctx: CheckContext, opts: CheckOptions = {}): Promise<CheckResult> {
  switch (spec.type) {
    case "sha256-match": return sha256Match(spec, ctx);
    case "json-schema": return jsonSchema(spec, ctx, opts.timeoutMs);
    case "max-latency": return maxLatency(spec, ctx);
    default: return { type: (spec as { type: CheckSpec["type"] }).type, pass: false, detail: "unknown check type" };
  }
}

/** Every check must pass, and there must be at least one. Checks run one after another. */
export async function runChecks(
  specs: CheckSpec[], ctx: CheckContext, opts: CheckOptions = {},
): Promise<{ pass: boolean; results: CheckResult[] }> {
  const results: CheckResult[] = [];
  for (const spec of specs) results.push(await runCheck(spec, ctx, opts));
  return { pass: results.length > 0 && results.every((r) => r.pass), results };
}
