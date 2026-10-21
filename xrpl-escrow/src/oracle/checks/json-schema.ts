// Passes when the deliverable parses as JSON and validates against the job's
// JSON Schema. The schema must pass the schema policy (no regex keywords, size,
// depth and $ref limits). The validation itself runs in a worker thread
// (json-schema-worker.ts) with a hard timeout: if a schema still manages to
// take too long, the worker is killed and the check fails. One worker is kept
// and reused; requests run one at a time.
import { Worker } from "node:worker_threads";
import { schemaProblem } from "../../schema-policy.js";
import type { SchemaRequest, SchemaResponse } from "./json-schema-worker.js";
import type { CheckContext, CheckResult } from "./types.js";

export const DEFAULT_TIMEOUT_MS = 2_000;

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
let lastCached = 0;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(bootstrap, { eval: true });
    worker.unref(); // never keeps the oracle process alive
    worker.on("error", () => { worker = null; });
    worker.on("exit", () => { worker = null; });
  }
  return worker;
}

/** Kills the worker, if one is running. Tests use it; the oracle's close() calls it. */
export async function stopSchemaWorker(): Promise<void> {
  const w = worker;
  worker = null;
  if (w) await w.terminate();
}

/** Number of compiled validators the worker reported after its last answer, for tests. */
export const cachedValidators = () => lastCached;

function runInWorker(req: Omit<SchemaRequest, "id">, timeoutMs: number): Promise<CheckResult> {
  const run = () => new Promise<CheckResult>((resolve) => {
    const id = nextId++;
    const w = getWorker();
    const fail = (detail: string): CheckResult => ({ type: "json-schema", pass: false, detail });
    let settled = false;
    const finish = (result: CheckResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      w.off("message", onMessage);
      w.off("error", onError);
      w.off("exit", onExit);
      resolve(result);
    };
    const onMessage = (res: SchemaResponse) => {
      if (res.id !== id) return;
      lastCached = res.cached;
      finish(res.result);
    };
    const onError = (err: Error) => finish(fail(`schema check failed: ${err.message}`));
    const onExit = () => finish(fail("schema check worker exited"));
    const timer = setTimeout(() => {
      worker = null;
      void w.terminate();
      finish(fail(`schema validation took longer than ${timeoutMs} ms and was stopped`));
    }, timeoutMs);
    w.on("message", onMessage);
    w.on("error", onError);
    w.on("exit", onExit);
    w.postMessage({ id, ...req } satisfies SchemaRequest);
  });
  const result = queue.then(run, run);
  queue = result;
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

/** Tests only: a request that holds the worker for `busyMs`, to show the timeout works. */
export const busySchemaCheck = (busyMs: number, timeoutMs: number) =>
  runInWorker({ schema: { type: "object" }, content: "{}", busyMs }, timeoutMs);
