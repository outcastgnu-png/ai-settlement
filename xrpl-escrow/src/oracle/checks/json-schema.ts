// Passes when the deliverable parses as JSON and validates against the job's
// JSON Schema. The schema must pass the schema policy (no regex keywords, size,
// depth and $ref limits). The validation itself runs in a worker thread
// (json-schema-worker.ts) with a hard timeout: if a schema still manages to
// take too long, the worker is killed and the check fails. One worker is kept
// and reused; requests run one at a time.
//
// Only the validation counts against the timeout (Gpno N9). The clock starts
// when the worker says it has started this request, so time spent starting a
// fresh worker after a kill, or waiting behind other jobs, can never turn into
// a fail verdict for an honest job. Anything that is the oracle's problem and
// not the job's (the queue is full, the worker would not start or crashed)
// throws CheckUnavailable instead of returning a result, and the oracle answers
// 503 without signing a verdict.
import { Worker } from "node:worker_threads";
import { schemaProblem } from "../../schema-policy.js";
import type { SchemaRequest, SchemaResponse } from "./json-schema-worker.js";
import type { CheckContext, CheckResult } from "./types.js";

export const DEFAULT_TIMEOUT_MS = 2_000;
/** How long a fresh worker may take to load tsx and Ajv and pick up the request. */
export const STARTUP_TIMEOUT_MS = 30_000;
/** Requests allowed to wait for the worker; more are turned away as busy. */
export const MAX_WAITING = 8;

/** The check could not run for a reason that has nothing to do with the job. Retry later. */
export class CheckUnavailable extends Error {}

const workerUrl = new URL("./json-schema-worker.ts", import.meta.url).href;
// The sources run through tsx and import each other as ".js", so the worker
// has to load tsx first. Node's own type stripping would load the .ts file but
// not rewrite those imports, and the main thread's tsx hooks don't reach a
// worker, so the worker starts from this small bootstrap: find tsx next to
// this file, register its hooks, then import the worker module.
const bootstrap = `
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const req = createRequire(${JSON.stringify(workerUrl)});
const tsx = pathToFileURL(path.join(path.dirname(req.resolve("tsx/package.json")), "dist/esm/api/index.mjs")).href;
import(tsx).then(({ register }) => { register(); return import(${JSON.stringify(workerUrl)}); })
  .catch((err) => { throw err; });
`;

let worker: Worker | null = null;
let nextId = 1;
let queue: Promise<unknown> = Promise.resolve();
let waiting = 0;
let lastCached = 0;

function getWorker(): Worker {
  if (!worker) {
    const w = new Worker(bootstrap, { eval: true });
    w.unref(); // never keeps the oracle process alive
    // Forget only this worker: a killed worker can exit after its replacement started.
    const forget = () => { if (worker === w) worker = null; };
    w.on("error", forget);
    w.on("exit", forget);
    worker = w;
  }
  return worker;
}

/** Kills the worker, if one is running. Tests use it; the oracle's close() calls it. */
export async function stopSchemaWorker(): Promise<void> {
  const w = worker;
  worker = null;
  if (w) await w.terminate();
}

let runs = 0;
/** How many validations were sent to the worker so far, for tests. */
export const schemaRuns = () => runs;

/** Number of compiled validators the worker reported after its last answer, for tests. */
export const cachedValidators = () => lastCached;

function runInWorker(req: Omit<SchemaRequest, "id">, timeoutMs: number): Promise<CheckResult> {
  if (waiting >= MAX_WAITING) return Promise.reject(new CheckUnavailable("the schema checker is busy; try again shortly"));
  waiting++;
  runs++;
  const run = () => new Promise<CheckResult>((resolve, reject) => {
    waiting--;
    const id = nextId++;
    const w = getWorker();
    const fail = (detail: string): CheckResult => ({ type: "json-schema", pass: false, detail });
    let settled = false;
    let timer = setTimeout(() => {
      kill();
      finish(new CheckUnavailable("the schema checker did not start in time; try again"));
    }, STARTUP_TIMEOUT_MS);
    const kill = () => {
      if (worker === w) worker = null;
      void w.terminate();
    };
    const finish = (outcome: CheckResult | CheckUnavailable) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      w.off("message", onMessage);
      w.off("error", onError);
      w.off("exit", onExit);
      if (outcome instanceof CheckUnavailable) reject(outcome);
      else resolve(outcome);
    };
    const onMessage = (res: SchemaResponse) => {
      if (res.id !== id) return;
      if (res.started) {
        // The job's own time starts now.
        clearTimeout(timer);
        timer = setTimeout(() => {
          kill();
          finish(fail(`schema validation took longer than ${timeoutMs} ms and was stopped`));
        }, timeoutMs);
        return;
      }
      lastCached = res.cached;
      finish(res.result);
    };
    const onError = (err: Error) => finish(new CheckUnavailable(`the schema checker failed (${err.message}); try again`));
    const onExit = () => finish(new CheckUnavailable("the schema checker stopped; try again"));
    w.on("message", onMessage);
    w.on("error", onError);
    w.on("exit", onExit);
    w.postMessage({ id, ...req } satisfies SchemaRequest);
  });
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}

export async function jsonSchema(
  spec: { schema: Record<string, unknown> }, ctx: CheckContext, timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CheckResult> {
  // Refuse here first, so a bad schema never reaches the worker at all.
  const problem = schemaProblem(spec.schema);
  if (problem) return { type: "json-schema", pass: false, detail: `job schema refused: ${problem}` };
  return runInWorker({ schema: spec.schema, content: ctx.content }, timeoutMs);
}

/** Tests only: a request that holds the worker for `busyMs` (or crashes it, or starts slowly), to show the timeout works. */
export const busySchemaCheck = (busyMs: number, timeoutMs: number, crash = false, startDelayMs = 0) =>
  runInWorker({ schema: { type: "object" }, content: "{}", busyMs, crash, startDelayMs }, timeoutMs);
