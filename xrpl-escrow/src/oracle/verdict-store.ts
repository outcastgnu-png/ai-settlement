// The oracle's side of the public verdict log (EDR-014): the chained log file
// and the anchors of its head on the testnet ledger.
//
// The log is read back and checked in full when the oracle starts; an oracle
// whose own log does not check refuses to start rather than extend a broken
// chain. Appends are synchronous, so two verdicts can't race for a sequence
// number. Anchoring sends the head (sequence number and hash) in a memo on an
// AccountSet from a dedicated faucet-funded anchor wallet, then records the
// validated transaction in a small JSONL file next to the log.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { AccountSet, Client, Wallet } from "xrpl";
import { sha256Hex } from "../auth.js";
import { submitValidated } from "../escrow.js";
import {
  anchorMemos, checkChain, entryMismatch, genesisEntry, verdictEntry, verdictHash, type Anchor, type LogEntry, type LogHead,
  type VerdictLogEntry,
} from "../verdict-log.js";
import type { SignedVerdict } from "./server.js";

export const MAX_PAGE = 500;

/** What the oracle already issued for a job: its log entry, and the full signed verdict when the private copy has it. */
export interface Issued {
  entry: VerdictLogEntry;
  verdict: SignedVerdict | null;
}

/**
 * The chained public log plus a private file of the full signed verdicts
 * (`data/verdicts-signed.jsonl`, never served), so the first verdict for a job
 * survives a restart and is the only one ever issued for it (Gpno N25). The
 * private copy is written first; on start, a signed verdict the log is missing
 * (a crash between the two writes) is appended to the log.
 */
export class VerdictStore {
  readonly #entries: LogEntry[] = [];
  readonly #byJob = new Map<string, Issued>();
  readonly #signed = new Map<string, SignedVerdict>(); // verdictHash -> full verdict
  readonly signedPath: string;

