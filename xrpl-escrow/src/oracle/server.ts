// Verification oracle HTTP service on 127.0.0.1:8802.
//
//   GET  /health                   the verdict signer's address and public key, and the anchor account
//   POST /jobs/:jobId/condition    make the job's secret, seal it in the vault, set the condition in the registry
//   POST /verify/:jobId            {auth} signed by the job's provider; runs the job's checks
//   GET  /verdicts?from=&limit=    the public verdict log, a page of entries (EDR-014)
//   GET  /verdicts/head            the log's latest sequence number and hash
//   GET  /verdicts/anchors         the latest anchors of the head on the testnet ledger
//
// The oracle is the only process that holds secrets. It reads the job spec and
// deliverable from the registry and only hashes, parses or validates them; it
// never executes or follows anything inside them. Before it verifies anything
// it confirms on the ledger that the job's escrow exists with the agreed
// amount, provider, condition and deadline, so a forged registry status can't
// get a fulfillment released. A verify call returns a verdict signed with the
// oracle's ed25519 verdict key, and the fulfillment only on a pass and only to
// the job's provider. If the checks can't run for a reason that isn't the
// job's (the schema checker is busy or restarting, the ledger lookup timed
// out), it answers 503 and signs nothing, so the provider can ask again
// (Gpno N9). The first signed verdict for a job is final (Gpno N25): it is kept
// in a private file next to the log and reloaded on start, so asking again,
// even after a restart, returns that same verdict without running the checks,
// and a fail never releases the fulfillment.
//
// Every verdict goes into the hash-chained public verdict log
// (src/verdict-log.ts, data/verdict-log.jsonl), which anyone on this machine
// can read. On a timer and on shutdown the oracle anchors the log's head on
// the testnet from its own anchor wallet, so a copy of the log can be compared
// with the ledger. The older unchained data/verdicts.jsonl is no longer
// written; the log's genesis entry names its hash.
import { pathToFileURL } from "node:url";
import { Wallet, type Client } from "xrpl";
import { ReplayGuard, checkRequest, sha256Hex, signPayload } from "../auth.js";
import { makeSecret, toCondition, toFulfillment } from "../condition.js";
import { connectTestnet } from "../config.js";
import { getEscrow } from "../escrow.js";
import { HttpError, callJson, jsonServer, listenLocal, type Route } from "../http.js";
import {
  ANCHOR_FILE, ANCHOR_INTERVAL_MS, ORACLE_PORT, REGISTRY_URL, REPLAY_FILE, VAULT_FILE, VERDICT_CHAIN, VERDICT_LOG, readEnvFile, requireEnv,
} from "../local-config.js";
import type { Deliverable, Job } from "../registry/db.js";
import { CheckUnavailable, runChecks, stopSchemaWorker, type CheckResult } from "./checks/index.js";
import { ledgerTxLookup, type TxLookup } from "./checks/xrpl-tx.js";
import { SecretVault, parseVaultKey } from "./vault.js";
import { AnchorBook, AnchorSchedule, MAX_PAGE, VerdictStore, ledgerAnchorer, type Anchorer } from "./verdict-store.js";
import { listAnchors } from "../anchors.js";
import { anchorHistoryProblems, type Anchor } from "../verdict-log.js";

export interface VerdictBody {
  jobId: string;
  verdict: "pass" | "fail";
  checks: CheckResult[];
  evidenceHash: string; // sha256 of the deliverable the checks ran on
  condition: string;
  provider: string;
  oracle: string; // address of the verdict signing key
  publicKey: string;
  issuedAt: number;
}

export interface SignedVerdict extends VerdictBody {
  signature: string;
}

/** Returns null when the job's escrow is on the ledger as agreed, otherwise what is wrong. */
export type EscrowCheck = (job: Job) => Promise<string | null>;

