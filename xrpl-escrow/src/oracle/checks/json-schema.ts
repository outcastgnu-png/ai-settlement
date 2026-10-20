// Passes when the deliverable parses as JSON and validates against the job's
// JSON Schema. JSON.parse only builds plain data; nothing in it is run.
import { Ajv, type ValidateFunction } from "ajv";
import type { CheckContext, CheckResult } from "./types.js";

const ajv = new Ajv({ strict: true, allErrors: false });
const compiled = new Map<string, ValidateFunction>();

function validator(schema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(schema);
  let validate = compiled.get(key);
  if (!validate) {
    validate = ajv.compile(schema);
    compiled.set(key, validate);
  }
  return validate;
}

export function jsonSchema(spec: { schema: Record<string, unknown> }, ctx: CheckContext): CheckResult {
  const fail = (detail: string): CheckResult => ({ type: "json-schema", pass: false, detail });
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
