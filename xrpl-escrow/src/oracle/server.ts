// Verification oracle HTTP service on 127.0.0.1:8802.
//
//   GET  /health                   the verdict signer's address and public key
//   POST /jobs/:jobId/condition    make the job's secret, seal it in the vault, set the condition in the registry
//   POST /verify/:jobId            {auth} signed by the job's provider; runs the job's checks
//
// The oracle is the only process that holds secrets. It reads the job spec and
// deliverable from the registry and only hashes, parses or validates them; it
// never executes or follows anything inside them. Before it verifies anything
// it confirms on the ledger that the job's escrow exists with the agreed
// amount, provider, condition and deadline, so a forged registry status can't
// get a fulfillment released. A verify call returns a verdict signed with the
// oracle's ed25519 verdict key, and the fulfillment only on a pass and only to
// the job's provider. Every verdict is appended to a JSONL log. If the checks
// can't run for a reason that isn't the job's (the schema checker is busy or
// restarting), it answers 503 and signs nothing, so the provider can ask again
// (Gpno N9). A job's check results are remembered, so asking again after a
// verdict doesn't run the checks a second time.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { Wallet, type Client } from "xrpl";
import { ReplayGuard, checkRequest, sha256Hex, signPayload } from "../auth.js";
import { makeSecret, toCondition, toFulfillment } from "../condition.js";
import { connectTestnet } from "../config.js";
import { getEscrow } from "../escrow.js";
import { HttpError, callJson, jsonServer, listenLocal, type Route } from "../http.js";
import { ORACLE_PORT, REGISTRY_URL, REPLAY_FILE, VAULT_FILE, VERDICT_LOG, readEnvFile, requireEnv } from "../local-config.js";
import type { Deliverable, Job } from "../registry/db.js";
import { CheckUnavailable, runChecks, stopSchemaWorker, type CheckResult } from "./checks/index.js";
import { SecretVault, parseVaultKey } from "./vault.js";

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
  verdictLog?: string;
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

/** Verified jobs whose check results are kept, so asking again doesn't run the checks again. */
const MAX_REMEMBERED_RESULTS = 1_024;

export function oracleRoutes(opts: OracleOptions): Route[] {
  const registry = opts.registryUrl ?? REGISTRY_URL;
  // jobId|evidenceHash -> results. A deliverable can't change once posted, so a
  // second verify of the same job gets the same results without spending the
  // schema worker's time again (Gpno N9).
  const remembered = new Map<string, { pass: boolean; results: CheckResult[] }>();
  // Checks still running, by the same key: a provider asking again before the first
  // answer waits for that run instead of starting another one.
  const running = new Map<string, Promise<{ pass: boolean; results: CheckResult[] }>>();
  const verdictLog = opts.verdictLog ?? VERDICT_LOG;
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
      handler: () => ({ ok: true, service: "oracle", oracle: opts.verdictKey.address, publicKey: opts.verdictKey.publicKey }),
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
        const key = `${jobId}|${evidenceHash}`;
        let outcome = remembered.get(key);
        if (!outcome) {
          let run = running.get(key);
          if (!run) {
            run = runChecks(job.spec.checks, { job, content: deliverable.content, deliveredAt: deliverable.deliveredAt })
              .finally(() => running.delete(key));
            running.set(key, run);
          }
          try {
            outcome = await run;
          } catch (err) {
            // The oracle's problem, not the job's: no verdict, no status change. Ask again.
            if (err instanceof CheckUnavailable) throw new HttpError(503, err.message);
            throw err;
          }
          if (remembered.size >= MAX_REMEMBERED_RESULTS) remembered.delete(remembered.keys().next().value!);
          remembered.set(key, outcome);
        }
        const { pass, results } = outcome;
        const unsigned: VerdictBody = {
          jobId, verdict: pass ? "pass" : "fail", checks: results, evidenceHash,
          condition: job.condition, provider: job.provider, oracle: opts.verdictKey.address,
          publicKey: opts.verdictKey.publicKey, issuedAt: Date.now(),
        };
        const verdict: SignedVerdict = { ...unsigned, signature: signPayload(unsigned, opts.verdictKey) };

        mkdirSync(dirname(verdictLog), { recursive: true });
        appendFileSync(verdictLog, `${JSON.stringify(verdict)}\n`);
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
  let ledger: Client | null = null;
  let escrowCheck = opts.escrowCheck;
  if (!escrowCheck) {
    ledger = await connectTestnet();
    escrowCheck = ledgerEscrowCheck(ledger);
  }
  const replay = opts.replay ?? new ReplayGuard(REPLAY_FILE);
  const server = jsonServer(oracleRoutes({ ...opts, verdictKey, vault, serviceToken, escrowCheck, replay }));
  const port = await listenLocal(server, opts.port ?? ORACLE_PORT);
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    address: verdictKey.address,
    close: () => new Promise<void>((done) => {
      server.close(() => {
        const rest = Promise.all([stopSchemaWorker(), ledger ? ledger.disconnect() : Promise.resolve()]);
        rest.then(() => done(), () => done());
      });
      server.closeAllConnections();
    }),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startOracle().then(({ url, address }) => console.log(`oracle (verdict key ${address}) listening on ${url}`), (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
