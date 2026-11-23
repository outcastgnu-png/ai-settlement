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
// Shared verification, k of n oracles (EDR-015):
//
//   createSharedJob()  the client makes the secret, splits it k of n, seals each share to one oracle of
//                      the set and registers the job with the condition; the secret itself is dropped
//   deliverShared()    provider posts the work and asks every oracle of the set; each signed verdict is
//                      checked against its pinned address and its own verdict log, and k shares from
//                      passing oracles of the set are combined into the fulfillment
//   splitJobs()        shared jobs where the oracles of the set disagreed, and on which criteria
//
// Signed job specs (EDR-016):
//
//   makeJobSpec()      write a job spec v1: criteria, the checks that decide each, and the rule
//   createJob() / createSharedJob()  take a v1 spec as `spec`; the job's parties, price and SLA come from it
//   signSpec()         client or provider signs the spec hash it read; the provider's signature is its acceptance
//   reviseSpec()       the client replaces a draft's spec with its next revision; both sign again
//   fundJob()          refuses to lock XRP until both signatures over the spec check, and puts the
//                      spec hash in a memo on the EscrowCreate
//   deliver() / deliverShared()  check that every verdict judged that same spec hash
//
// Every transaction is signed locally by the wallet that sends it.
import type { Client, Wallet } from "xrpl";
import { canonicalJson, newJobHash, signRequest, sha256Hex, verifyPayload } from "../auth.js";
import { makeSecret, toCondition, toFulfillment } from "../condition.js";
import { choose, combine, decodeShare, encodeShare, split, type Share } from "../shamir.js";
import { seal, verifyShareKey } from "../share-box.js";
import type { AnchorHistory } from "../anchors.js";
import { cancelEscrow, createEscrow, finishEscrow, sleep, waitPastCancelAfter, type EscrowRef, type TxResult } from "../escrow.js";
import {
  agreementProblems, isSpecV1, signSpecHash, specHash, specMemos, specProblem, type JobSpecV1,
} from "../job-spec.js";
import { ledgerTxLookup, type TxLookup } from "../oracle/checks/xrpl-tx.js";
import { escrowCreateSpecMemo } from "../spec-ledger.js";
import { HttpError, callJson } from "../http.js";
import { ORACLE_URL, REGISTRY_URL, readEnvFile } from "../local-config.js";
import type { Job, JobEvent, JobSpec, JobStatus, OracleRef } from "../registry/db.js";
import type { SignedVerdict, VerdictBody } from "../oracle/server.js";
import { listAnchors } from "../anchors.js";
import { anchorHistoryProblems, checkChain, duplicateJobProblems, findVerdict, type Anchor, type LogEntry, type LogHead } from "../verdict-log.js";

export type { Job, JobSpec, JobStatus, OracleRef } from "../registry/db.js";
export { choose, combine, decodeShare, encodeShare, split } from "../shamir.js";
export type { SignedVerdict } from "../oracle/server.js";
export type { Anchor, LogEntry, LogHead } from "../verdict-log.js";
export { ANCHOR_MEMO_TYPE, anchorHistoryProblems, anchorProblem, checkChain, duplicateJobProblems, entryMismatch, findVerdict, verdictInLog } from "../verdict-log.js";
export { listAnchors } from "../anchors.js";
export { localOracleSet } from "../local-config.js";
export {
  SPEC_MEMO_TYPE, agreementProblems, isSpecV1, jcs, makeJobSpec, meetsRule, parseSpecMemo, reviseJobSpec, ruleText, signSpecHash,
  specHash, specMemos, specProblem, verifySpecSignature,
} from "../job-spec.js";
export type { Criterion, CriterionResult, JobSpecV1, SpecMemo, SpecRule, SpecSignature } from "../job-spec.js";
export { escrowCreateSpecMemo } from "../spec-ledger.js";

/** The hash of a job's v1 spec, worked out here from the spec itself (never taken from the registry), or null for an unsigned spec. */
export const jobSpecHash = (job: Job): string | null => (isSpecV1(job.spec) ? specHash(job.spec) : null);

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
  /** Reads an anchor account's anchors from the ledger. Defaults to `listAnchors` on the xrpl Client; tests pass a stand-in. */
  listAnchors?: (anchorAddress: string, verdictAddress: string, maxTx?: number) => Promise<AnchorHistory>;
  /** Reads a transaction from the ledger, for the spec memo of a job's EscrowCreate. Defaults to the xrpl Client; tests pass a stand-in. */
  lookupTx?: TxLookup;
}

