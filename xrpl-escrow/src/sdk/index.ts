// TypeScript SDK for the local escrow kit. It wraps the registry and oracle
// HTTP services and the ledger calls:
//
//   createJob()  register a draft job and get its condition from the oracle
//   fundJob()    client locks the price in an EscrowCreate; resolves once the watcher marks it funded
//   deliver()    provider posts the work and asks the oracle for a verdict (and, on a pass, the fulfillment)
//   claim()      provider submits EscrowFinish with the fulfillment; resolves once the watcher marks it paid
//   refund()     after CancelAfter, submits EscrowCancel; resolves once the watcher marks it refunded
//
// Every transaction is signed locally by the wallet that sends it.
import type { Client, Wallet } from "xrpl";
import { signRequest, sha256Hex, verifyPayload } from "../auth.js";
import { cancelEscrow, createEscrow, finishEscrow, sleep, waitPastCancelAfter, type EscrowRef, type TxResult } from "../escrow.js";
import { callJson } from "../http.js";
import { ORACLE_URL, REGISTRY_URL, readEnvFile } from "../local-config.js";
import type { Job, JobEvent, JobSpec, JobStatus } from "../registry/db.js";
import type { SignedVerdict, VerdictBody } from "../oracle/server.js";

export type { Job, JobSpec, JobStatus } from "../registry/db.js";
export type { SignedVerdict } from "../oracle/server.js";

export interface KitOptions {
  xrpl?: Client; // needed for fundJob, claim and refund
  registryUrl?: string;
  oracleUrl?: string;
  /**
   * The oracle's verdict signing address. Verdicts are only trusted when signed by
   * this address. Defaults to ORACLE_VERDICT_ADDRESS from .env; never taken from
   * the oracle's own /health answer.
   */
  oracleAddress?: string;
  /** How long to wait for the watcher to reflect a validated transaction. */
  statusTimeoutMs?: number;
}

export interface NewJobInput {
  client: string;
  provider: string;
  priceDrops: string;
  slaSeconds: number;
  spec: JobSpec;
}

export interface DeliverResult {
  job: Job;
  verdict: SignedVerdict;
  verdictSignatureValid: boolean;
  fulfillment: string | null;
}

/** Check a verdict's signature, and that it came from the pinned `oracleAddress`. */
export function verifyVerdict(verdict: SignedVerdict, oracleAddress: string): boolean {
  const { signature, ...unsigned } = verdict;
  if (!oracleAddress || verdict.oracle !== oracleAddress) return false;
  return verifyPayload(unsigned as VerdictBody, signature, verdict.publicKey, verdict.oracle);
}

export const escrowRef = (job: Job): EscrowRef => {
  if (job.offerSequence === null || job.cancelAfter === null || job.condition === null) {
    throw new Error(`job ${job.id} has no escrow on the ledger yet`);
  }
  return { owner: job.client, offerSequence: job.offerSequence, condition: job.condition, cancelAfter: job.cancelAfter };
};

export class EscrowKit {
  readonly registryUrl: string;
  readonly oracleUrl: string;
  readonly #xrpl?: Client;
  readonly oracleAddress: string | null;
  readonly #timeout: number;

  constructor(opts: KitOptions = {}) {
    this.registryUrl = opts.registryUrl ?? REGISTRY_URL;
    this.oracleUrl = opts.oracleUrl ?? ORACLE_URL;
    this.#xrpl = opts.xrpl;
    this.#timeout = opts.statusTimeoutMs ?? 60_000;
    this.oracleAddress = opts.oracleAddress ?? readEnvFile().ORACLE_VERDICT_ADDRESS ?? null;
  }

  #ledger(): Client {
    if (!this.#xrpl) throw new Error("this call needs an xrpl Client: new EscrowKit({ xrpl })");
    return this.#xrpl;
  }

  getJob(jobId: string): Promise<Job> {
    return callJson<Job>("GET", `${this.registryUrl}/jobs/${encodeURIComponent(jobId)}`);
  }

  events(jobId: string): Promise<JobEvent[]> {
    return callJson<JobEvent[]>("GET", `${this.registryUrl}/jobs/${encodeURIComponent(jobId)}/events`);
  }

