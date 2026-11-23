// Job registry storage in SQLite (data/jobs.db). It records the job spec,
// price, parties, condition, escrow sequence, status and timestamps. It never
// stores the secret or the fulfillment.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { CheckSpec } from "../check-spec.js";
import { isSpecV1, specHash, type JobSpecV1, type SpecSignature } from "../job-spec.js";

export type { CheckSpec } from "../check-spec.js";

export type JobStatus =
  | "draft" | "funded" | "delivered" | "verified_pass" | "verified_fail"
  | "paid" | "refunded" | "expired_unclaimed";

export const TERMINAL: JobStatus[] = ["paid", "refunded"];

/** The Phase 1 to 5 job spec: a title and a flat list of checks, not signed by anyone ("unsigned spec"). */
export interface LegacyJobSpec {
  title?: string;
  checks: CheckSpec[];
}

/** A job's spec: a signed job spec v1 (EDR-016), or the older unsigned shape. */
export type JobSpec = LegacyJobSpec | JobSpecV1;

/** A revision of a job's v1 spec that a newer revision replaced, kept as it was (EDR-016). */
export interface SpecRevision {
  revision: number;
  specHash: string;
  spec: JobSpecV1;
  signatures: { client: SpecSignature | null; provider: SpecSignature | null };
  replacedAt: number;
}

/** One oracle of a shared job's set (EDR-015). The order is the share order: oracle i holds share x = i + 1. */
export interface OracleRef {
  address: string; // verdict signing address, pinned
  anchor: string; // anchor account of its verdict log, pinned
  url: string; // http://127.0.0.1:<port>
}

/** A shared job's oracle verdict as the registry recorded it, after checking its signature. */
export interface OracleVerdictRecord {
  jobId: string;
  oracle: string;
  verdict: "pass" | "fail";
  at: number;
  signed: Record<string, unknown>; // the full signed verdict
}

export interface Job {
  id: string;
  client: string;
  provider: string;
  priceDrops: string;
  slaSeconds: number;
  spec: JobSpec;
  /** Job spec v1 only (EDR-016): the hash of the current spec, its revision, and the parties' signatures over that hash as posted. Null for an unsigned (Phase 1 to 5) spec. */
  specHash: string | null;
  specRevision: number | null;
  specSignatures: { client: SpecSignature | null; provider: SpecSignature | null } | null;
  /** Shared jobs only (EDR-015): the oracle set and how many passes release the funds. Null for single-oracle jobs. */
  oracles: OracleRef[] | null;
  threshold: number | null;
  condition: string | null;
  offerSequence: number | null;
  cancelAfter: number | null; // Ripple epoch seconds
  status: JobStatus;
  verdict: "pass" | "fail" | null;
  expiringSoon: boolean;
  createTx: string | null;
  finishTx: string | null;
  cancelTx: string | null;
  createdAt: number; // unix ms, for every *At field
  fundedAt: number | null;
  deliveredAt: number | null;
  verifiedAt: number | null;
  closedAt: number | null;
  updatedAt: number;
}

export interface Deliverable {
  jobId: string;
  content: string;
  sha256: string;
  deliveredAt: number;
}

export interface JobEvent {
  jobId: string;
  at: number;
  source: "ledger" | "oracle" | "registry";
  status: JobStatus | null;
  detail: string;
}

export interface NewJob {
  client: string;
  provider: string;
  priceDrops: string;
  slaSeconds: number;
  spec: JobSpec;
  /** Shared jobs: the set, threshold and the client's condition, all set at creation. */
  shared?: { oracles: OracleRef[]; threshold: number; condition: string };
}

/** Which status a non-ledger source may move a job to, from which status. */
const NEXT: Record<JobStatus, JobStatus[]> = {
  draft: ["funded"],
  funded: ["delivered", "refunded"],
  delivered: ["verified_pass", "verified_fail", "refunded"],
  verified_pass: ["paid", "expired_unclaimed", "refunded"],
  verified_fail: ["refunded"],
  expired_unclaimed: ["refunded"],
  paid: [],
  refunded: [],
};

export function canMove(from: JobStatus, to: JobStatus): boolean {
  return NEXT[from].includes(to);
}

const COLUMNS = `
  id TEXT PRIMARY KEY, client TEXT NOT NULL, provider TEXT NOT NULL, price_drops TEXT NOT NULL,
  sla_seconds INTEGER NOT NULL, spec TEXT NOT NULL, condition TEXT, offer_sequence INTEGER,
  cancel_after INTEGER, status TEXT NOT NULL, verdict TEXT, expiring_soon INTEGER NOT NULL DEFAULT 0,
  create_tx TEXT, finish_tx TEXT, cancel_tx TEXT, created_at INTEGER NOT NULL, funded_at INTEGER,
  delivered_at INTEGER, verified_at INTEGER, closed_at INTEGER, updated_at INTEGER NOT NULL,
  oracles TEXT, threshold INTEGER, spec_hash TEXT, spec_revision INTEGER`;