export interface SharedJobInput extends NewJobInput {
  /** The pinned oracle set, in share order: oracle i gets share x = i + 1. */
  oracles: OracleRef[];
  /** How many passes release the funds (k). */
  threshold: number;
}

/** What one oracle of a shared job's set answered, and what the provider's SDK made of it. */
export interface OracleReport {
  oracle: OracleRef;
  index: number; // share x
  /**
   * pass / fail: a verdict that checked. rejected: a verdict came back but did not check
   * (signature, fields, spec hash, share or verdict log), so it is not used. refused: the
   * oracle answered but would not verify the job (409), for example because the spec it was
   * given is not the one locked on the ledger (EDR-016). unreachable: no answer.
   */
  status: "pass" | "fail" | "rejected" | "refused" | "unreachable";
  verdict?: SignedVerdict;
  problems: string[];
  log?: LogVerification;
  /** True when this oracle's share went into the fulfillment. */
  used: boolean;
}

export interface SharedVerification {
  job: Job;
  reports: OracleReport[];
  passed: string[];
  failed: string[];
  rejected: string[];
  refused: string[];
  unreachable: string[];
  /** The fulfillment from k shares of passing oracles, or null with fewer than k usable passes. */
  fulfillment: string | null;
  /** The spec hash every used verdict judged (worked out from the job's spec), or null for an unsigned spec (EDR-016). */
  specHash: string | null;
  unsignedSpec: boolean;
}

export interface SharedVerifyOptions {
  /** The set you pinned. When given it must equal the job's set in the registry; otherwise the job's set is used. */
  oracles?: OracleRef[];
  /**
   * Only use a share whose verdict is at or before its oracle's newest anchor (and so only from an oracle with an anchor).
   * Default false (owner's choice, 2026-11-18): a verdict not yet anchored counts when its signature and chain check
   * and every anchor already on the ledger agrees with the log.
   */
  requireAnchored?: boolean;
  /** How often to ask an oracle that answers 503 (busy). */
  attempts?: number;
}

/** A share from an oracle of the set, as `combineForCondition` takes it. */
export interface OracleShare {
  oracle: string; // verdict address
  share: string; // hex as encodeShare writes it
}

/**
 * Combine shares into the fulfillment for `condition`. Only shares from oracles of
 * `set`, each at its own position (x = index + 1), are used; a share from outside
 * the set or at the wrong position throws. With fewer than `threshold` shares the
 * answer is null. Every set of `threshold` shares is tried until one rebuilds a
 * secret that matches the condition, so one wrong share among k+1 does no harm.
 */
