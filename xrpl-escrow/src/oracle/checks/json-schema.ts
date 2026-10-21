// Passes when the deliverable parses as JSON and validates against the job's
// JSON Schema. JSON.parse only builds plain data; nothing in it is run. The
// schema must pass the schema policy first (no regex keywords, size and depth
// limits), and compiled validators are kept in a bounded cache.
import { Ajv, type ValidateFunction } from "ajv";
import { schemaProblem } from "../../schema-policy.js";
import type { CheckContext, CheckResult } from "./types.js";

const ajv = new Ajv({ strict: true, allErrors: false });
const MAX_CACHED = 256;
const compiled = new Map<string, ValidateFunction>();

function validator(schema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(schema);
  let validate = compiled.get(key);
  if (!validate) {
    validate = ajv.compile(schema);
    ajv.removeSchema(schema); // keep Ajv's own registry from growing with every job
    if (compiled.size >= MAX_CACHED) compiled.delete(compiled.keys().next().value!);
    compiled.set(key, validate);
  }
  return validate;
}

/** Number of compiled validators held, for tests. */
export const cachedValidators = () => compiled.size;

export function jsonSchema(spec: { schema: Record<string, unknown> }, ctx: CheckContext): CheckResult {
  const fail = (detail: string): CheckResult => ({ type: "json-schema", pass: false, detail });
  const problem = schemaProblem(spec.schema);
  if (problem) return fail(`job schema refused: ${problem}`);
  let data: unknown;
  try {
    data = JSON.parse(ctx.content);
  } catch {
    return fail("deliverable is not valid JSON");
  }
  let validate: ValidateFunction;
  try {
    validate = validator(spec.schema);
  } catch (err) {
    return fail(`job schema is invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (validate(data)) return { type: "json-schema", pass: true, detail: "deliverable matches the schema" };
  const e = validate.errors?.[0];
  return fail(`schema violation at ${e?.instancePath || "/"}: ${e?.message ?? "invalid"}`);
}