  constructor(readonly path: string, readonly key: Wallet, legacyLogPath?: string, signedPath?: string) {
    this.signedPath = signedPath ?? path.replace(/(\.jsonl)?$/, "-signed.jsonl");
    if (existsSync(this.signedPath)) {
      for (const line of readFileSync(this.signedPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let v: SignedVerdict;
        try {
          v = JSON.parse(line);
        } catch {
          continue; // a torn last line after a crash: that verdict never reached the log or the provider
        }
        this.#signed.set(verdictHash(v), v);
      }
    }
    if (existsSync(path)) {
      const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
      let parsed: unknown[];
      try {
        parsed = lines.map((l) => JSON.parse(l));
      } catch {
        throw new Error(`verdict log ${path} has a line that is not JSON; refusing to start`);
      }
      const check = checkChain(parsed, key.address);
      if (!check.ok) throw new Error(`verdict log ${path} does not check (${check.problem}); refusing to start`);
      for (const e of parsed as LogEntry[]) {
        this.#entries.push(e);
        if (e.kind === "verdict" && !this.#byJob.has(e.jobId)) this.#byJob.set(e.jobId, { entry: e, verdict: this.#signed.get(e.verdictHash) ?? null });
      }
    } else {
      let legacy: { sha256: string; bytes: number } | null = null;
      if (legacyLogPath && existsSync(legacyLogPath)) {
        legacy = { sha256: sha256Hex(readFileSync(legacyLogPath)), bytes: statSync(legacyLogPath).size };
      }
      this.#write(genesisEntry(key, legacy));
    }
    // Repair: signed verdicts whose log entry was never written.
    for (const v of this.#signed.values()) {
      if (!this.#byJob.has(v.jobId) && v.oracle === key.address) this.#appendEntry(v);
    }
  }

  #write(entry: LogEntry) {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
    this.#entries.push(entry);
  }

  #appendEntry(verdict: SignedVerdict): LogEntry {
    const entry = verdictEntry(this.key, this.head(), verdict);
    const mismatch = entryMismatch(entry, verdict);
    if (mismatch) throw new Error(`refusing to log an entry whose ${mismatch} differs from its verdict`);
    this.#write(entry);
    this.#byJob.set(verdict.jobId, { entry: entry as VerdictLogEntry, verdict });
    return entry;
  }

  head(): LogHead {
    const last = this.#entries[this.#entries.length - 1];
    return { seq: last.seq, hash: last.hash };
  }

  get count() {
    return this.#entries.length;
  }

  /** The verdict already issued for this job, if any. It is final. */
  issued(jobId: string): Issued | null {
    return this.#byJob.get(jobId) ?? null;
  }

  /** Record the first and only verdict for a job: the private full copy, then the public entry. */
  append(verdict: SignedVerdict): LogEntry {
    if (this.#byJob.has(verdict.jobId)) throw new Error(`job ${verdict.jobId} already has a verdict; it is final`);
    mkdirSync(dirname(this.signedPath), { recursive: true });
    appendFileSync(this.signedPath, `${JSON.stringify(verdict)}\n`);
    this.#signed.set(verdictHash(verdict), verdict);
    return this.#appendEntry(verdict);
  }

  page(from: number, limit: number): LogEntry[] {
    return this.#entries.slice(from, from + Math.min(Math.max(limit, 1), MAX_PAGE));
  }

  /** Every entry, for the oracle's own check against the ledger's anchors. */
  all(): readonly LogEntry[] {
    return this.#entries;
  }
}

/** Puts a log head on the ledger and returns the validated anchor. */
export type Anchorer = (head: LogHead) => Promise<Anchor>;

/** Anchor on the testnet with an AccountSet whose only content is the memo. */
export function ledgerAnchorer(client: Client, anchorWallet: Wallet, verdictAddress: string): Anchorer {
  return async (head) => {
    const tx: AccountSet = { TransactionType: "AccountSet", Account: anchorWallet.address, Memos: anchorMemos(head, verdictAddress) };
    const result = await submitValidated(client, anchorWallet, tx);
    if (result.code !== "tesSUCCESS") throw new Error(`anchor transaction ${result.hash} failed: ${result.code}`);
    const res = await client.request({ command: "tx", transaction: result.hash });
    return {
      v: 1, seq: head.seq, hash: head.hash, oracle: verdictAddress,
      txHash: result.hash, ledgerIndex: Number(res.result.ledger_index ?? 0), account: anchorWallet.address,
    };
  };
}

/** Anchors already made, newest last, kept in a JSONL file. They are a convenience: the ledger is the record. */
export class AnchorBook {
  readonly #anchors: Anchor[] = [];

  constructor(readonly path: string) {
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          this.#anchors.push(JSON.parse(line));
        } catch {
          // a torn last line after a crash; the ledger still has the anchor
        }
      }
    }
  }

  add(anchor: Anchor) {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(anchor)}\n`);
    this.#anchors.push(anchor);
  }

  latest(): Anchor | null {
    return this.#anchors[this.#anchors.length - 1] ?? null;
  }

  recent(n: number): Anchor[] {
    return this.#anchors.slice(-n);
  }
}

/**
 * Anchors the head on a timer when it has moved since the last anchor, and
 * once more on shutdown. One anchor runs at a time; a failure is logged and
 * tried again on the next tick.
 */
export class AnchorSchedule {
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<Anchor | null> | null = null;
  #last: Anchor | null;
  lastError: string | null = null;

  /**
   * `lastOnLedger` is the newest anchor read from the ledger at start. It, not
   * the local anchor book, decides whether the head is already anchored, so an
   * edited book can't hold back the next anchor.
   */
  constructor(
    readonly store: VerdictStore, readonly book: AnchorBook, readonly anchorer: Anchorer,
    readonly intervalMs: number, readonly log: (line: string) => void = (l) => console.error(l),
    lastOnLedger: Anchor | null = null,
  ) {
    this.#last = lastOnLedger;
  }

  start() {
    if (this.intervalMs > 0 && !this.#timer) {
      this.#timer = setInterval(() => void this.anchorNow(), this.intervalMs);
      this.#timer.unref();
      void this.anchorNow();
    }
  }

  /** Anchor the current head unless it is already anchored. Resolves to the anchor, or null if nothing was needed. */
  anchorNow(): Promise<Anchor | null> {
    if (this.#running) return this.#running.then(() => this.anchorNow());
    const head = this.store.head();
    const last = this.#last;
    if (last && last.seq === head.seq && last.hash === head.hash) return Promise.resolve(null);
    this.#running = this.anchorer(head).then((anchor) => {
      this.book.add(anchor);
      this.#last = anchor;
      this.lastError = null;
      return anchor;
    }, (err) => {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log(`[oracle] anchoring the verdict log failed, will try again: ${this.lastError}`);
      return null;
    }).finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  /** Stop the timer and anchor once more. */
  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.anchorNow();
  }
}
