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
//   POST /jobs/:id/verdicts             a shared job's signed oracle verdict {verdict} (EDR-015); checked, no token
//   GET  /jobs/:id/verdicts             the signed oracle verdicts recorded for a shared job
//   GET  /splits                        shared jobs whose oracles disagreed (at least one pass and one fail), and on which criteria
//   POST /jobs/:id/spec/signatures      a party's signature over the job's spec hash {specHash, signature} (EDR-016); checked, no token
//   PUT  /jobs/:id/spec                 the client sends the spec's next revision {spec, auth} while the job is a draft (EDR-016)
//   GET  /jobs/:id/spec/revisions       the earlier revisions of a job's spec, each with its signatures
//
// A job spec v1 (EDR-016, src/job-spec.ts) states the acceptance criteria and
// the checks behind each. Client and provider each sign its hash here; the SDK
// refuses to fund the escrow until both signatures check, and puts the hash in
// a memo on the EscrowCreate. A spec is never edited in place: a change is the
// next revision, with a new hash and new signatures, and the old revision is
// kept. Once the job is funded its spec can't change. The registry is not what
// makes this hold, though: each oracle checks the spec it reads here against
// the hash on the ledger, so a registry that changes a spec gets refused.
//
// A shared job (EDR-015) is created by its client, signed, with its oracle set,
// threshold k and the condition of a secret the client made and split. The
// registry never sees a share. Its status follows the signed verdicts: it is
// verified_pass once k oracles of the set passed it, and verified_fail once so
// many failed it that k passes can no longer happen. Any party may post a
// verdict, since the signature by a pinned oracle of the set is what counts.
//
// Job specs and deliverables are stored as data and never interpreted here.
// The two internal write endpoints need a bearer token from .env, so only the
// oracle can set conditions and verdicts, and only the watcher can report what
// happened on the ledger.
import { pathToFileURL } from "node:url";
import { isValidClassicAddress } from "xrpl";
import { canonicalJson, checkBearer, checkRequest, newJobHash, sha256Hex, verifyPayload } from "../auth.js";
import { HttpError, jsonServer, listenLocal, type Route } from "../http.js";
import { JOBS_DB, REGISTRY_PORT, readEnvFile, requireEnv } from "../local-config.js";
import { CHECK_TYPES, MAX_CHECKS, MAX_TX_CHECKS, checkListProblem, checkProblem, isObject, validCheck } from "../check-spec.js";
import { isSpecV1, specHash, specProblem, verifySpecSignature, type JobSpecV1, type SpecSignature } from "../job-spec.js";
import { JobStore, TERMINAL, canMove, type Job, type JobPatch, type JobSpec, type JobStatus, type NewJob, type OracleRef, type OracleVerdictRecord } from "./db.js";
import type { SignedVerdict } from "../oracle/server.js";

/** A shared job has at most this many oracles. */
export const MAX_ORACLES = 7;
const LOCAL_URL = /^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/;
const CONDITION = /^A0258020[0-9A-F]{64}810120$/;

export { newJobHash };

function parseOracleSet(body: Record<string, unknown>): { oracles: OracleRef[]; threshold: number; condition: string } {
  const { oracles, threshold, condition } = body;
  if (!Array.isArray(oracles) || oracles.length < 2 || oracles.length > MAX_ORACLES) {
    throw new HttpError(400, `oracles must list 2 to ${MAX_ORACLES} oracles`);
  }
  const set: OracleRef[] = oracles.map((o, i) => {
    if (!isObject(o) || !Object.keys(o).every((k) => ["address", "anchor", "url"].includes(k))) throw new HttpError(400, `oracle ${i + 1} must be {address, anchor, url}`);
    if (typeof o.address !== "string" || !isValidClassicAddress(o.address)) throw new HttpError(400, `oracle ${i + 1}: address must be an XRPL address`);
    if (typeof o.anchor !== "string" || !isValidClassicAddress(o.anchor)) throw new HttpError(400, `oracle ${i + 1}: anchor must be an XRPL address`);
    if (typeof o.url !== "string" || !LOCAL_URL.test(o.url)) throw new HttpError(400, `oracle ${i + 1}: url must be http://127.0.0.1:<port> (local only)`);
    return { address: o.address, anchor: o.anchor, url: o.url };
  });
  for (const key of ["address", "anchor", "url"] as const) {
    if (new Set(set.map((o) => o[key])).size !== set.length) throw new HttpError(400, `each oracle needs its own ${key}`);
  }
  if (!Number.isInteger(threshold) || (threshold as number) < 2 || (threshold as number) > set.length) {
    throw new HttpError(400, "threshold must be a whole number from 2 to the number of oracles");
  }
  if (typeof condition !== "string" || !CONDITION.test(condition)) throw new HttpError(400, "condition must be an uppercase PREIMAGE-SHA-256 condition");
  return { oracles: set, threshold: threshold as number, condition };
}

