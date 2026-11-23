// Verification oracle HTTP service on 127.0.0.1:8802.
//
//   GET  /health                   the verdict signer's address and public key, and the anchor account
//   POST /jobs/:jobId/condition    make the job's secret, seal it in the vault, set the condition in the registry
//   POST /verify/:jobId            {auth} signed by the job's provider; runs the job's checks
//   GET  /verdicts?from=&limit=    the public verdict log, a page of entries (EDR-014)
//   GET  /verdicts/head            the log's latest sequence number and hash
//   GET  /verdicts/anchors         the latest anchors of the head on the testnet ledger
//   POST /jobs/:jobId/share        a shared job's client sends this oracle its sealed share {index, box, auth} (EDR-015)
//
// Shared jobs (EDR-015): the client makes the secret and splits it k of n; this
// oracle gets only its own share, sealed to its X25519 share key, and keeps it
// in the vault. It runs the job's checks like any other job, signs and logs its
// own verdict, posts it to the registry, and releases its share only with its
// own signed pass. It never sees the secret or another oracle's share.
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
// Signed job specs (EDR-016): for a job with a job spec v1, the oracle first
// reads the job's EscrowCreate on a validated ledger (from the open escrow's
// PreviousTxnID) and refuses the job, signing nothing, unless the memo there
// has the hash of the spec the registry gave it and both parties signed that
// hash. It then decides each criterion by its checks, applies the spec's rule
// (all, or at least n), and signs a verdict that names the spec hash, version,
// revision and each criterion's pass or fail. It judges the checks, never the
// words of a criterion. A job with the older unsigned spec still runs, and its
// verdict says so (spec fields null).
//
// Every verdict goes into the hash-chained public verdict log
// (src/verdict-log.ts, data/verdict-log.jsonl), which anyone on this machine
// can read. On a timer and on shutdown the oracle anchors the log's head on
// the testnet from its own anchor wallet, so a copy of the log can be compared
// with the ledger. The older unchained data/verdicts.jsonl is no longer
// written; the log's genesis entry names its hash.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Wallet, type Client } from "xrpl";
import { ReplayGuard, checkRequest, sha256Hex, signPayload } from "../auth.js";
import { makeSecret, toCondition, toFulfillment } from "../condition.js";
import { connectTestnet } from "../config.js";
import { getEscrow } from "../escrow.js";
import { HttpError, callJson, jsonServer, listenLocal, type Route } from "../http.js";
import {
  ANCHOR_FILE, ANCHOR_INTERVAL_MS, localOracleProfile, ORACLE_PORT, REGISTRY_URL, REPLAY_FILE, VAULT_FILE, VERDICT_CHAIN, VERDICT_LOG, readEnvFile, requireEnv,
} from "../local-config.js";
import type { Deliverable, Job } from "../registry/db.js";
import { CheckUnavailable, runChecks, runCriteria, stopSchemaWorker, type CheckResult } from "./checks/index.js";
import { isSpecV1, specHash, type CriterionResult } from "../job-spec.js";
import { ledgerSpecCheck, type SpecCheck } from "../spec-ledger.js";
import { ledgerTxLookup, type TxLookup } from "./checks/xrpl-tx.js";
import { SecretVault, parseVaultKey } from "./vault.js";
import { canonicalJson } from "../auth.js";
import { decodeShare, encodeShare } from "../shamir.js";
import { open as openBox, shareKeyPublic, signShareKey } from "../share-box.js";
import { AnchorBook, AnchorSchedule, MAX_PAGE, VerdictStore, ledgerAnchorer, type Anchorer } from "./verdict-store.js";
import { listAnchors, type AnchorHistory } from "../anchors.js";
import { anchorHistoryProblems, entryMismatch } from "../verdict-log.js";

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
  /** Shared jobs only (EDR-015): which share of the job's secret this oracle holds (x = 1..n), and the job's k. */
  shareIndex?: number;
  threshold?: number;
  /**
   * Phase 6 (EDR-016), on every verdict from 0.6.0: the hash, format version and
   * revision of the signed job spec this verdict judged, and each criterion's
   * pass or fail. All null for a job with an unsigned (Phase 1 to 5) spec.
   * Absent on verdicts from before 0.6.0.
   */
  specHash?: string | null;
  specVersion?: number | null;
  specRevision?: number | null;
  criteria?: CriterionResult[] | null;
  /** Always "checks": the oracle judged the machine checks, never a criterion's statement. */
  judged?: "checks";
}