/** Columns added after a database may already exist; added on open if missing. */
const ADDED_COLUMNS: [string, string][] = [["oracles", "TEXT"], ["threshold", "INTEGER"], ["spec_hash", "TEXT"], ["spec_revision", "INTEGER"]];

type Row = Record<string, unknown>;

function toJob(r: Row, sigs: Job["specSignatures"]): Job {
  return {
    id: r.id as string,
    client: r.client as string,
    provider: r.provider as string,
    priceDrops: r.price_drops as string,
    slaSeconds: r.sla_seconds as number,
    spec: JSON.parse(r.spec as string),
    specHash: (r.spec_hash as string) ?? null,
    specRevision: (r.spec_revision as number) ?? null,
    specSignatures: r.spec_hash ? sigs : null,
    oracles: r.oracles ? JSON.parse(r.oracles as string) : null,
    threshold: (r.threshold as number) ?? null,
    condition: (r.condition as string) ?? null,
    offerSequence: (r.offer_sequence as number) ?? null,
    cancelAfter: (r.cancel_after as number) ?? null,
    status: r.status as JobStatus,
    verdict: (r.verdict as Job["verdict"]) ?? null,
    expiringSoon: r.expiring_soon === 1,
    createTx: (r.create_tx as string) ?? null,
    finishTx: (r.finish_tx as string) ?? null,
    cancelTx: (r.cancel_tx as string) ?? null,
    createdAt: r.created_at as number,
    fundedAt: (r.funded_at as number) ?? null,
    deliveredAt: (r.delivered_at as number) ?? null,
    verifiedAt: (r.verified_at as number) ?? null,
    closedAt: (r.closed_at as number) ?? null,
    updatedAt: r.updated_at as number,
  };
}

const FIELD_TO_COLUMN: Record<string, string> = {
  condition: "condition", offerSequence: "offer_sequence", cancelAfter: "cancel_after", status: "status",
  verdict: "verdict", expiringSoon: "expiring_soon", createTx: "create_tx", finishTx: "finish_tx",
  cancelTx: "cancel_tx", fundedAt: "funded_at", deliveredAt: "delivered_at", verifiedAt: "verified_at",
  closedAt: "closed_at",
};

export type JobPatch = Partial<Pick<Job,
  "condition" | "offerSequence" | "cancelAfter" | "status" | "verdict" | "expiringSoon" | "createTx" | "finishTx"
  | "cancelTx" | "fundedAt" | "deliveredAt" | "verifiedAt" | "closedAt">>;

