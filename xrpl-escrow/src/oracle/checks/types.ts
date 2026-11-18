// A check reads the deliverable as bytes or parsed data and returns a result.
// Checks are deterministic and never execute or follow anything inside the
// deliverable or the job spec.
import type { CheckSpec, Job } from "../../registry/db.js";
import type { TxLookup } from "./xrpl-tx.js";

export interface CheckContext {
  job: Job;
  content: string; // the deliverable exactly as the registry stored it
  deliveredAt: number; // unix ms
  /** Reads a transaction from the testnet, for xrpl-tx-validated. Absent when the oracle has no ledger connection. */
  lookupTx?: TxLookup;
}

export interface CheckResult {
  /** "oracle-fault": not a check of the work; an oracle started with ORACLE_FAULT=fail adds it, failing every verdict (demos of a dissenting oracle). */
  type: CheckSpec["type"] | "oracle-fault";
  pass: boolean;
  detail: string;
}