export interface OracleOptions {
  verdictKey: Wallet; // signs verdicts; a key of its own, not a funded wallet
  vault: SecretVault;
  serviceToken: string; // ORACLE_SERVICE_TOKEN, for writes to the registry
  escrowCheck: EscrowCheck;
  replay?: ReplayGuard;
  registryUrl?: string;
  /** The older unchained log; only hashed into the genesis entry of a new chain. */
  verdictLog?: string;
  /** The hash-chained public verdict log. */
  verdictChain?: string;
  anchorFile?: string;
  /** Puts the log head on the ledger. Defaults to an AccountSet from ORACLE_ANCHOR_SEED. */
  anchorer?: Anchorer;
  /** Address of the anchor account, shown on /health. */
  anchorAddress?: string;
  /** How often to anchor a moved head; 0 anchors only on shutdown and when asked. */
  anchorIntervalMs?: number;
  /** Reads a transaction from the testnet, for xrpl-tx-validated. */
  lookupTx?: TxLookup;
  /** The anchors already on the ledger for this verdict key, newest first. Defaults to account_tx of the anchor account. */
  anchorHistory?: () => Promise<Anchor[]>;
}

export interface OracleRoutesOptions extends OracleOptions {
  store: VerdictStore;
  anchors: AnchorBook;
}

/** Compare the escrow object in the latest validated ledger with the job. */
export function ledgerEscrowCheck(client: Client): EscrowCheck {
  return async (job) => {
    if (job.offerSequence === null || job.cancelAfter === null || job.condition === null) return "job has no escrow recorded";
    const escrow = await getEscrow(client, {
      owner: job.client, offerSequence: job.offerSequence, condition: job.condition, cancelAfter: job.cancelAfter,
    });
    if (!escrow) return "no open escrow on the ledger for this job";
    if (escrow.Destination !== job.provider) return "escrow destination is not the job's provider";
    if (escrow.Amount !== job.priceDrops) return "escrow amount is not the job's price";
    if (escrow.Condition !== job.condition) return "escrow condition is not the job's condition";
    if (escrow.CancelAfter !== job.cancelAfter) return "escrow deadline is not the job's deadline";
    return null;
  };
}

