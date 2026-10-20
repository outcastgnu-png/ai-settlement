// In-memory job registry. It records what both parties agreed to and where
// the escrow lives. It stores the condition, never the secret.
export type JobStatus = "open" | "escrowed" | "delivered" | "finished" | "cancelled";

export interface Job {
  id: string;
  client: string;
  provider: string;
  priceDrops: string;
  expectedHash: string; // SHA-256 hex of the deliverable the client will accept
  slaSeconds: number;
  condition: string;
  offerSequence?: number;
  cancelAfter?: number;
  status: JobStatus;
}

export class JobRegistry {
  private jobs = new Map<string, Job>();

  create(job: Omit<Job, "status">): Job {
    if (this.jobs.has(job.id)) throw new Error(`job ${job.id} already exists`);
    if ("secret" in job) throw new Error("the registry never stores the secret");
    const stored: Job = { ...job, status: "open" };
    this.jobs.set(job.id, stored);
    return stored;
  }

  get(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`unknown job ${id}`);
    return job;
  }

  update(id: string, patch: Partial<Omit<Job, "id" | "condition">>): Job {
    const job = Object.assign(this.get(id), patch);
    return job;
  }
}