const FORBIDDEN_KEYS = ["secret", "fulfillment", "preimage"];

export { MAX_CHECKS, MAX_TX_CHECKS };

function containsForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenKey);
  if (!isObject(value)) return false;
  return Object.keys(value).some((k) => FORBIDDEN_KEYS.includes(k.toLowerCase()) || containsForbiddenKey(value[k]));
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
  let jobSpec: JobSpec;
  if (isSpecV1(spec)) {
    // A signed job spec (EDR-016): it names the parties, price and SLA itself, and the job must agree with it.
    const problem = specProblem(spec);
    if (problem) throw new HttpError(400, `job spec refused: ${problem}`);
    if (spec.client !== client || spec.provider !== provider || spec.priceDrops !== priceDrops || spec.slaSeconds !== slaSeconds) {
      throw new HttpError(400, "the job's client, provider, priceDrops and slaSeconds must be the ones in its spec");
    }
    if (spec.revision !== 1) throw new HttpError(400, "a new job's spec starts at revision 1");
    jobSpec = spec;
  } else {
    if (isObject(spec) && Array.isArray(spec.checks)) {
      const listProblem = checkListProblem(spec.checks);
      if (listProblem) throw new HttpError(400, listProblem);
      for (const c of spec.checks) {
        const problem = isObject(c) && c.type === "json-schema" ? checkProblem(c) : null;
        if (problem) throw new HttpError(400, problem);
      }
    }
    if (!isObject(spec) || !Array.isArray(spec.checks) || spec.checks.length === 0 || !spec.checks.every(validCheck)) {
      throw new HttpError(400, `spec.checks must be a non-empty list of: ${CHECK_TYPES.join(", ")}`);
    }
    const title = typeof spec.title === "string" ? spec.title : undefined;
    jobSpec = { title, checks: spec.checks };
  }
  const job: NewJob = { client, provider, priceDrops, slaSeconds: slaSeconds as number, spec: jobSpec };
  if (body.oracles !== undefined || body.threshold !== undefined || body.condition !== undefined) {
    job.shared = parseOracleSet(body);
    // Only the client may create its shared job, since it names the condition the client will fund.
    checkRequest(body.auth, "create", "", newJobHash(body), client);
  }
  return job;
}

/** A party posts its signature over the job's current spec hash (EDR-016). The signature is what counts, so no token. */
function applySpecSignature(store: JobStore, job: Job, body: unknown): Job {
  if (!isSpecV1(job.spec) || !job.specHash) throw new HttpError(409, "this job has an unsigned (Phase 1 to 5) spec; there is nothing to sign");
  if (job.status !== "draft") throw new HttpError(409, `job is ${job.status}; its spec was locked when it was funded`);
  const b = isObject(body) ? body : {};
  const sig = b.signature as SpecSignature | undefined;
  if (b.specHash !== job.specHash) {
    throw new HttpError(409, `that signature is for spec ${String(b.specHash)}, but the job's current spec (revision ${job.specRevision}) is ${job.specHash}`);
  }
  const role = isObject(sig) && sig.address === job.spec.client ? "client" : isObject(sig) && sig.address === job.spec.provider ? "provider" : null;
  if (!role) throw new HttpError(403, "only the spec's client or provider can sign it");
  if (!verifySpecSignature(job.specHash, sig, sig!.address)) throw new HttpError(400, "the signature does not check against the spec hash");
  const clean: SpecSignature = { address: sig!.address, publicKey: sig!.publicKey, signature: sig!.signature };
  if (store.putSpecSignature(job.id, job.specHash, role, clean)) {
    const after = store.get(job.id)!;
    const both = !!after.specSignatures?.client && !!after.specSignatures?.provider;
    store.addEvent({ jobId: job.id, at: Date.now(), source: "registry", status: null, detail: `${role} signed spec revision ${job.specRevision} (${job.specHash})${both ? "; both parties have signed" : ""}` });
  }
  return store.get(job.id)!;
}

/**
 * The client replaces a draft job's spec with its next revision (EDR-016). A spec is
 * never edited in place: the revision number must go up by one, the old revision is
 * kept with its signatures, and the new one needs both signatures again. Once the job
 * is funded the spec can't change at all, since its hash is on the ledger.
 */
