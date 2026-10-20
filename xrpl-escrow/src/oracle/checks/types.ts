// A check reads the deliverable as bytes or parsed data and returns a result.
// Checks are deterministic and never execute or follow anything inside the
// deliverable or the job spec.
import type { CheckSpec, Job } from "../../registry/db.js";

export interface CheckContext {
  job: Job;
  content: string; // the deliverable exactly as the registry stored it
  deliveredAt: number; // unix ms
}

export interface CheckResult {
  type: CheckSpec["type"];
  pass: boolean;
  detail: string;
}