export function combineForCondition(shares: OracleShare[], set: OracleRef[], threshold: number, condition: string): { fulfillment: string; used: string[] } | null {
  const parsed: { oracle: string; share: Share }[] = [];
  for (const s of shares) {
    const i = set.findIndex((o) => o.address === s.oracle);
    if (i < 0) throw new Error(`${s.oracle} is not in the job's oracle set; its share is never used`);
    const share = decodeShare(s.share);
    if (share.x !== i + 1) throw new Error(`${s.oracle} holds share ${i + 1}, but sent share ${share.x}`);
    if (parsed.some((p) => p.oracle === s.oracle)) throw new Error(`${s.oracle} sent two shares`);
    parsed.push({ oracle: s.oracle, share });
  }
  if (threshold < 2 || parsed.length < threshold) return null;
  for (const pick of choose(parsed, threshold)) {
    const secret = combine(pick.map((p) => p.share));
    try {
      if (toCondition(secret) === condition) return { fulfillment: toFulfillment(secret), used: pick.map((p) => p.oracle) };
    } finally {
      secret.fill(0);
    }
  }
  return null;
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
  /** Signed by the pinned oracle, for this deliverable, and (for a v1 spec) for the job's signed spec hash. */
  verdictSignatureValid: boolean;
  fulfillment: string | null;
  /** The job's spec hash, worked out from its spec, or null for an unsigned spec (EDR-016). */
  specHash: string | null;
  /** True when the verdict judged exactly that spec hash. */
  specMatches: boolean;
  unsignedSpec: boolean;
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
  /**
   * When a verdict on a signed spec and its job were passed in (EDR-016): whether the spec hash in
   * the verdict is the one in the memo of the job's EscrowCreate on a validated ledger.
   */
  specOnLedger?: boolean;
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

/** The registry body for a new job. A v1 spec supplies the client, provider, price and SLA, and any given beside it must agree. */
function jobBody(input: NewJobInput | { spec: JobSpecV1 }): NewJobInput {
  const spec = input.spec;
  if (!isSpecV1(spec)) return input as NewJobInput;
  const problem = specProblem(spec);
  if (problem) throw new Error(`job spec refused before anything was sent: ${problem}`);
  const given = input as Partial<NewJobInput>;
  for (const k of ["client", "provider", "priceDrops", "slaSeconds"] as const) {
    if (given[k] !== undefined && given[k] !== spec[k]) throw new Error(`${k} differs from the one in the spec`);
  }
  return { client: spec.client, provider: spec.provider, priceDrops: spec.priceDrops, slaSeconds: spec.slaSeconds, spec };
}

export class EscrowKit {
  readonly registryUrl: string;
  readonly oracleUrl: string;
  readonly #xrpl?: Client;
  readonly oracleAddress: string | null;
  readonly anchorAddress: string | null;
  readonly #timeout: number;
  readonly #listAnchors?: KitOptions["listAnchors"];
  readonly #lookupTx?: TxLookup;

  constructor(opts: KitOptions = {}) {
    this.registryUrl = opts.registryUrl ?? REGISTRY_URL;
    this.oracleUrl = opts.oracleUrl ?? ORACLE_URL;
    this.#xrpl = opts.xrpl;
    this.#timeout = opts.statusTimeoutMs ?? 60_000;
    this.#listAnchors = opts.listAnchors;
    this.#lookupTx = opts.lookupTx;
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
   * genesis only), and no job has more than one verdict entry. Pass `verdict` to also check that your own signed verdict is in
   * the log, with every entry that names it matching it, and at or before the newest
   * anchor; `allowUnanchored: true` accepts it in the not-yet-anchored tail
   * (`verdictAnchored` then says false). With `requireAnchor: false`, a log with
   * no anchor yet is not a problem. If the anchor account has more transactions
   * than `maxTx` (default 10,000), older anchors can't be read and `ok` is false
   * (Gpno N32).
   */
  async verifyVerdictLog(opts: {
    verdict?: SignedVerdict; requireAnchor?: boolean; allowUnanchored?: boolean; entries?: LogEntry[]; maxTx?: number;
    /** With `verdict` on a signed spec: also check its spec hash against the memo of this job's EscrowCreate (EDR-016). */
    job?: Job;
  } = {}): Promise<LogVerification> {
    const problems: string[] = [];
    if (!this.oracleAddress) problems.push("no pinned oracle address (ORACLE_VERDICT_ADDRESS)");
    const entries = opts.entries ?? await this.fetchVerdictLog();
    const chain = checkChain(entries, this.oracleAddress ?? "");
    if (this.oracleAddress && !chain.ok) problems.push(chain.problem!);
    problems.push(...duplicateJobProblems(entries));
    let history = { anchors: [] as Anchor[], complete: true };
    if (!this.anchorAddress) problems.push("no pinned anchor account (ORACLE_ANCHOR_ADDRESS)");
    else if (this.oracleAddress) {
      history = this.#listAnchors
        ? await this.#listAnchors(this.anchorAddress, this.oracleAddress, opts.maxTx)
        : await listAnchors(this.#ledger(), this.anchorAddress, this.oracleAddress, opts.maxTx);
      if (!history.complete) {
        problems.push(`${this.anchorAddress} has more transactions than the lookback reads (maxTx); older anchors were not checked`);
      }
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
      const judged = opts.verdict.specHash;
      if (opts.job && typeof judged === "string") {
        const p = await this.#specOnLedgerProblem(opts.job, opts.verdict);
        result.specOnLedger = p === null;
        if (p) problems.push(p);
      }
    }
    result.ok = problems.length === 0;
    return result;
  }

  /** Null when the verdict's spec hash is the one in the memo of the job's EscrowCreate on a validated ledger. */
  async #specOnLedgerProblem(job: Job, verdict: SignedVerdict): Promise<string | null> {
    if (verdict.jobId !== job.id) return "the verdict is for another job";
    if (!job.createTx) return "the job has no EscrowCreate recorded, so its spec memo could not be read";
    const lookup = this.#lookupTx ?? ledgerTxLookup(this.#ledger() as never);
    const read = await escrowCreateSpecMemo(lookup, job.createTx, { owner: job.client, destination: verdict.provider, condition: verdict.condition });
    if ("problem" in read) return `spec memo: ${read.problem}`;
    if (read.memo.specHash !== verdict.specHash) {
      return `the verdict judged spec ${verdict.specHash}, but the escrow was locked against spec ${read.memo.specHash}`;
    }
    return null;
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

  /**
   * Register a draft job, then have the oracle create its secret and set the condition.
   * With a job spec v1 as `spec`, the job's client, provider, price and SLA are taken from
   * the spec (any given here must agree), and the job then waits for both parties'
   * signatures (`signSpec`) before `fundJob` will lock anything.
   */
  async createJob(input: NewJobInput | { spec: JobSpecV1 }): Promise<Job> {
    const body = jobBody(input);
    const draft = await callJson<Job>("POST", `${this.registryUrl}/jobs`, body);
    await callJson("POST", `${this.oracleUrl}/jobs/${draft.id}/condition`);
    return this.getJob(draft.id);
  }

  /** Create a job with a v1 spec and sign it as its client (`createJob` then `signSpec`). The provider signs next. */
  async createSignedJob(spec: JobSpecV1, clientWallet: Wallet): Promise<Job> {
    if (clientWallet.address !== spec.client) throw new Error("only the spec's client can create its job");
    const job = await this.createJob({ spec });
    return this.signSpec(job.id, clientWallet, specHash(spec));
  }

  /**
   * Sign a job's spec as its client or provider (EDR-016). Pass the hash of the spec you
   * read and agree to (`specHash(spec)`): the SDK works the hash out again from the spec
   * the registry holds and refuses to sign if it differs, so a registry can't get you to
   * sign a spec you didn't read. The provider's signature is its acceptance of the criteria.
   */
  async signSpec(jobId: string, wallet: Wallet, agreedSpecHash: string): Promise<Job> {
    const job = await this.getJob(jobId);
    if (!isSpecV1(job.spec)) throw new Error(`job ${jobId} has an unsigned (Phase 1 to 5) spec; there is nothing to sign`);
    const problem = specProblem(job.spec);
    if (problem) throw new Error(`job ${jobId}'s spec is not acceptable: ${problem}`);
    const hash = specHash(job.spec);
    if (hash !== agreedSpecHash) throw new Error(`the registry's spec for job ${jobId} has hash ${hash}, not the ${agreedSpecHash} you agreed to; nothing signed`);
    if (wallet.address !== job.spec.client && wallet.address !== job.spec.provider) throw new Error("only the spec's client or provider can sign it");
    return callJson<Job>("POST", `${this.registryUrl}/jobs/${encodeURIComponent(jobId)}/spec/signatures`, {
      specHash: hash, signature: signSpecHash(hash, wallet),
    });
  }

  /**
   * The client replaces a draft job's spec with its next revision (`reviseJobSpec`). The
   * registry keeps the old revision; the new one needs both signatures again.
   */
  reviseSpec(jobId: string, next: JobSpecV1, clientWallet: Wallet): Promise<Job> {
    const problem = specProblem(next);
    if (problem) throw new Error(problem);
    return callJson<Job>("PUT", `${this.registryUrl}/jobs/${encodeURIComponent(jobId)}/spec`, {
      spec: next, auth: signRequest(clientWallet, "revise-spec", jobId, specHash(next)),
    });
  }

  /** Earlier revisions of a job's spec, each with the signatures it had. */
  specRevisions(jobId: string): Promise<{ revision: number; specHash: string; spec: JobSpecV1; replacedAt: number }[]> {
    return callJson("GET", `${this.registryUrl}/jobs/${encodeURIComponent(jobId)}/spec/revisions`);
  }

  /**
   * Client locks the price in escrow. Resolves when the watcher has seen the validated EscrowCreate.
   * For a job spec v1 (EDR-016) it refuses to lock anything until the client's and the provider's
   * signatures over the spec hash check (worked out here from the spec, never taken from the
   * registry), and the EscrowCreate carries the spec hash and revision in a memo. Pass
   * `specHash` to also pin the hash you agreed to.
   */
  async fundJob(jobId: string, clientWallet: Wallet, opts: { specHash?: string } = {}): Promise<{ tx: TxResult; job: Job }> {
    const job = await this.getJob(jobId);
    if (job.status !== "draft" || !job.condition) throw new Error(`job ${jobId} is ${job.status}; only a draft with a condition can be funded`);
    if (clientWallet.address !== job.client) throw new Error("only the job's client can fund it");
    let memos;
    if (isSpecV1(job.spec)) {
      const spec = job.spec;
      const refuse = (why: string) => new Error(`refusing to lock XRP for job ${jobId}: ${why}`);
      const problem = specProblem(spec);
      if (problem) throw refuse(`its spec is not acceptable (${problem})`);
      const hash = specHash(spec);
      if (opts.specHash && opts.specHash !== hash) throw refuse(`its spec has hash ${hash}, not the ${opts.specHash} you agreed to`);
      if (spec.client !== job.client || spec.provider !== job.provider || spec.priceDrops !== job.priceDrops || spec.slaSeconds !== job.slaSeconds) {
        throw refuse("the job's parties, price or SLA differ from its spec");
      }
      const missing = agreementProblems(spec, job.specSignatures ?? {});
      if (missing.length) throw refuse(missing.join("; "));
      memos = specMemos(spec);
    } else if (opts.specHash) {
      throw new Error(`job ${jobId} has an unsigned spec; it has no spec hash to pin`);
    }
    const tx = await createEscrow(this.#ledger(), clientWallet, job.provider, job.priceDrops, job.condition, job.slaSeconds, memos);
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
  requestVerification(jobId: string, wallet: Wallet, attempts = 4): Promise<{ verdict: SignedVerdict; fulfillment?: string }> {
    return this.#verifyAt(this.oracleUrl, jobId, wallet, "", attempts);
  }

  async #verifyAt<T>(url: string, jobId: string, wallet: Wallet, payloadHash: string, attempts: number): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await callJson<T>("POST", `${url}/verify/${jobId}`, { auth: signRequest(wallet, "verify", jobId, payloadHash) });
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
    const before = await this.getJob(jobId);
    const expected = jobSpecHash(before);
    const { verdict, fulfillment } = await this.requestVerification(jobId, providerWallet);
    const specMatches = (verdict.specHash ?? null) === expected;
    return {
      job: await this.getJob(jobId),
      verdict,
      verdictSignatureValid: this.oracleAddress !== null && verifyVerdict(verdict, this.oracleAddress)
        && verdict.evidenceHash === sha256Hex(content) && specMatches,
      fulfillment: fulfillment ?? null,
      specHash: expected, specMatches, unsignedSpec: expected === null,
    };
  }

  /** The signed oracle verdicts the registry recorded for a shared job. */
  jobVerdicts(jobId: string): Promise<SignedVerdict[]> {
    return callJson("GET", `${this.registryUrl}/jobs/${encodeURIComponent(jobId)}/verdicts`);
  }

  /** Shared jobs whose oracles disagreed: at least one signed pass and one signed fail, and the criteria they split on (EDR-016). */
  splitJobs(): Promise<{
    jobId: string; status: JobStatus; threshold: number; oracles: string[]; passed: string[]; failed: string[];
    specHash: string | null; criteria: { id: string; passed: string[]; failed: string[] }[];
  }[]> {
    return callJson("GET", `${this.registryUrl}/splits`);
  }

  /**
   * Client side of a shared job (EDR-015). Checks each oracle of the pinned set (its
   * verdict address, anchor account and share key, which its verdict key must have
   * signed), makes the job's secret, splits it `threshold` of n, registers the job
   * with the condition, signed by the client, and seals each share to its oracle.
   * The secret and the shares are wiped from memory afterwards and never stored.
   * Throws if any oracle could not take its share; then don't fund the job.
   */
  async createSharedJob(sharedInput: SharedJobInput | { spec: JobSpecV1; oracles: OracleRef[]; threshold: number }, clientWallet: Wallet): Promise<Job> {
    const input = { ...jobBody(sharedInput), oracles: sharedInput.oracles, threshold: sharedInput.threshold };
    if (clientWallet.address !== input.client) throw new Error("only the job's client can create its shared job");
    const n = input.oracles.length;
    if (!Number.isInteger(input.threshold) || input.threshold < 2 || input.threshold > n) throw new Error("threshold must be from 2 to the number of oracles");
    const keys = await Promise.all(input.oracles.map(async (ref, i) => {
      const h = await callJson<{ oracle: string; publicKey: string; anchorAccount: string | null; shareKey: string | null; shareKeySignature: string | null }>(
        "GET", `${ref.url}/health`);
      if (h.oracle !== ref.address) throw new Error(`oracle ${i + 1} at ${ref.url} signs as ${h.oracle}, not the pinned ${ref.address}`);
      if (h.anchorAccount !== ref.anchor) throw new Error(`oracle ${i + 1} anchors from ${h.anchorAccount}, not the pinned ${ref.anchor}`);
      if (!h.shareKey || !h.shareKeySignature || !verifyShareKey(ref.address, h.publicKey, h.shareKey, h.shareKeySignature)) {
        throw new Error(`oracle ${i + 1} (${ref.address}) has no share key signed by its verdict key`);
      }
      return h.shareKey;
    }));
    const secret = makeSecret();
    const condition = toCondition(secret);
    const shares = split(secret, input.threshold, n);
    secret.fill(0);
    try {
      const body = {
        client: input.client, provider: input.provider, priceDrops: input.priceDrops, slaSeconds: input.slaSeconds, spec: input.spec,
        oracles: input.oracles, threshold: input.threshold, condition,
      };
      const job = await callJson<Job>("POST", `${this.registryUrl}/jobs`, { ...body, auth: signRequest(clientWallet, "create", "", newJobHash(body)) });
      const failures: string[] = [];
      await Promise.all(input.oracles.map(async (ref, i) => {
        const raw = Buffer.from(encodeShare(shares[i]), "hex");
        const box = seal(raw, keys[i], { jobId: job.id, oracle: ref.address, index: i + 1 });
        raw.fill(0);
        try {
          await callJson("POST", `${ref.url}/jobs/${job.id}/share`, {
            index: i + 1, box, auth: signRequest(clientWallet, "share", job.id, sha256Hex(canonicalJson(box))),
          });
        } catch (err) {
          failures.push(`oracle ${i + 1} (${ref.address}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }));
      if (failures.length) throw new Error(`job ${job.id} is registered, but not every oracle took its share; do not fund it: ${failures.join("; ")}`);
      // A v1 spec: the client signs it now; the provider signs next (signSpec), then fundJob can lock.
      if (isSpecV1(input.spec)) return this.signSpec(job.id, clientWallet, specHash(input.spec));
      return this.getJob(job.id);
    } finally {
      for (const s of shares) s.y.fill(0);
    }
  }

  /**
   * Provider side of a shared job (EDR-015): ask every oracle of the set to verify the
   * delivered work. Each verdict is used only when it is signed by that oracle's pinned
   * address, names this job, its condition, provider, deliverable, share index and k,
   * and that oracle's own verdict log checks (`verifyVerdictLog` with its pinned anchor
   * account). k shares from such passes are combined into the fulfillment. Every
   * verdict that checks is also posted to the registry, which counts them toward k.
   */
  async requestSharedVerification(jobId: string, wallet: Wallet, content: string, opts: SharedVerifyOptions = {}): Promise<SharedVerification> {
    const job = await this.getJob(jobId);
    if (!job.oracles || !job.threshold || !job.condition) throw new Error(`job ${jobId} is not a shared job`);
    if (opts.oracles && canonicalJson(opts.oracles) !== canonicalJson(job.oracles)) {
      throw new Error("the registry's oracle set for this job is not the set you pinned");
    }
    const set = opts.oracles ?? job.oracles;
    const evidenceHash = sha256Hex(content);
    // Every oracle must have judged the one signed spec (EDR-016), worked out here from the spec.
    const expectedSpec = jobSpecHash(job);
    if (isSpecV1(job.spec)) {
      const missing = agreementProblems(job.spec, job.specSignatures ?? {});
      if (missing.length) throw new Error(`job ${jobId}'s spec is not signed by both parties: ${missing.join("; ")}`);
    }
    const reports = await Promise.all(set.map(async (ref, i): Promise<OracleReport & { share?: string }> => {
      const report: OracleReport & { share?: string } = { oracle: ref, index: i + 1, status: "unreachable", problems: [], used: false };
      let answer: { verdict: SignedVerdict; share?: string };
      try {
        answer = await this.#verifyAt(ref.url, jobId, wallet, ref.address, opts.attempts ?? 4);
      } catch (err) {
        if (err instanceof HttpError && err.status === 409) report.status = "refused";
        report.problems.push(err instanceof Error ? err.message : String(err));
        return report;
      }
      const v = answer.verdict;
      report.verdict = v;
      const p = report.problems;
      if (!verifyVerdict(v, ref.address)) p.push(`verdict is not signed by the pinned oracle ${ref.address}`);
      if (v.jobId !== jobId || v.condition !== job.condition || v.provider !== job.provider) p.push("verdict is for another job, condition or provider");
      if (v.evidenceHash !== evidenceHash) p.push("verdict is not for this deliverable");
      if (v.shareIndex !== i + 1 || v.threshold !== job.threshold) p.push("verdict names the wrong share index or threshold");
      if ((v.specHash ?? null) !== expectedSpec) {
        p.push(`verdict judged spec ${v.specHash ?? "(unsigned)"}, not the job's signed spec ${expectedSpec ?? "(unsigned)"}; its share is never combined`);
      }
      if (v.verdict === "fail" && answer.share !== undefined) p.push("oracle sent a share with a fail verdict; it is not used");
      if (v.verdict === "pass") {
        try {
          if (decodeShare(answer.share ?? "").x !== i + 1) p.push(`share is not share ${i + 1}`);
        } catch (err) {
          p.push(`pass without a usable share: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (p.length === 0) {
        const kit = new EscrowKit({
          xrpl: this.#xrpl, oracleUrl: ref.url, registryUrl: this.registryUrl, oracleAddress: ref.address, anchorAddress: ref.anchor,
          listAnchors: this.#listAnchors, lookupTx: this.#lookupTx,
        });
        try {
          report.log = await kit.verifyVerdictLog({ verdict: v, allowUnanchored: !opts.requireAnchored, requireAnchor: !!opts.requireAnchored, job });
          if (!report.log.ok) p.push(...report.log.problems.map((x) => `verdict log: ${x}`));
        } catch (err) {
          p.push(`verdict log could not be checked: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      report.status = p.length ? "rejected" : v.verdict;
      if (report.status === "pass") report.share = answer.share;
      return report;
    }));
    // The registry counts signed verdicts toward k; the oracles post their own too.
    for (const r of reports) {
      if (r.status === "pass" || r.status === "fail") {
        try {
          await callJson("POST", `${this.registryUrl}/jobs/${encodeURIComponent(jobId)}/verdicts`, { verdict: r.verdict });
        } catch {
          // already recorded, or the registry is down: the fulfillment does not depend on it
        }
      }
    }
    const passes = reports.filter((r) => r.status === "pass").map((r) => ({ oracle: r.oracle.address, share: r.share! }));
    const combined = combineForCondition(passes, set, job.threshold, job.condition);
    for (const r of reports) {
      r.used = !!combined?.used.includes(r.oracle.address);
      delete r.share;
    }
    const by = (s: OracleReport["status"]) => reports.filter((r) => r.status === s).map((r) => r.oracle.address);
    return {
      job: await this.getJob(jobId), reports, passed: by("pass"), failed: by("fail"), rejected: by("rejected"), refused: by("refused"),
      unreachable: by("unreachable"), fulfillment: combined?.fulfillment ?? null, specHash: expectedSpec, unsignedSpec: expectedSpec === null,
    };
  }

  /** Provider posts the work for a shared job, then asks every oracle of the set (`requestSharedVerification`). */
  async deliverShared(jobId: string, providerWallet: Wallet, content: string, opts: SharedVerifyOptions = {}): Promise<SharedVerification> {
    await callJson("POST", `${this.registryUrl}/jobs/${jobId}/deliverable`, {
      content, auth: signRequest(providerWallet, "deliver", jobId, sha256Hex(content)),
    });
    return this.requestSharedVerification(jobId, providerWallet, content, opts);
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
