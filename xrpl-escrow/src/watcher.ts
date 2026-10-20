// Ledger watcher. Subscribes over WebSocket to every client and provider
// account in the registry and turns validated escrow transactions into job
// status changes:
//
//   EscrowCreate  (matching the job's condition, parties and price) -> funded
//   EscrowFinish  (job's owner + offer sequence)                    -> paid
//   EscrowCancel  (job's owner + offer sequence)                    -> refunded
//
// On every validated ledger it also flags escrows within WARN_SECONDS of
// CancelAfter, and marks passed-but-unclaimed jobs expired_unclaimed once a
// ledger closes after CancelAfter. Only validated, tesSUCCESS transactions count.
import { pathToFileURL } from "node:url";
import type { Client, TransactionStream } from "xrpl";
import { connectTestnet } from "./config.js";
import { callJson } from "./http.js";
import { REGISTRY_URL } from "./local-config.js";
import { TERMINAL, type Job } from "./registry/db.js";

export const WARN_SECONDS = 30;

export interface LedgerTx {
  hash: string;
  validated: boolean;
  result: string;
  tx: Record<string, unknown>;
}

export interface RegistryEvent {
  jobId: string;
  body: Record<string, unknown>;
}

/** Normalise a transaction-stream message or an account_tx entry (API v1 or v2). */
export function toLedgerTx(msg: Record<string, unknown>): LedgerTx | null {
  const tx = (msg.tx_json ?? msg.transaction ?? msg.tx) as Record<string, unknown> | undefined;
  const meta = msg.meta as { TransactionResult?: string } | string | undefined;
  const hash = (msg.hash ?? tx?.hash) as string | undefined;
  if (!tx || !hash || typeof meta !== "object") return null;
  return { hash, validated: msg.validated === true, result: meta.TransactionResult ?? "", tx };
}

/** The registry event a validated escrow transaction implies, if it belongs to a known job. */
export function eventForTx(t: LedgerTx, jobs: Job[]): RegistryEvent | null {
  if (!t.validated || t.result !== "tesSUCCESS") return null;
  const tx = t.tx;
  switch (tx.TransactionType) {
    case "EscrowCreate": {
      const job = jobs.find((j) => j.condition !== null && j.condition === tx.Condition && j.client === tx.Account
        && j.provider === tx.Destination && j.priceDrops === tx.Amount);
      if (!job) return null;
      return {
        jobId: job.id,
        body: {
          source: "ledger", status: "funded", offerSequence: tx.Sequence, cancelAfter: tx.CancelAfter, txHash: t.hash,
          detail: `EscrowCreate ${t.hash}`,
        },
      };
    }
    case "EscrowFinish":
    case "EscrowCancel": {
      const job = jobs.find((j) => j.client === tx.Owner && j.offerSequence === tx.OfferSequence);
      if (!job) return null;
      const status = tx.TransactionType === "EscrowFinish" ? "paid" : "refunded";
      return { jobId: job.id, body: { source: "ledger", status, txHash: t.hash, detail: `${tx.TransactionType} ${t.hash}` } };
    }
    default:
      return null;
  }
}

/** Deadline events implied by a validated ledger that closed at `closeTime` (Ripple epoch seconds). */
export function eventsForLedger(closeTime: number, jobs: Job[], warnSeconds = WARN_SECONDS): RegistryEvent[] {
  const events: RegistryEvent[] = [];
  for (const job of jobs) {
    if (job.cancelAfter === null || TERMINAL.includes(job.status) || job.status === "expired_unclaimed") continue;
    const left = job.cancelAfter - closeTime;
    if (left < 0 && job.status === "verified_pass") {
      events.push({ jobId: job.id, body: { source: "ledger", status: "expired_unclaimed", detail: `ledger closed ${-left} s after CancelAfter` } });
    } else if (left >= 0 && left <= warnSeconds && !job.expiringSoon) {
      events.push({ jobId: job.id, body: { source: "ledger", expiringSoon: true, detail: `${left} s left before CancelAfter` } });
    }
  }
  return events;
}

