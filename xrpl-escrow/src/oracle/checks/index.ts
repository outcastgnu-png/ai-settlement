import type { CheckSpec } from "../../check-spec.js";
import { meetsRule, type CriterionResult, type JobSpecV1 } from "../../job-spec.js";
import { containsText } from "./contains-text.js";
import { sizeRange } from "./size-range.js";
import { jsonSchema } from "./json-schema.js";
import { maxLatency } from "./max-latency.js";
import { sha256Match } from "./sha256-match.js";
import type { CheckContext, CheckResult } from "./types.js";
import { xrplTxValidated } from "./xrpl-tx.js";

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
    case "xrpl-tx-validated": return xrplTxValidated(spec, ctx);
    case "size-range": return sizeRange(spec, ctx);
    case "contains-text": return containsText(spec, ctx);
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

/**
 * Run a job spec v1 (EDR-016): every check of every criterion, one after another.
 * A criterion passes when all of its checks pass; the job passes when the
 * criteria meet the spec's rule ("all", or at least n). Each check result names
 * its criterion. This judges the checks, never the criterion's statement.
 */
export async function runCriteria(
  spec: JobSpecV1, ctx: CheckContext, opts: CheckOptions = {},
): Promise<{ pass: boolean; results: CheckResult[]; criteria: CriterionResult[] }> {
  const results: CheckResult[] = [];
  const criteria: CriterionResult[] = [];
  for (const c of spec.criteria) {
    const own: CheckResult[] = [];
    for (const check of c.checks) own.push({ ...(await runCheck(check, ctx, opts)), criterion: c.id });
    results.push(...own);
    criteria.push({ id: c.id, kind: c.kind, pass: own.length > 0 && own.every((r) => r.pass) });
  }
  return { pass: meetsRule(spec.rule, criteria), results, criteria };
}