export function oracleRoutes(opts: OracleRoutesOptions): Route[] {
  const registry = opts.registryUrl ?? REGISTRY_URL;
  // Checks still running, by job: a provider asking again before the first answer
  // waits for that run instead of starting another one.
  const running = new Map<string, Promise<{ pass: boolean; results: CheckResult[] }>>();
  const replay = opts.replay ?? new ReplayGuard();
  const getJob = async (id: string) => {
    try {
      return await callJson<Job>("GET", `${registry}/jobs/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) throw new HttpError(404, `unknown job ${id}`);
      throw err;
    }
  };

  return [
    {
      method: "GET", path: "/health",
      handler: () => ({
        ok: true, service: "oracle", oracle: opts.verdictKey.address, publicKey: opts.verdictKey.publicKey,
        anchorAccount: opts.anchorAddress ?? null,
      }),
    },

    {
      method: "GET", path: "/verdicts",
      handler: (_p, _b, q) => {
        const int = (name: string, fallback: number) => {
          const raw = q.get(name);
          if (raw === null) return fallback;
          if (!/^[0-9]{1,9}$/.test(raw)) throw new HttpError(400, `${name} must be a whole number`);
          return Number(raw);
        };
        const from = int("from", 0);
        const limit = Math.min(int("limit", MAX_PAGE), MAX_PAGE);
        return { entries: opts.store.page(from, limit), from, count: opts.store.count, head: opts.store.head() };
      },
    },

    { method: "GET", path: "/verdicts/head", handler: () => ({ ...opts.store.head(), count: opts.store.count }) },

    {
      method: "GET", path: "/verdicts/anchors",
      handler: () => ({ anchorAccount: opts.anchorAddress ?? null, anchors: opts.anchors.recent(20).reverse() }),
    },

    {
      method: "POST", path: "/jobs/:jobId/condition",
      handler: async ({ jobId }) => {
        const job = await getJob(jobId);
        let secret = opts.vault.get(jobId);
        if (!secret) {
          if (job.status !== "draft" || job.condition) throw new HttpError(409, "job already has a condition from elsewhere");
          secret = makeSecret();
          opts.vault.put(jobId, secret);
        }
        const condition = toCondition(secret);
        await callJson("PUT", `${registry}/jobs/${encodeURIComponent(jobId)}/condition`, { condition }, opts.serviceToken);
        return { jobId, condition };
      },
    },

    {
      method: "POST", path: "/verify/:jobId",
      handler: async ({ jobId }, body) => {
        const job = await getJob(jobId);
        checkRequest((body as { auth?: unknown } | undefined)?.auth, "verify", jobId, "", job.provider, replay);
        if (!["delivered", "verified_pass", "verified_fail"].includes(job.status)) {
          throw new HttpError(409, `job is ${job.status}; nothing to verify`);
        }
        const secret = opts.vault.get(jobId);
        if (!secret || !job.condition || toCondition(secret) !== job.condition) {
          throw new HttpError(409, "this oracle does not hold the secret for the job's condition");
        }
        const escrowProblem = await opts.escrowCheck(job);
        if (escrowProblem) throw new HttpError(409, `escrow check failed: ${escrowProblem}`);
        const deliverable = await callJson<Deliverable>("GET", `${registry}/jobs/${encodeURIComponent(jobId)}/deliverable`);

        const evidenceHash = sha256Hex(deliverable.content);
        let verdict: SignedVerdict;
        const prior = opts.store.issued(jobId);
        if (prior) {
          // Final: never run the checks again, whatever the ledger says now (Gpno N25).
          if (!prior.verdict) {
            throw new HttpError(409, `this job's verdict was already issued (log entry ${prior.entry.seq}: ${prior.entry.verdict}); it is final`);
          }
          verdict = prior.verdict;
        } else {
          // A fail from before the chained log (0.3.x) is final too.
          if (job.status === "verified_fail") throw new HttpError(409, "this job already failed verification; it is final");
          let run = running.get(jobId);
          if (!run) {
            run = runChecks(job.spec.checks, {
              job, content: deliverable.content, deliveredAt: deliverable.deliveredAt, lookupTx: opts.lookupTx,
            }).finally(() => running.delete(jobId));
            running.set(jobId, run);
          }
          let outcome: { pass: boolean; results: CheckResult[] };
          try {
            outcome = await run;
          } catch (err) {
            // The oracle's problem, not the job's: no verdict, no status change. Ask again.
            if (err instanceof CheckUnavailable) throw new HttpError(503, err.message);
            throw err;
          }
          // Two calls that waited on the same run: the first one back signs and logs.
          const now = opts.store.issued(jobId);
          if (now?.verdict) {
            verdict = now.verdict;
          } else {
            const unsigned: VerdictBody = {
              jobId, verdict: outcome.pass ? "pass" : "fail", checks: outcome.results, evidenceHash,
              condition: job.condition, provider: job.provider, oracle: opts.verdictKey.address,
              publicKey: opts.verdictKey.publicKey, issuedAt: Date.now(),
            };
            verdict = { ...unsigned, signature: signPayload(unsigned, opts.verdictKey) };
            opts.store.append(verdict);
          }
        }
        if (verdict.evidenceHash !== evidenceHash) throw new HttpError(409, "the stored deliverable does not match the verdict issued for it");
        const pass = verdict.verdict === "pass";
        const results = verdict.checks;

        if (job.status === "delivered") {
          await callJson("POST", `${registry}/jobs/${encodeURIComponent(jobId)}/events`, {
            source: "oracle", status: pass ? "verified_pass" : "verified_fail",
            detail: results.map((r) => `${r.type}: ${r.pass ? "pass" : "fail"}`).join(", "),
          }, opts.serviceToken);
        }
        return pass ? { verdict, fulfillment: toFulfillment(secret) } : { verdict };
      },
    },
  ];
}