export interface WatcherOptions {
  registryUrl?: string;
  pollMs?: number;
  log?: (line: string) => void;
}

export class LedgerWatcher {
  readonly #registry: string;
  readonly #log: (line: string) => void;
  readonly #accounts = new Set<string>();
  #queue: Promise<void> = Promise.resolve();
  #timer: NodeJS.Timeout | null = null;
  #pollMs: number;

  constructor(private readonly client: Client, opts: WatcherOptions = {}) {
    this.#registry = opts.registryUrl ?? REGISTRY_URL;
    this.#pollMs = opts.pollMs ?? 1000;
    this.#log = opts.log ?? ((line) => console.log(`[watcher] ${line}`));
  }

  async start(): Promise<void> {
    this.client.on("transaction", (msg: TransactionStream) => {
      const t = toLedgerTx(msg as unknown as Record<string, unknown>);
      if (t) this.#enqueue(() => this.#handleTx(t));
    });
    this.client.on("ledgerClosed", (ledger) => this.#enqueue(() => this.#handleLedger(ledger.ledger_time)));
    // xrpl.js reconnects on its own but does not restore subscriptions.
    this.client.on("connected", () => {
      const accounts = [...this.#accounts];
      this.#accounts.clear();
      this.#enqueue(async () => {
        await this.client.request({ command: "subscribe", streams: ["ledger"] });
        await this.#subscribe(accounts);
      });
    });
    await this.client.request({ command: "subscribe", streams: ["ledger"] });
    await this.#poll();
    this.#timer = setInterval(() => this.#enqueue(() => this.#poll()), this.#pollMs);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Resolves once everything queued so far has been processed. */
  idle(): Promise<void> {
    return this.#queue;
  }

  #enqueue(work: () => Promise<void>) {
    this.#queue = this.#queue.then(work).catch((err) => this.#log(`error: ${err instanceof Error ? err.message : String(err)}`));
  }

  #openJobs(): Promise<Job[]> {
    return callJson<Job[]>("GET", `${this.#registry}/jobs`).then((jobs) => jobs.filter((j) => !TERMINAL.includes(j.status)));
  }

  /** Subscribe to accounts of any new open jobs, then backfill what they did before we listened. */
  async #poll() {
    const jobs = await this.#openJobs();
    await this.#subscribe(jobs.flatMap((j) => [j.client, j.provider]));
  }

  async #subscribe(candidates: string[]) {
    const fresh = [...new Set(candidates)].filter((a) => !this.#accounts.has(a));
    if (fresh.length === 0) return;
    await this.client.request({ command: "subscribe", accounts: fresh });
    for (const a of fresh) this.#accounts.add(a);
    this.#log(`subscribed to ${fresh.join(", ")}`);
    for (const account of fresh) {
      const res = await this.client.request({ command: "account_tx", account, limit: 50, forward: false });
      const txs = (res.result.transactions as unknown as Record<string, unknown>[]).map(toLedgerTx).filter((t): t is LedgerTx => t !== null);
      for (const t of txs.reverse()) await this.#handleTx(t); // oldest first
    }
  }

  async #handleTx(t: LedgerTx) {
    const event = eventForTx(t, await this.#openJobs());
    if (event) await this.#send(event);
  }

  async #handleLedger(closeTime: number) {
    for (const event of eventsForLedger(closeTime, await this.#openJobs())) await this.#send(event);
  }

  async #send({ jobId, body }: RegistryEvent) {
    try {
      const job = await callJson<Job>("POST", `${this.#registry}/jobs/${jobId}/events`, body);
      this.#log(`job ${jobId}: ${body.status ? `status ${job.status}` : "flagged"} (${body.detail})`);
    } catch (err) {
      this.#log(`job ${jobId}: registry refused ${String(body.status ?? "flag")}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function main() {
  const client = await connectTestnet();
  const watcher = new LedgerWatcher(client);
  await watcher.start();
  console.log(`[watcher] connected to ${client.url} (testnet), watching jobs in ${REGISTRY_URL}`);
  const shutdown = async () => {
    watcher.stop();
    await client.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