function applySpecRevision(store: JobStore, job: Job, body: unknown): Job {
  if (!isSpecV1(job.spec) || !job.specHash || job.specRevision === null) throw new HttpError(409, "this job has an unsigned (Phase 1 to 5) spec; it can't be revised");
  if (job.status !== "draft") throw new HttpError(409, `job is ${job.status}; its spec was locked on the ledger when it was funded and can't change`);
  const b = isObject(body) ? body : {};
  const next = b.spec;
  if (containsForbiddenKey(next)) throw new HttpError(400, "the registry never stores secrets or fulfillments");
  const problem = specProblem(next);
  if (problem) throw new HttpError(400, `job spec refused: ${problem}`);
  const spec = next as JobSpecV1;
  checkRequest(b.auth, "revise-spec", job.id, specHash(spec), job.client);
  if (spec.revision === job.specRevision) {
    if (specHash(spec) === job.specHash) return job;
    throw new HttpError(409, `revision ${job.specRevision} is already set; a spec is never edited in place. Send revision ${job.specRevision + 1}, which both parties sign again`);
  }
  if (spec.revision !== job.specRevision + 1) throw new HttpError(409, `the next revision of this spec is ${job.specRevision + 1}, not ${spec.revision}`);
  if (spec.client !== job.spec.client || spec.provider !== job.spec.provider || spec.nonce !== job.spec.nonce) {
    throw new HttpError(400, "a revision keeps the spec's client, provider and nonce");
  }
  if (job.oracles && spec.priceDrops !== job.priceDrops) throw new HttpError(400, "a shared job's price is part of what its client signed at creation; create a new job instead");
  if (store.bySpecHash(specHash(spec))) throw new HttpError(409, "a job with this spec already exists");
  return store.reviseSpec(job.id, spec);
}

/** Check a posted verdict for a shared job and record it; then move the job's status if the set has decided. */
function applyOracleVerdict(store: JobStore, job: Job, body: unknown): Job {
  if (!job.oracles || !job.threshold) throw new HttpError(409, "not a shared job; its oracle reports with its service token");
  const v = (isObject(body) ? body.verdict : undefined) as SignedVerdict | undefined;
  if (!isObject(v) || typeof v.signature !== "string" || typeof v.oracle !== "string" || typeof v.publicKey !== "string") {
    throw new HttpError(400, "verdict must be a signed oracle verdict");
  }
  const index = job.oracles.findIndex((o) => o.address === v.oracle);
  if (index < 0) throw new HttpError(403, `${v.oracle} is not in this job's oracle set`);
  const { signature, ...unsigned } = v;
  if (!verifyPayload(unsigned, signature, v.publicKey, v.oracle)) throw new HttpError(400, "verdict signature does not check");
  if (v.jobId !== job.id || v.condition !== job.condition || v.provider !== job.provider) {
    throw new HttpError(400, "verdict is for another job, condition or provider");
  }
  if (v.verdict !== "pass" && v.verdict !== "fail") throw new HttpError(400, "verdict must be pass or fail");
  if (v.shareIndex !== index + 1 || v.threshold !== job.threshold) throw new HttpError(400, "verdict names the wrong share index or threshold");
  // Every oracle of the set judges the one signed spec (EDR-016): a verdict on another spec does not count.
  if ((v.specHash ?? null) !== job.specHash) {
    throw new HttpError(400, `verdict judged spec ${v.specHash ?? "(unsigned)"}, not this job's spec ${job.specHash ?? "(unsigned)"}`);
  }
  const deliverable = store.getDeliverable(job.id);
  if (!deliverable || deliverable.sha256 !== v.evidenceHash) throw new HttpError(400, "verdict is not for the delivered work");

  const now = Date.now();
  const prior = store.oracleVerdicts(job.id).find((r) => r.oracle === v.oracle);
  if (prior) {
    if (canonicalJson(prior.signed) === canonicalJson(v)) return job;
    // Two different signed verdicts from one oracle for one job: keep the first, record that it happened.
    store.addEvent({ jobId: job.id, at: now, source: "oracle", status: null, detail: `oracle ${v.oracle} signed a second, different verdict (${v.verdict}); the first (${prior.verdict}) stands` });
    throw new HttpError(409, `oracle ${v.oracle} already has a verdict for this job (${prior.verdict}); the first stands`);
  }
  store.putOracleVerdict({ jobId: job.id, oracle: v.oracle, verdict: v.verdict, at: now, signed: v as unknown as Record<string, unknown> });
  const all = store.oracleVerdicts(job.id);
  const passes = all.filter((r) => r.verdict === "pass").length;
  const fails = all.filter((r) => r.verdict === "fail").length;
  const n = job.oracles.length;
  store.addEvent({ jobId: job.id, at: now, source: "oracle", status: null, detail: `oracle ${index + 1} (${v.oracle}): ${v.verdict}; ${passes} pass, ${fails} fail of ${n}, ${job.threshold} needed` });
  let status: JobStatus | null = null;
  if (passes >= job.threshold) status = "verified_pass";
  else if (fails > n - job.threshold) status = "verified_fail";
  if (status && job.status === "delivered") {
    store.addEvent({ jobId: job.id, at: now, source: "oracle", status, detail: `${passes} of ${n} oracles passed, ${job.threshold} needed` });
    return store.update(job.id, { status, verdict: status === "verified_pass" ? "pass" : "fail", verifiedAt: now });
  }
  return store.get(job.id)!;
}

