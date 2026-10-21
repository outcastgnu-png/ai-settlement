// Worker thread that compiles a job's JSON Schema and validates a deliverable
// against it. It runs apart from the oracle so that a validation the schema
// policy failed to stop can be killed by a timeout instead of blocking the
// oracle. Compiled validators are kept in a bounded cache for the life of the
// worker. JSON.parse only builds plain data; nothing in it is run.
import { parentPort } from "node:worker_threads";
import { Ajv, type ValidateFunction } from "ajv";
import { schemaProblem } from "../../schema-policy.js";
import type { CheckResult } from "./types.js";

export interface SchemaRequest {
  id: number;
  schema: Record<string, unknown>;
  content: string;
  busyMs?: number; // tests only: spin for this long instead of validating
  crash?: boolean; // tests only: end the worker thread instead of answering
  startDelayMs?: number; // tests only: wait this long before taking the request up, like a slow start
}

export type SchemaResponse =
  | { id: number; started: true } // sent first: the oracle starts the timeout clock here
  | { id: number; started?: false; result: CheckResult; cached: number }; // cached: validators held, for tests

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

/** The check itself, with no worker around it. */
export function validateInProcess(schema: Record<string, unknown>, content: string): CheckResult {
  const fail = (detail: string): CheckResult => ({ type: "json-schema", pass: false, detail });
  const problem = schemaProblem(schema);
  if (problem) return fail(`job schema refused: ${problem}`);
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return fail("deliverable is not valid JSON");
  }
  let validate: ValidateFunction;
  try {
    validate = validator(schema);
  } catch (err) {
    return fail(`job schema is invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (validate(data)) return { type: "json-schema", pass: true, detail: "deliverable matches the schema" };
  const e = validate.errors?.[0];
  return fail(`schema violation at ${e?.instancePath || "/"}: ${e?.message ?? "invalid"}`);
}

if (parentPort) {
  parentPort.on("message", (req: SchemaRequest) => {
    if (req.startDelayMs) {
      const until = Date.now() + req.startDelayMs;
      while (Date.now() < until) { /* stand-in for a slow start, before the clock starts */ }
    }
    parentPort!.postMessage({ id: req.id, started: true } satisfies SchemaResponse);
    if (req.crash) process.exit(1); // in a worker this ends only the worker thread
    if (req.busyMs) {
      const until = Date.now() + req.busyMs;
      while (Date.now() < until) { /* hold the thread, so the timeout can be tested */ }
    }
    const result = validateInProcess(req.schema, req.content);
    parentPort!.postMessage({ id: req.id, result, cached: compiled.size } satisfies SchemaResponse);
  });
}