export interface SignedVerdict extends VerdictBody {
  signature: string;
}

/** Returns null when the job's escrow is on the ledger as agreed, otherwise what is wrong. */
export type EscrowCheck = (job: Job) => Promise<string | null>;
export type { SpecCheck } from "../spec-ledger.js";

export interface OracleOptions {
  verdictKey: Wallet; // signs verdicts; a key of its own, not a funded wallet
  vault: SecretVault;
  serviceToken: string; // ORACLE_SERVICE_TOKEN, for writes to the registry
  escrowCheck: EscrowCheck;
  /**
   * For a job spec v1 (EDR-016): the spec read from the registry must be the one whose
   * hash is in the job's EscrowCreate memo, signed by both parties. Defaults to the
   * ledger check (src/spec-ledger.ts); without it, v1 jobs are refused.
   */
  specCheck?: SpecCheck;
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
  anchorHistory?: () => Promise<AnchorHistory>;
  /** X25519 private key (hex) that shared jobs' shares are sealed to (ORACLE_SHARE_KEY). Without it, shared jobs are refused. */
  shareKey?: string;
  /** Read .env from here instead of ENV_FILE (another local oracle of a set). */
  envFile?: string;
  /** Keep the vault, logs, anchors and replay file here instead of DATA_DIR. */
  dataDir?: string;
  /**
   * "fail" (ORACLE_FAULT=fail): sign fail on every job, whatever the work, with an
   * "oracle-fault" result in the verdict saying so. For demos and tests of a
   * dissenting oracle in a shared set. It can only withhold a share, never release one.
   */
  fault?: "fail";
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

type Outcome = { pass: boolean; results: CheckResult[]; criteria: CriterionResult[] | null };

export function oracleRoutes(opts: OracleRoutesOptions): Route[] {
  const registry = opts.registryUrl ?? REGISTRY_URL;
  // Checks still running, by job: a provider asking again before the first answer
  // waits for that run instead of starting another one.
  const running = new Map<string, Promise<Outcome>>();
  const replay = opts.replay ?? new ReplayGuard();
  const me = opts.verdictKey.address;
  const shareKeyInfo = opts.shareKey ? signShareKey(opts.verdictKey, shareKeyPublic(opts.shareKey)) : null;
  /** This oracle's place in a shared job's set: share x = position + 1. */
  const shareIndex = (job: Job): number => {
    const i = job.oracles?.findIndex((o) => o.address === me) ?? -1;
    if (i < 0) throw new HttpError(403, `this oracle (${me}) is not in the job's oracle set`);
    return i + 1;
  };
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
        shareKey: shareKeyInfo?.shareKey ?? null, shareKeySignature: shareKeyInfo?.shareKeySignature ?? null,
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
        if (job.oracles) throw new HttpError(409, "a shared job's secret is made and split by its client, not by an oracle");
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
      method: "POST", path: "/jobs/:jobId/share",
      handler: async ({ jobId }, body) => {
        if (!opts.shareKey) throw new HttpError(409, "this oracle has no share key (ORACLE_SHARE_KEY); run npm run setup");
        const job = await getJob(jobId);
        if (!job.oracles || !job.threshold || !job.condition) throw new HttpError(409, "not a shared job");
        const index = shareIndex(job);
        const b = body as { index?: unknown; box?: unknown; auth?: unknown } | undefined;
        if (b?.index !== index) throw new HttpError(400, `this oracle holds share ${index} of this job`);
        // Only the job's client hands out its shares, so nobody can get in first with a share of their own.
        checkRequest(b.auth, "share", jobId, sha256Hex(canonicalJson(b.box ?? null)), job.client, replay);
        let raw: Buffer;
        try {
          raw = openBox(b.box, opts.shareKey, { jobId, oracle: me, index });
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : "bad share box");
        }
        let share;
        try {
          share = decodeShare(raw.toString("hex"));
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : "bad share");
        }
        if (share.x !== index) throw new HttpError(400, `the box holds share ${share.x}, not share ${index}`);
        const held = opts.vault.get(jobId);
        if (held) {
          if (held.equals(raw)) return { jobId, index, stored: true };
          throw new HttpError(409, "this oracle already holds a different share for the job");
        }
        if (job.status !== "draft") throw new HttpError(409, `job is ${job.status}; shares are accepted while it is a draft`);
        opts.vault.put(jobId, raw);
        raw.fill(0);
        return { jobId, index, stored: true };
      },
    },

    {
      method: "POST", path: "/verify/:jobId",
      handler: async ({ jobId }, body) => {
        const job = await getJob(jobId);
        const shared = job.oracles !== null;
        const index = shared ? shareIndex(job) : undefined;
        // A shared job's request names this oracle, so one signed request can't be replayed at another oracle of the set.
        checkRequest((body as { auth?: unknown } | undefined)?.auth, "verify", jobId, shared ? me : "", job.provider, replay);
        if (!["delivered", "verified_pass", "verified_fail"].includes(job.status)) {
          throw new HttpError(409, `job is ${job.status}; nothing to verify`);
        }
        const secret = opts.vault.get(jobId);
        if (shared) {
          let ok = false;
          try {
            ok = !!secret && !!job.condition && decodeShare(secret.toString("hex")).x === index;
          } catch {
            ok = false;
          }
          if (!ok) throw new HttpError(409, "this oracle holds no share for this job");
        } else if (!secret || !job.condition || toCondition(secret) !== job.condition) {
          throw new HttpError(409, "this oracle does not hold the secret for the job's condition");
        }
        const escrowProblem = await opts.escrowCheck(job);
        if (escrowProblem) throw new HttpError(409, `escrow check failed: ${escrowProblem}`);
        // A signed job spec (EDR-016): judge only the spec whose hash the escrow was locked against.
        const v1 = isSpecV1(job.spec) ? job.spec : null;
        if (v1) {
          if (!opts.specCheck) throw new HttpError(409, "this oracle can't check job specs on the ledger; it refuses the job and signs nothing");
          const specProblem = await opts.specCheck(job);
          if (specProblem) throw new HttpError(409, `spec check failed: ${specProblem}. This oracle refuses the job and signs nothing; the client is refunded after the deadline`);
        }
        const deliverable = await callJson<Deliverable>("GET", `${registry}/jobs/${encodeURIComponent(jobId)}/deliverable`);

        const evidenceHash = sha256Hex(deliverable.content);
        let verdict: SignedVerdict;
        const prior = opts.store.issued(jobId);
        if (prior) {
          // Final: never run the checks again, whatever the ledger says now (Gpno N25).
          if (!prior.verdict) {
            throw new HttpError(409, `this job's verdict was already issued (log entry ${prior.entry.seq}: ${prior.entry.verdict}); it is final`);
          }
          // Never serve a verdict its public entry contradicts (Gpno N26); the store also refuses to start on one.
          const mismatch = entryMismatch(prior.entry, prior.verdict);
          if (mismatch) throw new HttpError(409, `this job's signed verdict does not match its log entry ${prior.entry.seq} (${mismatch}); nothing is released`);
          verdict = prior.verdict;
        } else {
          // A verdict from before the chained log (0.3.x) is final too, pass or fail (Gpno N36).
          // A shared job's status is the set's, not this oracle's, and shared jobs came after the chained log.
          if (!shared && (job.status === "verified_fail" || job.status === "verified_pass")) {
            throw new HttpError(409, `this job was already verified (${job.status}) before the chained verdict log; it is final`);
          }
          let run = running.get(jobId);
          if (!run) {
            const ctx = { job, content: deliverable.content, deliveredAt: deliverable.deliveredAt, lookupTx: opts.lookupTx };
            const started: Promise<Outcome> = v1
              ? runCriteria(v1, ctx)
              : runChecks((job.spec as { checks: never[] }).checks, ctx).then((o) => ({ ...o, criteria: null }));
            run = started.finally(() => running.delete(jobId));
            running.set(jobId, run);
          }
          let outcome: Outcome;
          try {
            outcome = await run;
          } catch (err) {
            // The oracle's problem, not the job's: no verdict, no status change. Ask again.
            if (err instanceof CheckUnavailable) throw new HttpError(503, err.message);
            throw err;
          }
          if (opts.fault === "fail") {
            outcome = {
              ...outcome,
              pass: false,
              results: [...outcome.results, { type: "oracle-fault", pass: false, detail: "this oracle was started with ORACLE_FAULT=fail and fails every job" }],
            };
          }
          // Two calls that waited on the same run: the first one back signs and logs.
          const now = opts.store.issued(jobId);
          if (now?.verdict) {
            verdict = now.verdict;
          } else {
            const unsigned: VerdictBody = {
              jobId, verdict: outcome.pass ? "pass" : "fail", checks: outcome.results, evidenceHash,
              condition: job.condition!, provider: job.provider, oracle: opts.verdictKey.address,
              publicKey: opts.verdictKey.publicKey, issuedAt: Date.now(),
              ...(shared ? { shareIndex: index, threshold: job.threshold! } : {}),
              specHash: v1 ? specHash(v1) : null, specVersion: v1 ? v1.specVersion : null, specRevision: v1 ? v1.revision : null,
              criteria: outcome.criteria, judged: "checks",
            };
            verdict = { ...unsigned, signature: signPayload(unsigned, opts.verdictKey) };
            opts.store.append(verdict);
          }
        }
        if (verdict.evidenceHash !== evidenceHash) throw new HttpError(409, "the stored deliverable does not match the verdict issued for it");
        const pass = verdict.verdict === "pass";
        const results = verdict.checks;

        if (shared) {
          // The registry checks the signature against the job's set and counts it toward k.
          try {
            await callJson("POST", `${registry}/jobs/${encodeURIComponent(jobId)}/verdicts`, { verdict });
          } catch (err) {
            // The verdict is signed and logged; the provider's SDK posts it as well.
            console.error(`[oracle] could not post the verdict for ${jobId} to the registry: ${err instanceof Error ? err.message : err}`);
          }
          return pass ? { verdict, share: encodeShare(decodeShare(secret!.toString("hex"))) } : { verdict };
        }
        if (job.status === "delivered") {
          await callJson("POST", `${registry}/jobs/${encodeURIComponent(jobId)}/events`, {
            source: "oracle", status: pass ? "verified_pass" : "verified_fail",
            detail: results.map((r) => `${r.type}: ${r.pass ? "pass" : "fail"}`).join(", "),
          }, opts.serviceToken);
        }
        return pass ? { verdict, fulfillment: toFulfillment(secret!) } : { verdict };
      },
    },
  ];
}