export async function startOracle(opts: Partial<OracleOptions> & { port?: number } = {}) {
  const env = readEnvFile();
  const verdictKey = opts.verdictKey ?? Wallet.fromSeed(requireEnv(env, "ORACLE_VERDICT_SEED"));
  const vault = opts.vault ?? new SecretVault(VAULT_FILE, parseVaultKey(env.ORACLE_VAULT_KEY));
  const serviceToken = opts.serviceToken ?? requireEnv(env, "ORACLE_SERVICE_TOKEN");
  // Read and check the log before touching the network: a broken log stops the oracle here.
  const store = new VerdictStore(opts.verdictChain ?? VERDICT_CHAIN, verdictKey, opts.verdictLog ?? VERDICT_LOG);
  const anchors = new AnchorBook(opts.anchorFile ?? ANCHOR_FILE);
  let ledger: Client | null = null;
  const needsLedger = !opts.escrowCheck || !opts.anchorer || !opts.lookupTx;
  const anchorWallet = opts.anchorer ? null : Wallet.fromSeed(requireEnv(env, "ORACLE_ANCHOR_SEED"));
  if (needsLedger) ledger = await connectTestnet();
  const escrowCheck = opts.escrowCheck ?? ledgerEscrowCheck(ledger!);
  const lookupTx = opts.lookupTx ?? ledgerTxLookup(ledger! as never);
  const anchorer = opts.anchorer ?? ledgerAnchorer(ledger!, anchorWallet!, verdictKey.address);
  const anchorAddress = opts.anchorAddress ?? anchorWallet?.address;
  // Never extend a log that disagrees with what the anchor account already put on the
  // ledger, such as a second chain started from a fresh data folder (Gpno N29).
  const history = opts.anchorHistory
    ?? (anchorWallet ? async () => (await listAnchors(ledger!, anchorWallet.address, verdictKey.address)).anchors : async () => []);
  const onLedger = await history();
  const conflicts = anchorHistoryProblems(store.all(), onLedger, verdictKey.address);
  if (conflicts.length > 0) {
    await ledger?.disconnect();
    throw new Error(`refusing to start: the anchors on the ledger from ${anchorAddress} disagree with ${store.path} `
      + `(${conflicts.join("; ")}). One anchor account anchors one log: a fresh data folder or a new verdict key `
      + "needs a fresh anchor wallet (remove ORACLE_ANCHOR_SEED and ORACLE_ANCHOR_ADDRESS from .env and run npm run setup).");
  }
  const schedule = new AnchorSchedule(store, anchors, anchorer, opts.anchorIntervalMs ?? ANCHOR_INTERVAL_MS, undefined, onLedger[0] ?? null);
  const replay = opts.replay ?? new ReplayGuard(REPLAY_FILE);
  const server = jsonServer(oracleRoutes({
    ...opts, verdictKey, vault, serviceToken, escrowCheck, replay, store, anchors, lookupTx, anchorAddress,
  }));
  const port = await listenLocal(server, opts.port ?? ORACLE_PORT);
  schedule.start();
  let closing: Promise<void> | null = null;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    address: verdictKey.address,
    anchorAddress,
    store,
    anchors,
    /** Anchor the current head now, unless it is already anchored. */
    anchorNow: () => schedule.anchorNow(),
    close: () => closing ??= new Promise<void>((done) => {
      server.close(() => {
        const rest = schedule.stop().then(() => Promise.all([stopSchemaWorker(), ledger ? ledger.disconnect() : Promise.resolve()]));
        rest.then(() => done(), () => done());
      });
      server.closeAllConnections();
    }),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startOracle().then((oracle) => {
    console.log(`oracle (verdict key ${oracle.address}, anchor account ${oracle.anchorAddress}) listening on ${oracle.url}`);
    // Ctrl+C (and SIGTERM where the platform delivers it) anchors the head once more before exiting.
    const stop = () => {
      console.log("[oracle] stopping: anchoring the verdict log head");
      oracle.close().then(() => process.exit(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }, (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
