// Verification oracle HTTP service on 127.0.0.1:8802.
//
//   GET  /health                   oracle address and public key, for checking verdict signatures
//   POST /jobs/:jobId/condition    make the job's secret, seal it in the vault, set the condition in the registry
//   POST /verify/:jobId            {auth} signed by the job's provider; runs the job's checks
//
// The oracle is the only process that holds secrets. It reads the job spec and
// deliverable from the registry and only hashes, parses or validates them; it
// never executes or follows anything inside them. A verify call returns a
// verdict signed with the oracle wallet's key, and the fulfillment only on a
// pass and only to the job's provider. Every verdict is appended to a JSONL log.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { Wallet } from "xrpl";
import { checkRequest, sha256Hex, signPayload } from "../auth.js";
import { makeSecret, toCondition, toFulfillment } from "../condition.js";
import { HttpError, callJson, jsonServer, listenLocal, type Route } from "../http.js";
import { ORACLE_PORT, REGISTRY_URL, VAULT_FILE, VERDICT_LOG, readEnvFile } from "../local-config.js";
import type { Deliverable, Job } from "../registry/db.js";
import { runChecks, type CheckResult } from "./checks/index.js";
import { SecretVault, parseVaultKey } from "./vault.js";

export interface VerdictBody {
  jobId: string;
  verdict: "pass" | "fail";
  checks: CheckResult[];
  evidenceHash: string; // sha256 of the deliverable the checks ran on
  condition: string;
  provider: string;
  oracle: string; // oracle XRPL address
  publicKey: string;
  issuedAt: number;
}

export interface SignedVerdict extends VerdictBody {
  signature: string;
}

export interface OracleOptions {
  wallet: Wallet;
  vault: SecretVault;
  registryUrl?: string;
  verdictLog?: string;
}

export function oracleRoutes(opts: OracleOptions): Route[] {
  const registry = opts.registryUrl ?? REGISTRY_URL;
  const verdictLog = opts.verdictLog ?? VERDICT_LOG;
  const usedAuth = new Set<string>();
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
      handler: () => ({ ok: true, service: "oracle", oracle: opts.wallet.address, publicKey: opts.wallet.publicKey }),
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
        await callJson("PUT", `${registry}/jobs/${encodeURIComponent(jobId)}/condition`, { condition });
        return { jobId, condition };
      },
    },

    {
      method: "POST", path: "/verify/:jobId",
      handler: async ({ jobId }, body) => {
        const job = await getJob(jobId);
        checkRequest((body as { auth?: unknown } | undefined)?.auth, "verify", jobId, "", job.provider, usedAuth);
        if (!["delivered", "verified_pass", "verified_fail"].includes(job.status)) {
          throw new HttpError(409, `job is ${job.status}; nothing to verify`);
        }
        const secret = opts.vault.get(jobId);
        if (!secret || !job.condition || toCondition(secret) !== job.condition) {
          throw new HttpError(409, "this oracle does not hold the secret for the job's condition");
        }
        const deliverable = await callJson<Deliverable>("GET", `${registry}/jobs/${encodeURIComponent(jobId)}/deliverable`);

        const { pass, results } = runChecks(job.spec.checks, { job, content: deliverable.content, deliveredAt: deliverable.deliveredAt });
        const unsigned: VerdictBody = {
          jobId, verdict: pass ? "pass" : "fail", checks: results, evidenceHash: sha256Hex(deliverable.content),
          condition: job.condition, provider: job.provider, oracle: opts.wallet.address, publicKey: opts.wallet.publicKey,
          issuedAt: Date.now(),
        };
        const verdict: SignedVerdict = { ...unsigned, signature: signPayload(unsigned, opts.wallet) };

        mkdirSync(dirname(verdictLog), { recursive: true });
        appendFileSync(verdictLog, `${JSON.stringify(verdict)}\n`);
        if (job.status === "delivered") {
          await callJson("POST", `${registry}/jobs/${encodeURIComponent(jobId)}/events`, {
            source: "oracle", status: pass ? "verified_pass" : "verified_fail",
            detail: results.map((r) => `${r.type}: ${r.pass ? "pass" : "fail"}`).join(", "),
          });
        }
        return pass ? { verdict, fulfillment: toFulfillment(secret) } : { verdict };
      },
    },
  ];
}

export async function startOracle(opts: Partial<OracleOptions> & { port?: number } = {}) {
  const env = readEnvFile();
  const wallet = opts.wallet ?? (env.ORACLE_SEED ? Wallet.fromSeed(env.ORACLE_SEED) : null);
  if (!wallet) throw new Error("ORACLE_SEED is missing from .env; run the demo once to create testnet wallets");
  const vault = opts.vault ?? new SecretVault(VAULT_FILE, parseVaultKey(env.ORACLE_VAULT_KEY));
  const server = jsonServer(oracleRoutes({ ...opts, wallet, vault }));
  const port = await listenLocal(server, opts.port ?? ORACLE_PORT);
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    address: wallet.address,
    close: () => new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    }),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startOracle().then(({ url, address }) => console.log(`oracle ${address} listening on ${url}`), (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
