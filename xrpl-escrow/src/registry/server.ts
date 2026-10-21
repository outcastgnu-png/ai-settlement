// Job registry HTTP API on 127.0.0.1:8801.
//
//   GET  /health
//   POST /jobs                          create a draft job {client, provider, priceDrops, slaSeconds, spec}
//   GET  /jobs[?status=&provider=&client=]
//   GET  /jobs/:id
//   PUT  /jobs/:id/condition            set by the oracle once, while the job is a draft (oracle token)
//   POST /jobs/:id/deliverable          provider posts the work {content, auth}
//   GET  /jobs/:id/deliverable
//   POST /jobs/:id/events               status changes from the watcher (watcher token) or the oracle (oracle token)
//   GET  /jobs/:id/events
//   GET  /providers/:address/reputation
//
// Job specs and deliverables are stored as data and never interpreted here.
// The two internal write endpoints need a bearer token from .env, so only the
// oracle can set conditions and verdicts, and only the watcher can report what
// happened on the ledger.
import { pathToFileURL } from "node:url";
import { isValidClassicAddress } from "xrpl";
import { checkBearer, checkRequest, sha256Hex } from "../auth.js";
import { HttpError, jsonServer, listenLocal, type Route } from "../http.js";
import { JOBS_DB, REGISTRY_PORT, readEnvFile, requireEnv } from "../local-config.js";
import { schemaProblem } from "../schema-policy.js";
import { JobStore, TERMINAL, canMove, type CheckSpec, type Job, type JobPatch, type JobStatus, type NewJob } from "./db.js";

const FORBIDDEN_KEYS = ["secret", "fulfillment", "preimage"];
const CHECK_TYPES = ["sha256-match", "json-schema", "max-latency"];
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function containsForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenKey);
  if (!isObject(value)) return false;
  return Object.keys(value).some((k) => FORBIDDEN_KEYS.includes(k.toLowerCase()) || containsForbiddenKey(value[k]));
}

function validCheck(c: unknown): c is CheckSpec {
  if (!isObject(c) || !CHECK_TYPES.includes(c.type as string)) return false;
  if (c.type === "sha256-match") return typeof c.sha256 === "string" && /^[0-9a-fA-F]{64}$/.test(c.sha256);
  if (c.type === "json-schema") return isObject(c.schema) && schemaProblem(c.schema) === null;
  return typeof c.maxMs === "number" && c.maxMs > 0;
}

export function parseNewJob(body: unknown): NewJob {
  if (!isObject(body)) throw new HttpError(400, "body must be a JSON object");
  if (containsForbiddenKey(body)) throw new HttpError(400, "the registry never stores secrets or fulfillments");
  const { client, provider, priceDrops, slaSeconds, spec } = body;
  if (typeof client !== "string" || !isValidClassicAddress(client)) throw new HttpError(400, "client must be an XRPL address");
  if (typeof provider !== "string" || !isValidClassicAddress(provider)) throw new HttpError(400, "provider must be an XRPL address");
  if (client === provider) throw new HttpError(400, "client and provider must differ");
  if (typeof priceDrops !== "string" || !/^[1-9][0-9]{0,16}$/.test(priceDrops)) throw new HttpError(400, "priceDrops must be a positive drop string");
  if (!Number.isInteger(slaSeconds) || (slaSeconds as number) < 30 || (slaSeconds as number) > 86_400) {
    throw new HttpError(400, "slaSeconds must be an integer from 30 to 86400");
  }
  if (isObject(spec) && Array.isArray(spec.checks)) {
    for (const c of spec.checks) {
      const problem = isObject(c) && c.type === "json-schema" ? schemaProblem(c.schema) : null;
      if (problem) throw new HttpError(400, `json-schema check refused: ${problem}`);
    }
  }
  if (!isObject(spec) || !Array.isArray(spec.checks) || spec.checks.length === 0 || !spec.checks.every(validCheck)) {
    throw new HttpError(400, `spec.checks must be a non-empty list of: ${CHECK_TYPES.join(", ")}`);
  }
  const title = typeof spec.title === "string" ? spec.title : undefined;
  return { client, provider, priceDrops, slaSeconds: slaSeconds as number, spec: { title, checks: spec.checks } };
}

const LEDGER_STATUSES: JobStatus[] = ["funded", "paid", "refunded", "expired_unclaimed"];
const ORACLE_STATUSES: JobStatus[] = ["verified_pass", "verified_fail"];

export interface ServiceTokens {
  oracle: string;
  watcher: string;
}

