// Job registry storage in SQLite (data/jobs.db). It records the job spec,
// price, parties, condition, escrow sequence, status and timestamps. It never
// stores the secret or the fulfillment.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { TxCheckSpec } from "../oracle/checks/xrpl-tx.js";

export type JobStatus =
  | "draft" | "funded" | "delivered" | "verified_pass" | "verified_fail"
  | "paid" | "refunded" | "expired_unclaimed";

export const TERMINAL: JobStatus[] = ["paid", "refunded"];

export type CheckSpec =
  | { type: "sha256-match"; sha256: string }
  | { type: "json-schema"; schema: Record<string, unknown> }
  | { type: "max-latency"; maxMs: number }
  | TxCheckSpec;

export interface JobSpec {
  title?: string;
  checks: CheckSpec[];
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
  oracles TEXT, threshold INTEGER`;

/** Columns added after a database may already exist; added on open if missing. */
const ADDED_COLUMNS: [string, string][] = [["oracles", "TEXT"], ["threshold", "INTEGER"]];

type Row = Record<string, unknown>;

function toJob(r: Row): Job {
  return {
    id: r.id as string,
    client: r.client as string,
    provider: r.provider as string,
    priceDrops: r.price_drops as string,
    slaSeconds: r.sla_seconds as number,
    spec: JSON.parse(r.spec as string),
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
    this.db.prepare(`INSERT INTO jobs (id, client, provider, price_drops, sla_seconds, spec, status, created_at, updated_at,
        oracles, threshold, condition)
      VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`)
      .run(id, input.client, input.provider, input.priceDrops, input.slaSeconds, JSON.stringify(input.spec), now, now,
        shared ? JSON.stringify(shared.oracles) : null, shared?.threshold ?? null, shared?.condition ?? null);
    this.addEvent({
      jobId: id, at: now, source: "registry", status: "draft",
      detail: shared ? `shared job created: ${shared.threshold} of ${shared.oracles.length} oracles, condition set by the client` : "job created",
    });
    return this.get(id)!;
  }

  get(id: string): Job | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    return row ? toJob(row) : null;
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
    return (this.db.prepare(sql).all(...args) as Row[]).map(toJob);
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
    return row ? toJob(row) : null;
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