export async function startOracle(opts: Partial<OracleOptions> & { port?: number } = {}) {
  const env = readEnvFile(opts.envFile);
  const at = (name: string, fallback: string) => (opts.dataDir ? resolve(opts.dataDir, name) : fallback);
  const verdictKey = opts.verdictKey ?? Wallet.fromSeed(requireEnv(env, "ORACLE_VERDICT_SEED"));
  const vault = opts.vault ?? new SecretVault(at("oracle-vault.json", VAULT_FILE), parseVaultKey(env.ORACLE_VAULT_KEY));
  const serviceToken = opts.serviceToken ?? requireEnv(env, "ORACLE_SERVICE_TOKEN");
  const shareKey = opts.shareKey ?? env.ORACLE_SHARE_KEY;
  const faultSetting = opts.fault ?? process.env.ORACLE_FAULT;
  if (faultSetting !== undefined && faultSetting !== "" && faultSetting !== "fail") throw new Error("ORACLE_FAULT may only be fail");
  const fault = faultSetting === "fail" ? "fail" as const : undefined;
  if (fault) console.error("[oracle] ORACLE_FAULT=fail: this oracle signs FAIL on every job (a dissenting oracle, for demos and tests)");
  // Read and check the log before touching the network: a broken log stops the oracle here.
  const store = new VerdictStore(opts.verdictChain ?? at("verdict-log.jsonl", VERDICT_CHAIN), verdictKey, opts.verdictLog ?? at("verdicts.jsonl", VERDICT_LOG));
  const anchors = new AnchorBook(opts.anchorFile ?? at("verdict-anchors.jsonl", ANCHOR_FILE));
  let ledger: Client | null = null;
  const needsLedger = !opts.escrowCheck || !opts.anchorer || !opts.lookupTx;
  const anchorWallet = opts.anchorer ? null : Wallet.fromSeed(requireEnv(env, "ORACLE_ANCHOR_SEED"));
  if (needsLedger) ledger = await connectTestnet();
  const escrowCheck = opts.escrowCheck ?? ledgerEscrowCheck(ledger!);
  const lookupTx = opts.lookupTx ?? ledgerTxLookup(ledger! as never);
  // Tests that stand in for the ledger pass their own specCheck; without one and without a ledger, v1 jobs are refused.
  const specCheck = opts.specCheck ?? (ledger ? ledgerSpecCheck(ledger, lookupTx) : undefined);
  const anchorer = opts.anchorer ?? ledgerAnchorer(ledger!, anchorWallet!, verdictKey.address);
  const anchorAddress = opts.anchorAddress ?? anchorWallet?.address;
  // Never extend a log that disagrees with what the anchor account already put on the
  // ledger, such as a second chain started from a fresh data folder (Gpno N29).
  const history = opts.anchorHistory
    ?? (anchorWallet ? () => listAnchors(ledger!, anchorWallet.address, verdictKey.address) : async () => ({ anchors: [], complete: true }));
  const { anchors: onLedger, complete } = await history();
  // An incomplete read could hide an older, different genesis: fail closed (Gpno N32).
  if (!complete) {
    await ledger?.disconnect();
    throw new Error(`refusing to start: ${anchorAddress} has more transactions than the anchor lookback reads, so older anchors `
      + "could not be checked against the log. Use a fresh anchor wallet (remove ORACLE_ANCHOR_SEED and ORACLE_ANCHOR_ADDRESS "
      + "from .env and run npm run setup) or raise ANCHOR_LOOKBACK_TX.");
  }
  const conflicts = anchorHistoryProblems(store.all(), onLedger, verdictKey.address);
  if (conflicts.length > 0) {
    await ledger?.disconnect();
    throw new Error(`refusing to start: the anchors on the ledger from ${anchorAddress} disagree with ${store.path} `
      + `(${conflicts.join("; ")}). One anchor account anchors one log: a fresh data folder or a new verdict key `
      + "needs a fresh anchor wallet (remove ORACLE_ANCHOR_SEED and ORACLE_ANCHOR_ADDRESS from .env and run npm run setup).");
  }
  const schedule = new AnchorSchedule(store, anchors, anchorer, opts.anchorIntervalMs ?? ANCHOR_INTERVAL_MS, undefined, onLedger[0] ?? null);
  const replay = opts.replay ?? new ReplayGuard(at("oracle-replay.json", REPLAY_FILE));
  const server = jsonServer(oracleRoutes({
    ...opts, verdictKey, vault, serviceToken, escrowCheck, specCheck, replay, store, anchors, lookupTx, anchorAddress, shareKey, fault,
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
  // `npm run oracle:b` / `oracle:c` start the other two local oracles of a shared set (EDR-015).
  const flag = process.argv.indexOf("--oracle");
  const name = flag >= 0 ? process.argv[flag + 1] : undefined;
  const profile = name ? localOracleProfile(name) : undefined;
  startOracle(profile ? { envFile: profile.envFile, dataDir: profile.dataDir, port: profile.port } : {}).then((oracle) => {
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