/**
 * The criteria a shared job's oracles split on (EDR-016): each criterion that at
 * least one oracle passed and another failed, with who said what. Empty for
 * verdicts without per-criterion results (an unsigned spec).
 */
export function splitCriteria(verdicts: OracleVerdictRecord[]): { id: string; passed: string[]; failed: string[] }[] {
  const by = new Map<string, { passed: string[]; failed: string[] }>();
  for (const v of verdicts) {
    const criteria = (v.signed as { criteria?: unknown }).criteria;
    if (!Array.isArray(criteria)) continue;
    for (const c of criteria as { id?: unknown; pass?: unknown }[]) {
      if (typeof c?.id !== "string") continue;
      const entry = by.get(c.id) ?? { passed: [], failed: [] };
      (c.pass === true ? entry.passed : entry.failed).push(v.oracle);
      by.set(c.id, entry);
    }
  }
  return [...by].filter(([, e]) => e.passed.length > 0 && e.failed.length > 0).map(([id, e]) => ({ id, ...e }));
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

    {
      method: "POST", path: "/jobs",
      handler: (_p, body) => {
        const input = parseNewJob(body);
        if (input.shared && store.byCondition(input.shared.condition)) throw new HttpError(409, "a job with this condition already exists");
        if (isSpecV1(input.spec) && store.bySpecHash(specHash(input.spec))) throw new HttpError(409, "a job with this spec already exists (each spec has its own nonce)");
        return store.create(input);
      },
    },

    {
      method: "GET", path: "/splits",
      handler: () => store.splitJobs().map(({ job, passed, failed }) => ({
        jobId: job.id, status: job.status, threshold: job.threshold, oracles: job.oracles?.map((o) => o.address) ?? [], passed, failed,
        specHash: job.specHash, criteria: splitCriteria(store.oracleVerdicts(job.id)),
      })),
    },

    {
      method: "GET", path: "/jobs",
      handler: (_p, _b, q) => store.list({
        status: q.get("status") ?? undefined, provider: q.get("provider") ?? undefined, client: q.get("client") ?? undefined,
      }),
    },

    { method: "GET", path: "/jobs/:id", handler: ({ id }) => mustGet(id) },

    { method: "POST", path: "/jobs/:id/spec/signatures", handler: ({ id }, body) => applySpecSignature(store, mustGet(id), body) },

    { method: "PUT", path: "/jobs/:id/spec", handler: ({ id }, body) => applySpecRevision(store, mustGet(id), body) },

    { method: "GET", path: "/jobs/:id/spec/revisions", handler: ({ id }) => (mustGet(id), store.specRevisions(id)) },

    {
      method: "PUT", path: "/jobs/:id/condition",
      handler: ({ id }, body, _q, headers) => {
        checkBearer(headers, tokens.oracle, "oracle");
        const job = mustGet(id);
        const condition = isObject(body) ? body.condition : undefined;
        if (typeof condition !== "string" || !/^A0258020[0-9A-F]{64}810120$/.test(condition)) {
          throw new HttpError(400, "condition must be an uppercase PREIMAGE-SHA-256 condition");
        }
        if (job.oracles) throw new HttpError(409, "a shared job's condition is set by its client at creation");
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
      method: "POST", path: "/jobs/:id/verdicts",
      handler: ({ id }, body) => {
        const job = mustGet(id);
        if (!["delivered", "verified_pass", "verified_fail", "paid", "refunded", "expired_unclaimed"].includes(job.status)) {
          throw new HttpError(409, `job is ${job.status}; nothing was delivered to verify`);
        }
        return applyOracleVerdict(store, job, body);
      },
    },

    { method: "GET", path: "/jobs/:id/verdicts", handler: ({ id }) => (mustGet(id), store.oracleVerdicts(id).map((r) => r.signed)) },

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
  // One oracle's token never decides a shared job; its signed verdicts do, k of n (EDR-015).
  if (source === "oracle" && job.oracles) throw new HttpError(409, "a shared job's status follows its signed oracle verdicts (POST /jobs/:id/verdicts)");
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