export function registryRoutes(store: JobStore, tokens: ServiceTokens): Route[] {
  const mustGet = (id: string): Job => {
    const job = store.get(id);
    if (!job) throw new HttpError(404, `unknown job ${id}`);
    return job;
  };

  return [
    { method: "GET", path: "/health", handler: () => ({ ok: true, service: "registry" }) },

    { method: "POST", path: "/jobs", handler: (_p, body) => store.create(parseNewJob(body)) },

    {
      method: "GET", path: "/jobs",
      handler: (_p, _b, q) => store.list({
        status: q.get("status") ?? undefined, provider: q.get("provider") ?? undefined, client: q.get("client") ?? undefined,
      }),
    },

    { method: "GET", path: "/jobs/:id", handler: ({ id }) => mustGet(id) },

    {
      method: "PUT", path: "/jobs/:id/condition",
      handler: ({ id }, body, _q, headers) => {
        checkBearer(headers, tokens.oracle, "oracle");
        const job = mustGet(id);
        const condition = isObject(body) ? body.condition : undefined;
        if (typeof condition !== "string" || !/^A0258020[0-9A-F]{64}810120$/.test(condition)) {
          throw new HttpError(400, "condition must be an uppercase PREIMAGE-SHA-256 condition");
        }
        if (job.condition === condition) return job;
        if (job.condition || job.status !== "draft") throw new HttpError(409, "condition is already set");
        store.addEvent({ jobId: id, at: Date.now(), source: "oracle", status: null, detail: "condition set" });
        return store.update(id, { condition });
      },
    },

    {
      method: "POST", path: "/jobs/:id/deliverable",
      handler: ({ id }, body) => {
        const job = mustGet(id);
        if (!isObject(body) || typeof body.content !== "string") throw new HttpError(400, "content must be a string");
        const sha256 = sha256Hex(body.content);
        checkRequest(body.auth, "deliver", id, sha256, job.provider);
        if (job.status !== "funded") throw new HttpError(409, `job is ${job.status}; deliverables are accepted only when funded`);
        const deliveredAt = Date.now();
        store.putDeliverable({ jobId: id, content: body.content, sha256, deliveredAt });
        store.addEvent({ jobId: id, at: deliveredAt, source: "registry", status: "delivered", detail: `deliverable sha256 ${sha256}` });
        return store.update(id, { status: "delivered", deliveredAt });
      },
    },

    {
      method: "GET", path: "/jobs/:id/deliverable",
      handler: ({ id }) => {
        mustGet(id);
        const d = store.getDeliverable(id);
        if (!d) throw new HttpError(404, "no deliverable yet");
        return d;
      },
    },

    {
      method: "POST", path: "/jobs/:id/events",
      handler: ({ id }, body, _q, headers) => {
        const source = isObject(body) ? body.source : undefined;
        if (source === "ledger") checkBearer(headers, tokens.watcher, "watcher");
        else if (source === "oracle") checkBearer(headers, tokens.oracle, "oracle");
        else throw new HttpError(400, "source must be ledger or oracle");
        return applyEvent(store, mustGet(id), body);
      },
    },

    { method: "GET", path: "/jobs/:id/events", handler: ({ id }) => (mustGet(id), store.events(id)) },

    {
      method: "GET", path: "/providers/:address/reputation",
      handler: ({ address }) => {
        if (!isValidClassicAddress(address)) throw new HttpError(400, "not an XRPL address");
        return store.reputation(address);
      },
    },
  ];
}

/**
 * Status changes reported by the watcher (source "ledger") or the oracle.
 * The ledger is the source of truth for funded, paid and refunded: a
 * validated EscrowFinish or EscrowCancel closes the job from any open state.
 */
function applyEvent(store: JobStore, job: Job, body: unknown): Job {
  if (!isObject(body)) throw new HttpError(400, "body must be a JSON object");
  const source = body.source;
  if (source !== "ledger" && source !== "oracle") throw new HttpError(400, "source must be ledger or oracle");
  const now = Date.now();
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined);
  const int = (k: string) => (Number.isInteger(body[k]) ? (body[k] as number) : undefined);

  if (body.expiringSoon === true && source === "ledger" && !job.expiringSoon) {
    store.addEvent({ jobId: job.id, at: now, source, status: null, detail: str("detail") ?? "escrow nears CancelAfter" });
    job = store.update(job.id, { expiringSoon: true });
  }

  const status = body.status as JobStatus | undefined;
  if (status === undefined) return job;
  if (status === job.status) return job; // already applied
  const allowed = source === "ledger" ? LEDGER_STATUSES : ORACLE_STATUSES;
  if (!allowed.includes(status)) throw new HttpError(400, `${source} may not set status ${status}`);

  const closes = status === "paid" || status === "refunded";
  const anomaly = !canMove(job.status, status);
  if (anomaly && !(source === "ledger" && closes && !TERMINAL.includes(job.status))) {
    throw new HttpError(409, `cannot move job from ${job.status} to ${status}`);
  }

  const patch: JobPatch = { status };
  // fundedAt is the close time of the ledger that validated the EscrowCreate, when the watcher knows it.
  if (status === "funded") Object.assign(patch, { offerSequence: int("offerSequence"), cancelAfter: int("cancelAfter"), createTx: str("txHash"), fundedAt: int("fundedAt") ?? now });
  if (status === "paid") Object.assign(patch, { finishTx: str("txHash"), closedAt: now });
  if (status === "refunded") Object.assign(patch, { cancelTx: str("txHash"), closedAt: now });
  if (status === "verified_pass" || status === "verified_fail") Object.assign(patch, { verdict: status === "verified_pass" ? "pass" : "fail", verifiedAt: now });

  const detail = `${str("detail") ?? ""}${anomaly ? ` (ledger overrides ${job.status})` : ""}`.trim();
  store.addEvent({ jobId: job.id, at: now, source, status, detail: detail || status });
  return store.update(job.id, patch);
}

export async function startRegistry(opts: { dbPath?: string; port?: number; tokens?: ServiceTokens } = {}) {
  const env = opts.tokens ? {} : readEnvFile();
  const tokens = opts.tokens ?? { oracle: requireEnv(env, "ORACLE_SERVICE_TOKEN"), watcher: requireEnv(env, "WATCHER_SERVICE_TOKEN") };
  const store = new JobStore(opts.dbPath ?? JOBS_DB);
  const server = jsonServer(registryRoutes(store, tokens));
  const port = await listenLocal(server, opts.port ?? REGISTRY_PORT);
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    store,
    close: () => new Promise<void>((done) => {
      server.close(() => (store.close(), done()));
      server.closeAllConnections();
    }),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startRegistry().then(({ url }) => console.log(`registry listening on ${url} (db ${JOBS_DB})`), (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