export class JobStore {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (${COLUMNS});
      CREATE TABLE IF NOT EXISTS deliverables (
        job_id TEXT PRIMARY KEY REFERENCES jobs(id), content TEXT NOT NULL, sha256 TEXT NOT NULL,
        delivered_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        job_id TEXT NOT NULL REFERENCES jobs(id), at INTEGER NOT NULL, source TEXT NOT NULL,
        status TEXT, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS spec_signatures (
        job_id TEXT NOT NULL REFERENCES jobs(id), spec_hash TEXT NOT NULL, role TEXT NOT NULL, signed TEXT NOT NULL,
        at INTEGER NOT NULL, PRIMARY KEY (job_id, spec_hash, role));
      CREATE TABLE IF NOT EXISTS spec_revisions (
        job_id TEXT NOT NULL REFERENCES jobs(id), revision INTEGER NOT NULL, spec_hash TEXT NOT NULL, spec TEXT NOT NULL,
        replaced_at INTEGER NOT NULL, PRIMARY KEY (job_id, revision));
      CREATE TABLE IF NOT EXISTS oracle_verdicts (
        job_id TEXT NOT NULL REFERENCES jobs(id), oracle TEXT NOT NULL, verdict TEXT NOT NULL, at INTEGER NOT NULL,
        signed TEXT NOT NULL, PRIMARY KEY (job_id, oracle));
    `);
    const have = new Set((this.db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map((c) => c.name));
    for (const [name, type] of ADDED_COLUMNS) if (!have.has(name)) this.db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`);
  }

  close() {
    this.db.close();
  }

  create(input: NewJob): Job {
    const now = Date.now();
    const id = randomUUID();
    const shared = input.shared;
    const v1 = isSpecV1(input.spec) ? input.spec : null;
    const hash = v1 ? specHash(v1) : null;
    this.db.prepare(`INSERT INTO jobs (id, client, provider, price_drops, sla_seconds, spec, status, created_at, updated_at,
        oracles, threshold, condition, spec_hash, spec_revision)
      VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.client, input.provider, input.priceDrops, input.slaSeconds, JSON.stringify(input.spec), now, now,
        shared ? JSON.stringify(shared.oracles) : null, shared?.threshold ?? null, shared?.condition ?? null, hash, v1?.revision ?? null);
    const what = shared ? `shared job created: ${shared.threshold} of ${shared.oracles.length} oracles, condition set by the client` : "job created";
    this.addEvent({
      jobId: id, at: now, source: "registry", status: "draft",
      detail: v1 ? `${what}; job spec v1 revision ${v1.revision}, hash ${hash}, waiting for both signatures` : `${what}; unsigned spec`,
    });
    return this.get(id)!;
  }

  get(id: string): Job | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    return row ? this.#toJob(row) : null;
  }

  #toJob(r: Row): Job {
    return toJob(r, r.spec_hash ? this.specSignatures(r.id as string, r.spec_hash as string) : null);
  }

  /** The parties' signatures recorded for this hash of a job's spec. */
  specSignatures(jobId: string, hash: string): { client: SpecSignature | null; provider: SpecSignature | null } {
    const rows = this.db.prepare("SELECT role, signed FROM spec_signatures WHERE job_id = ? AND spec_hash = ?").all(jobId, hash) as Row[];
    const of = (role: string) => {
      const r = rows.find((x) => x.role === role);
      return r ? (JSON.parse(r.signed as string) as SpecSignature) : null;
    };
    return { client: of("client"), provider: of("provider") };
  }

  /** Record a party's checked signature over a spec hash. False if that party already has one for it (the first is kept). */
  putSpecSignature(jobId: string, hash: string, role: "client" | "provider", sig: SpecSignature): boolean {
    const r = this.db.prepare("INSERT OR IGNORE INTO spec_signatures (job_id, spec_hash, role, signed, at) VALUES (?, ?, ?, ?, ?)")
      .run(jobId, hash, role, JSON.stringify(sig), Date.now());
    return r.changes === 1;
  }

  /** The job using this spec hash, if any: a spec belongs to one job only. */
  bySpecHash(hash: string): Job | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE spec_hash = ?").get(hash) as Row | undefined;
    if (row) return this.#toJob(row);
    const old = this.db.prepare("SELECT job_id FROM spec_revisions WHERE spec_hash = ?").get(hash) as Row | undefined;
    return old ? this.get(old.job_id as string) : null;
  }

  /**
   * Replace a draft job's v1 spec with its next revision. The old revision is kept,
   * with its signatures, in spec_revisions; the new one starts with none. Price and
   * SLA follow the new spec. The caller checks who may do this and when.
   */
  reviseSpec(id: string, next: JobSpecV1): Job {
    const job = this.get(id)!;
    const now = Date.now();
    const hash = specHash(next);
    const tx = this.db.transaction(() => {
      this.db.prepare("INSERT INTO spec_revisions (job_id, revision, spec_hash, spec, replaced_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, job.specRevision, job.specHash, JSON.stringify(job.spec), now);
      this.db.prepare("UPDATE jobs SET spec = ?, spec_hash = ?, spec_revision = ?, price_drops = ?, sla_seconds = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(next), hash, next.revision, next.priceDrops, next.slaSeconds, now, id);
      this.addEvent({ jobId: id, at: now, source: "registry", status: null, detail: `spec revision ${next.revision} replaces revision ${job.specRevision}; new hash ${hash}, waiting for both signatures` });
    });
    tx();
    return this.get(id)!;
  }

  /** Earlier revisions of a job's v1 spec, oldest first, each with the signatures it had. */
  specRevisions(id: string): SpecRevision[] {
    return (this.db.prepare("SELECT * FROM spec_revisions WHERE job_id = ? ORDER BY revision").all(id) as Row[]).map((r) => ({
      revision: r.revision as number, specHash: r.spec_hash as string, spec: JSON.parse(r.spec as string),
      signatures: this.specSignatures(id, r.spec_hash as string), replacedAt: r.replaced_at as number,
    }));
  }

  list(filter: { status?: string; provider?: string; client?: string } = {}): Job[] {
    const where: string[] = [];
    const args: string[] = [];
    for (const [key, column] of [["status", "status"], ["provider", "provider"], ["client", "client"]] as const) {
      if (filter[key]) {
        where.push(`${column} = ?`);
        args.push(filter[key]!);
      }
    }
    const sql = `SELECT * FROM jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at`;
    return (this.db.prepare(sql).all(...args) as Row[]).map((r) => this.#toJob(r));
  }

  update(id: string, patch: JobPatch): Job {
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [field, value] of Object.entries(patch)) {
      const column = FIELD_TO_COLUMN[field];
      if (!column || value === undefined) continue;
      sets.push(`${column} = ?`);
      args.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
    }
    sets.push("updated_at = ?");
    args.push(Date.now(), id);
    this.db.prepare(`UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`).run(...args);
    return this.get(id)!;
  }

  /** The job using `condition`, if any: a condition belongs to one job only. */
  byCondition(condition: string): Job | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE condition = ?").get(condition) as Row | undefined;
    return row ? this.#toJob(row) : null;
  }

  /** Record an oracle's verdict for a shared job. False if that oracle already has one (the first is kept). */
  putOracleVerdict(v: OracleVerdictRecord): boolean {
    const r = this.db.prepare("INSERT OR IGNORE INTO oracle_verdicts (job_id, oracle, verdict, at, signed) VALUES (?, ?, ?, ?, ?)")
      .run(v.jobId, v.oracle, v.verdict, v.at, JSON.stringify(v.signed));
    return r.changes === 1;
  }

  oracleVerdicts(jobId: string): OracleVerdictRecord[] {
    return (this.db.prepare("SELECT * FROM oracle_verdicts WHERE job_id = ? ORDER BY at, oracle").all(jobId) as Row[]).map((r) => ({
      jobId, oracle: r.oracle as string, verdict: r.verdict as "pass" | "fail", at: r.at as number, signed: JSON.parse(r.signed as string),
    }));
  }

  /** Shared jobs whose oracles disagreed: at least one pass and one fail. */
  splitJobs(): { job: Job; passed: string[]; failed: string[] }[] {
    const ids = (this.db.prepare(`SELECT job_id FROM oracle_verdicts GROUP BY job_id
      HAVING SUM(verdict = 'pass') > 0 AND SUM(verdict = 'fail') > 0 ORDER BY MIN(at)`).all() as { job_id: string }[]).map((r) => r.job_id);
    return ids.map((id) => {
      const vs = this.oracleVerdicts(id);
      return {
        job: this.get(id)!, passed: vs.filter((v) => v.verdict === "pass").map((v) => v.oracle),
        failed: vs.filter((v) => v.verdict === "fail").map((v) => v.oracle),
      };
    });
  }

  putDeliverable(d: Deliverable) {
    this.db.prepare("INSERT INTO deliverables (job_id, content, sha256, delivered_at) VALUES (?, ?, ?, ?)")
      .run(d.jobId, d.content, d.sha256, d.deliveredAt);
  }

  getDeliverable(jobId: string): Deliverable | null {
    const r = this.db.prepare("SELECT * FROM deliverables WHERE job_id = ?").get(jobId) as Row | undefined;
    return r ? { jobId, content: r.content as string, sha256: r.sha256 as string, deliveredAt: r.delivered_at as number } : null;
  }

  addEvent(e: JobEvent) {
    this.db.prepare("INSERT INTO events (job_id, at, source, status, detail) VALUES (?, ?, ?, ?, ?)")
      .run(e.jobId, e.at, e.source, e.status, e.detail);
  }

  events(jobId: string): JobEvent[] {
    return (this.db.prepare("SELECT * FROM events WHERE job_id = ? ORDER BY rowid").all(jobId) as Row[]).map((r) => ({
      jobId, at: r.at as number, source: r.source as JobEvent["source"], status: (r.status as JobStatus) ?? null,
      detail: r.detail as string,
    }));
  }

  /**
   * Reputation stub: per-provider counts computed from the registry. A passed
   * job nobody claimed in time is later refunded, so `expiredUnclaimed` counts
   * jobs that ever reached that status (from the event log), not jobs whose
   * current status is still expired_unclaimed.
   */
  reputation(provider: string) {
    const r = this.db.prepare(`SELECT
        COUNT(*) AS total,
        SUM(verdict = 'pass') AS passed,
        SUM(verdict = 'fail') AS failed,
        SUM(status = 'paid') AS paid,
        SUM(status = 'refunded') AS refunded,
        SUM(EXISTS (SELECT 1 FROM events e WHERE e.job_id = jobs.id AND e.status = 'expired_unclaimed')) AS expiredUnclaimed
      FROM jobs WHERE provider = ?`).get(provider) as Record<string, number | null>;
    const n = (k: string) => r[k] ?? 0;
    return {
      provider, total: n("total"), passed: n("passed"), failed: n("failed"), paid: n("paid"),
      refunded: n("refunded"), expiredUnclaimed: n("expiredUnclaimed"),
    };
  }
}
