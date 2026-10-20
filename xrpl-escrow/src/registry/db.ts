// Job registry storage in SQLite (data/jobs.db). It records the job spec,
// price, parties, condition, escrow sequence, status and timestamps. It never
// stores the secret or the fulfillment.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type JobStatus =
  | "draft" | "funded" | "delivered" | "verified_pass" | "verified_fail"
  | "paid" | "refunded" | "expired_unclaimed";

export const TERMINAL: JobStatus[] = ["paid", "refunded"];

export type CheckSpec =
  | { type: "sha256-match"; sha256: string }
  | { type: "json-schema"; schema: Record<string, unknown> }
  | { type: "max-latency"; maxMs: number };

export interface JobSpec {
  title?: string;
  checks: CheckSpec[];
}

export interface Job {
  id: string;
  client: string;
  provider: string;
  priceDrops: string;
  slaSeconds: number;
  spec: JobSpec;
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
  delivered_at INTEGER, verified_at INTEGER, closed_at INTEGER, updated_at INTEGER NOT NULL`;

type Row = Record<string, unknown>;

function toJob(r: Row): Job {
  return {
    id: r.id as string,
    client: r.client as string,
    provider: r.provider as string,
    priceDrops: r.price_drops as string,
    slaSeconds: r.sla_seconds as number,
    spec: JSON.parse(r.spec as string),
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
    `);
  }

  close() {
    this.db.close();
  }

  create(input: NewJob): Job {
    const now = Date.now();
    const id = randomUUID();
    this.db.prepare(`INSERT INTO jobs (id, client, provider, price_drops, sla_seconds, spec, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`)
      .run(id, input.client, input.provider, input.priceDrops, input.slaSeconds, JSON.stringify(input.spec), now, now);
    this.addEvent({ jobId: id, at: now, source: "registry", status: "draft", detail: "job created" });
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

  /** Reputation stub: per-provider counts computed from the registry. */
  reputation(provider: string) {
    const r = this.db.prepare(`SELECT
        COUNT(*) AS total,
        SUM(verdict = 'pass') AS passed,
        SUM(verdict = 'fail') AS failed,
        SUM(status = 'paid') AS paid,
        SUM(status = 'refunded') AS refunded,
        SUM(status = 'expired_unclaimed') AS expiredUnclaimed
      FROM jobs WHERE provider = ?`).get(provider) as Record<string, number | null>;
    const n = (k: string) => r[k] ?? 0;
    return {
      provider, total: n("total"), passed: n("passed"), failed: n("failed"), paid: n("paid"),
      refunded: n("refunded"), expiredUnclaimed: n("expiredUnclaimed"),
    };
  }
}
