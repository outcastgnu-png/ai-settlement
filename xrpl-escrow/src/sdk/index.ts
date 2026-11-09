// TypeScript SDK for the local escrow kit. It wraps the registry and oracle
// HTTP services and the ledger calls:
//
//   createJob()  register a draft job and get its condition from the oracle
//   fundJob()    client locks the price in an EscrowCreate; resolves once the watcher marks it funded
//   deliver()    provider posts the work and asks the oracle for a verdict (and, on a pass, the fulfillment)
//   claim()      provider submits EscrowFinish with the fulfillment; resolves once the watcher marks it paid
//   refund()     after CancelAfter, submits EscrowCancel; resolves once the watcher marks it refunded
//   verifyVerdictLog()  fetch the oracle's public verdict log and check its chain, signatures and
//                       latest testnet anchor (EDR-014); optionally that your own verdict is in it
//
// Every transaction is signed locally by the wallet that sends it.
import type { Client, Wallet } from "xrpl";
import { signRequest, sha256Hex, verifyPayload } from "../auth.js";
import { cancelEscrow, createEscrow, finishEscrow, sleep, waitPastCancelAfter, type EscrowRef, type TxResult } from "../escrow.js";
import { HttpError, callJson } from "../http.js";
import { ORACLE_URL, REGISTRY_URL, readEnvFile } from "../local-config.js";
import type { Job, JobEvent, JobSpec, JobStatus } from "../registry/db.js";
import type { SignedVerdict, VerdictBody } from "../oracle/server.js";
import { listAnchors } from "../anchors.js";
import { anchorHistoryProblems, checkChain, findVerdict, type Anchor, type LogEntry, type LogHead } from "../verdict-log.js";

export type { Job, JobSpec, JobStatus } from "../registry/db.js";
export type { SignedVerdict } from "../oracle/server.js";
export type { Anchor, LogEntry, LogHead } from "../verdict-log.js";
export { ANCHOR_MEMO_TYPE, anchorHistoryProblems, anchorProblem, checkChain, entryMismatch, findVerdict, verdictInLog } from "../verdict-log.js";
export { listAnchors } from "../anchors.js";

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
  /**
   * The oracle's anchor account, which puts the verdict log's head on the ledger.
   * Defaults to ORACLE_ANCHOR_ADDRESS from .env; never taken from the oracle's /health answer.
   */
  anchorAddress?: string;
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

export interface LogVerification {
  /** True when the chain, every signature and the latest anchor check, and (if asked) your verdict is in the log. */
  ok: boolean;
  problems: string[];
  count: number;
  head: LogHead | null;
  /** The newest anchor on a validated ledger from the pinned anchor account, or null if none was found. */
  anchor: Anchor | null;
  /** Entries written after the anchored one: checked for chain and signature, not yet pinned on the ledger. */
  unanchored: number | null;
  /** Every anchor found within the lookback, newest first. Each one must agree with the log. */
  anchors: Anchor[];
  /** False when the anchor account has more history than was read, so an older anchor could be missing. */
  lookbackComplete: boolean;
  /** When a verdict was passed in: its log entry, or null if the log doesn't have it with matching fields. */
  verdictEntry?: LogEntry | null;
  /** When a verdict was passed in: whether its entry is at or before the newest anchor, so pinned on the ledger. */
  verdictAnchored?: boolean;
}