  reputation(provider: string) {
    return callJson<{ provider: string; total: number; passed: number; failed: number; paid: number; refunded: number; expiredUnclaimed: number }>(
      "GET", `${this.registryUrl}/providers/${provider}/reputation`);
  }

  oracleInfo(): Promise<{ oracle: string; publicKey: string }> {
    return callJson("GET", `${this.oracleUrl}/health`);
  }

  /** Poll the registry until the job reaches one of `statuses`. */
  async waitForStatus(jobId: string, statuses: JobStatus[], timeoutMs = this.#timeout): Promise<Job> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await this.getJob(jobId);
      if (statuses.includes(job.status)) return job;
      if (Date.now() > deadline) throw new Error(`job ${jobId} is ${job.status}, still waiting for ${statuses.join(" or ")}`);
      await sleep(500);
    }
  }

  /** Register a draft job, then have the oracle create its secret and set the condition. */
  async createJob(input: NewJobInput): Promise<Job> {
    const draft = await callJson<Job>("POST", `${this.registryUrl}/jobs`, input);
    await callJson("POST", `${this.oracleUrl}/jobs/${draft.id}/condition`);
    return this.getJob(draft.id);
  }

  /** Client locks the price in escrow. Resolves when the watcher has seen the validated EscrowCreate. */
  async fundJob(jobId: string, clientWallet: Wallet): Promise<{ tx: TxResult; job: Job }> {
    const job = await this.getJob(jobId);
    if (job.status !== "draft" || !job.condition) throw new Error(`job ${jobId} is ${job.status}; only a draft with a condition can be funded`);
    if (clientWallet.address !== job.client) throw new Error("only the job's client can fund it");
    const tx = await createEscrow(this.#ledger(), clientWallet, job.provider, job.priceDrops, job.condition, job.slaSeconds);
    if (tx.code !== "tesSUCCESS") return { tx, job };
    return { tx, job: await this.waitForStatus(jobId, ["funded"]) };
  }

  /** Ask the oracle to verify the delivered work. Signed by `wallet`; only the job's provider gets an answer. */
  async requestVerification(jobId: string, wallet: Wallet): Promise<{ verdict: SignedVerdict; fulfillment?: string }> {
    return callJson("POST", `${this.oracleUrl}/verify/${jobId}`, { auth: signRequest(wallet, "verify", jobId) });
  }

  /** Provider posts the work, then asks the oracle to verify it. */
  async deliver(jobId: string, providerWallet: Wallet, content: string): Promise<DeliverResult> {
    await callJson("POST", `${this.registryUrl}/jobs/${jobId}/deliverable`, {
      content, auth: signRequest(providerWallet, "deliver", jobId, sha256Hex(content)),
    });
    const { verdict, fulfillment } = await this.requestVerification(jobId, providerWallet);
    return {
      job: await this.getJob(jobId),
      verdict,
      verdictSignatureValid: this.oracleAddress !== null && verifyVerdict(verdict, this.oracleAddress)
        && verdict.evidenceHash === sha256Hex(content),
      fulfillment: fulfillment ?? null,
    };
  }

  /** Provider finishes the escrow with the oracle's fulfillment. Resolves when the watcher marks the job paid. */
  async claim(jobId: string, providerWallet: Wallet, fulfillment: string): Promise<{ tx: TxResult; job: Job }> {
    const job = await this.getJob(jobId);
    const tx = await finishEscrow(this.#ledger(), providerWallet, escrowRef(job), fulfillment);
    if (tx.code !== "tesSUCCESS") return { tx, job: await this.getJob(jobId) };
    return { tx, job: await this.waitForStatus(jobId, ["paid"]) };
  }

  /** Waits for a validated ledger past CancelAfter, then cancels. Resolves when the watcher marks the job refunded. */
  async refund(jobId: string, wallet: Wallet): Promise<{ tx: TxResult; job: Job }> {
    const job = await this.getJob(jobId);
    const ref = escrowRef(job);
    await waitPastCancelAfter(this.#ledger(), ref);
    const tx = await cancelEscrow(this.#ledger(), wallet, ref);
    if (tx.code !== "tesSUCCESS") return { tx, job: await this.getJob(jobId) };
    return { tx, job: await this.waitForStatus(jobId, ["refunded"]) };
  }
}
