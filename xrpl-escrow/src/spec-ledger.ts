// The ledger side of the signed job spec (EDR-016): read the spec memo from a
// job's EscrowCreate in a validated ledger and compare it with a spec.
//
// The oracle finds the EscrowCreate from the open escrow's PreviousTxnID (the
// escrow object is only ever modified by the transaction that created it), so
// it never takes the transaction hash from the registry. The SDK, checking a
// verdict after the escrow may already be finished, looks the creating
// transaction up by hash and accepts it only if a validated ledger says it is
// an EscrowCreate from the job's client, to its provider, with the verdict's
// condition; only that transaction can be the job's escrow.
import type { Client } from "xrpl";
import { getEscrow } from "./escrow.js";
import { agreementProblems, isSpecV1, parseSpecMemo, specHash, specProblem, type SpecMemo } from "./job-spec.js";
import type { TxLookup } from "./oracle/checks/xrpl-tx.js";
import type { Job } from "./registry/db.js";

/** What the job's EscrowCreate must be, apart from its memo. */
export interface EscrowCreateExpect {
  owner: string; // the client
  destination: string; // the provider
  condition: string;
  offerSequence?: number;
  amount?: string;
}

/**
 * Read the spec memo of the EscrowCreate `txHash`, after checking in a validated
 * ledger that the transaction is that job's EscrowCreate and succeeded.
 * Returns the memo, or what is wrong.
 */
export async function escrowCreateSpecMemo(lookupTx: TxLookup, txHash: string, expect: EscrowCreateExpect): Promise<{ memo: SpecMemo } | { problem: string }> {
  if (!/^[0-9A-Fa-f]{64}$/.test(txHash)) return { problem: "no EscrowCreate transaction hash for the job" };
  const found = await lookupTx(txHash);
  if (!found.found) return { problem: `EscrowCreate ${txHash} is not on the ledger` };
  if (!found.validated) return { problem: `EscrowCreate ${txHash} is not in a validated ledger` };
  const tx = found.tx;
  if (found.meta?.TransactionResult !== "tesSUCCESS") return { problem: `transaction ${txHash} did not succeed` };
  if (tx.TransactionType !== "EscrowCreate") return { problem: `transaction ${txHash} is a ${String(tx.TransactionType)}, not an EscrowCreate` };
  if (tx.Account !== expect.owner) return { problem: "the EscrowCreate was not sent by the job's client" };
  if (tx.Destination !== expect.destination) return { problem: "the EscrowCreate does not pay the job's provider" };
  if (tx.Condition !== expect.condition) return { problem: "the EscrowCreate does not carry the job's condition" };
  if (expect.offerSequence !== undefined && tx.Sequence !== expect.offerSequence) return { problem: "the EscrowCreate's sequence is not the job's escrow sequence" };
  if (expect.amount !== undefined && tx.Amount !== expect.amount) return { problem: "the EscrowCreate's amount is not the job's price" };
  const memo = parseSpecMemo(tx.Memos);
  if (memo === null) return { problem: "the EscrowCreate carries no job spec memo" };
  if ("problem" in memo) return { problem: memo.problem };
  return { memo };
}

/** Returns null when the job's v1 spec is the one locked on the ledger and both parties signed it, otherwise what is wrong. */
export type SpecCheck = (job: Job) => Promise<string | null>;

/**
 * The oracle's check before it verifies a job with a v1 spec: the spec it read
 * from the registry is well formed, names the job's parties, price and SLA, has
 * the hash in the memo of the job's EscrowCreate (found from the open escrow's
 * PreviousTxnID on a validated ledger), and both parties' signatures over that
 * hash check. Anything else is refused, and the client is refunded after the
 * deadline.
 */
export function ledgerSpecCheck(client: Client, lookupTx: TxLookup): SpecCheck {
  return async (job) => {
    if (!isSpecV1(job.spec)) return null;
    if (job.offerSequence === null || job.cancelAfter === null || job.condition === null) return "job has no escrow recorded";
    const escrow = await getEscrow(client, { owner: job.client, offerSequence: job.offerSequence, condition: job.condition, cancelAfter: job.cancelAfter });
    if (!escrow) return "no open escrow on the ledger for this job";
    const prev = (escrow as { PreviousTxnID?: unknown }).PreviousTxnID;
    if (typeof prev !== "string") return "the escrow object names no PreviousTxnID";
    const read = await escrowCreateSpecMemo(lookupTx, prev, {
      owner: job.client, destination: job.provider, condition: job.condition, offerSequence: job.offerSequence, amount: job.priceDrops,
    });
    if ("problem" in read) return read.problem;
    return specAgainstMemo(job, read.memo);
  };
}

/** Compare the spec the registry holds for a job with the memo on its EscrowCreate, and check both signatures. */
export function specAgainstMemo(job: Job, memo: SpecMemo): string | null {
  if (!isSpecV1(job.spec)) return "the job has no v1 spec";
  const problem = specProblem(job.spec);
  if (problem) return `the registry's spec is not a valid job spec: ${problem}`;
  const spec = job.spec;
  if (spec.client !== job.client || spec.provider !== job.provider || spec.priceDrops !== job.priceDrops || spec.slaSeconds !== job.slaSeconds) {
    return "the registry's spec names other parties, price or SLA than the job";
  }
  const hash = specHash(spec);
  if (memo.specHash !== hash || memo.revision !== spec.revision) {
    return `the registry's spec (revision ${spec.revision}, hash ${hash}) is not the spec locked on the ledger `
      + `(revision ${memo.revision}, hash ${memo.specHash})`;
  }
  const agreement = agreementProblems(spec, job.specSignatures ?? {});
  if (agreement.length) return agreement.join("; ");
  return null;
}