/** The newest anchor of `verdictAddress`'s log, read from the ledger itself (see `listAnchors`). */
export async function latestAnchor(client: Client, anchorAddress: string, verdictAddress: string, maxTx = 400): Promise<Anchor | null> {
  return (await listAnchors(client, anchorAddress, verdictAddress, maxTx)).anchors[0] ?? null;
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
  readonly anchorAddress: string | null;
  readonly #timeout: number;

  constructor(opts: KitOptions = {}) {
    this.registryUrl = opts.registryUrl ?? REGISTRY_URL;
    this.oracleUrl = opts.oracleUrl ?? ORACLE_URL;
    this.#xrpl = opts.xrpl;
    this.#timeout = opts.statusTimeoutMs ?? 60_000;
    const env = opts.oracleAddress && opts.anchorAddress ? {} : readEnvFile();
    this.oracleAddress = opts.oracleAddress ?? env.ORACLE_VERDICT_ADDRESS ?? null;
    this.anchorAddress = opts.anchorAddress ?? env.ORACLE_ANCHOR_ADDRESS ?? null;
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

  /** Every entry of the oracle's public verdict log, fetched page by page. */
  async fetchVerdictLog(): Promise<LogEntry[]> {
    const entries: LogEntry[] = [];
    for (;;) {
      const page = await callJson<{ entries: LogEntry[]; count: number }>("GET", `${this.oracleUrl}/verdicts?from=${entries.length}`);
      entries.push(...page.entries);
      if (page.entries.length === 0 || entries.length >= page.count) return entries;
    }
  }

  /**
   * Fetch the public verdict log and check it: every entry is signed by the pinned
   * oracle address, the chain is unbroken from the genesis entry, and every anchor
   * on a validated ledger from the pinned anchor account agrees with the log (one
   * genesis only). Pass `verdict` to also check that your own signed verdict is in
   * the log, with every public field matching it, and at or before the newest
   * anchor; `allowUnanchored: true` accepts it in the not-yet-anchored tail
   * (`verdictAnchored` then says false). With `requireAnchor: false`, a log with
   * no anchor yet is not a problem.
   */
  async verifyVerdictLog(opts: {
    verdict?: SignedVerdict; requireAnchor?: boolean; allowUnanchored?: boolean; entries?: LogEntry[];
  } = {}): Promise<LogVerification> {
    const problems: string[] = [];
    if (!this.oracleAddress) problems.push("no pinned oracle address (ORACLE_VERDICT_ADDRESS)");
    const entries = opts.entries ?? await this.fetchVerdictLog();
    const chain = checkChain(entries, this.oracleAddress ?? "");
    if (this.oracleAddress && !chain.ok) problems.push(chain.problem!);
    let history = { anchors: [] as Anchor[], complete: true };
    if (!this.anchorAddress) problems.push("no pinned anchor account (ORACLE_ANCHOR_ADDRESS)");
    else if (this.oracleAddress) {
      history = await listAnchors(this.#ledger(), this.anchorAddress, this.oracleAddress);
      problems.push(...anchorHistoryProblems(entries, history.anchors, this.oracleAddress));
      if (history.anchors.length === 0 && (opts.requireAnchor ?? true)) {
        problems.push(`no anchor from ${this.anchorAddress} found on a validated ledger`);
      }
    }
    const anchor = history.anchors[0] ?? null;
    const result: LogVerification = {
      ok: false, problems, count: entries.length, head: chain.head, anchor,
      unanchored: anchor ? entries.length - 1 - anchor.seq : null, anchors: history.anchors, lookbackComplete: history.complete,
    };
    if (opts.verdict) {
      const found = findVerdict(entries, opts.verdict);
      result.verdictEntry = found.entry;
      result.verdictAnchored = !!(found.entry && anchor && found.entry.seq <= anchor.seq);
      if (found.mismatch) problems.push(found.mismatch);
      else if (!found.entry) problems.push(`verdict for job ${opts.verdict.jobId} is not in the log`);
      else if (!result.verdictAnchored && !opts.allowUnanchored) {
        problems.push(`verdict for job ${opts.verdict.jobId} is entry ${found.entry.seq}, after the newest anchor; it is not pinned on the ledger yet`);
      }
    }
    result.ok = problems.length === 0;
    return result;
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

  /**
   * Ask the oracle to verify the delivered work. Signed by `wallet`; only the job's provider gets an answer.
   * A 503 means the oracle could not run the checks right now (busy, or its checker restarted) and gave no
   * verdict, so this asks again a few times, with a fresh signature each time: 4 attempts over about 6 s.
   * A busy oracle can stay busy for longer than that (Gpno N21). If this still throws a 503, the work stays
   * delivered; call requestVerification again, until shortly before the job's deadline (`cancelAfter`).
   */
  async requestVerification(jobId: string, wallet: Wallet, attempts = 4): Promise<{ verdict: SignedVerdict; fulfillment?: string }> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await callJson("POST", `${this.oracleUrl}/verify/${jobId}`, { auth: signRequest(wallet, "verify", jobId) });
      } catch (err) {
        if (!(err instanceof HttpError && err.status === 503) || attempt >= attempts) throw err;
        await sleep(1000 * attempt);
      }
    }
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
