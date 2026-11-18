// Settings for the Phase 2 local services. Everything binds to 127.0.0.1;
// exposing a service beyond this machine needs a new EDR.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "dotenv";
import { Wallet, type ECDSA } from "xrpl";

export const LOCALHOST = "127.0.0.1";

const env = (name: string, fallback: string) => process.env[name] ?? fallback;

export const ENV_FILE = env("ENV_FILE", ".env");
export const DATA_DIR = env("DATA_DIR", "data");
export const REGISTRY_PORT = Number(env("REGISTRY_PORT", "8801"));
export const ORACLE_PORT = Number(env("ORACLE_PORT", "8802"));
export const REGISTRY_URL = env("REGISTRY_URL", `http://${LOCALHOST}:${REGISTRY_PORT}`);
export const ORACLE_URL = env("ORACLE_URL", `http://${LOCALHOST}:${ORACLE_PORT}`);
export const JOBS_DB = env("JOBS_DB", resolve(DATA_DIR, "jobs.db"));
export const VAULT_FILE = env("VAULT_FILE", resolve(DATA_DIR, "oracle-vault.json"));
/** The Phase 2/3 unchained verdict log. Kept as it is; the chained log's genesis entry names its hash. */
export const VERDICT_LOG = env("VERDICT_LOG", resolve(DATA_DIR, "verdicts.jsonl"));
/** The hash-chained public verdict log (EDR-014). */
export const VERDICT_CHAIN = env("VERDICT_CHAIN", resolve(DATA_DIR, "verdict-log.jsonl"));
export const ANCHOR_FILE = env("ANCHOR_FILE", resolve(DATA_DIR, "verdict-anchors.jsonl"));
/** How often the oracle anchors a moved log head on the testnet. */
export const ANCHOR_INTERVAL_MS = Number(env("ANCHOR_INTERVAL_MS", String(10 * 60_000)));
export const REPLAY_FILE = env("REPLAY_FILE", resolve(DATA_DIR, "oracle-replay.json"));

/** A new X25519 share key as 32 bytes of hex (the same as share-box.ts generateShareKey; kept here to avoid an import cycle). */
const generateShareKey = () =>
  (generateKeyPairSync("x25519").privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).subarray(16).toString("hex");

/** Values from .env, with process.env taking precedence. */
export function readEnvFile(path = ENV_FILE): Record<string, string> {
  const fromFile = existsSync(path) ? parse(readFileSync(path)) : {};
  const merged: Record<string, string> = { ...fromFile };
  for (const key of Object.keys(fromFile)) {
    const value = process.env[key];
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * Local secrets the services need, created in .env if missing and never printed:
 *   ORACLE_VAULT_KEY        AES-256-GCM key for the oracle's secret vault
 *   ORACLE_SERVICE_TOKEN    lets the oracle set conditions and verdict statuses in the registry
 *   WATCHER_SERVICE_TOKEN   lets the watcher post ledger events to the registry
 *   ORACLE_VERDICT_SEED     ed25519 key the oracle signs verdicts with (not a funded wallet)
 *   ORACLE_VERDICT_ADDRESS  public: the address SDK users pin to check verdict signatures
 *   ORACLE_SHARE_KEY        X25519 key that shared jobs' shares are sealed to (EDR-015)
 * With `oracleOnly` (the env file of another local oracle of a set) the watcher token
 * is left out and the oracle service token is copied from `serviceToken`.
 */
export function ensureLocalSecrets(path = ENV_FILE, opts: { oracleOnly?: boolean; serviceToken?: string } = {}): void {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  // Another oracle's file is only ever read from the file itself, never from this process's environment.
  const has = (key: string) => new RegExp(`^${key}=`, "m").test(current) || (!opts.oracleOnly && process.env[key] !== undefined);
  const add: string[] = [];
  const hex32 = () => randomBytes(32).toString("hex");
  if (!has("ORACLE_VAULT_KEY")) add.push(`ORACLE_VAULT_KEY=${hex32()}`);
  if (!has("ORACLE_SERVICE_TOKEN")) add.push(`ORACLE_SERVICE_TOKEN=${opts.serviceToken ?? hex32()}`);
  if (!opts.oracleOnly && !has("WATCHER_SERVICE_TOKEN")) add.push(`WATCHER_SERVICE_TOKEN=${hex32()}`);
  if (!has("ORACLE_SHARE_KEY")) add.push(`ORACLE_SHARE_KEY=${generateShareKey()}`);
  if (!has("ORACLE_VERDICT_SEED")) {
    const verdictKey = Wallet.generate("ed25519" as ECDSA);
    add.push(`ORACLE_VERDICT_SEED=${verdictKey.seed}`, `ORACLE_VERDICT_ADDRESS=${verdictKey.address}`);
  }
  if (add.length === 0) return;
  const sep = current === "" || current.endsWith("\n") ? "" : "\n";
  writeFileSync(path, `${current}${sep}${add.join("\n")}\n`, { mode: 0o600 });
}

/** Read a required value from .env, with a hint to run setup when it is missing. */
export function requireEnv(env: Record<string, string>, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is missing from .env; run npm run setup`);
  return value;
}

/**
 * The three local oracles of a shared set (EDR-015). Oracle "a" is the oracle the
 * kit always had (.env, data/, port 8802); "b" and "c" have their own .env file,
 * data folder, keys and anchor wallet, made by npm run setup.
 */
export interface OracleProfile {
  name: string;
  envFile: string;
  dataDir: string;
  port: number;
}

export const LOCAL_ORACLES = ["a", "b", "c"] as const;

export function localOracleProfile(name: string, base: { envFile?: string; dataDir?: string; port?: number } = {}): OracleProfile {
  const i = (LOCAL_ORACLES as readonly string[]).indexOf(name);
  if (i < 0) throw new Error(`unknown local oracle "${name}"; use a, b or c`);
  const envFile = resolve(base.envFile ?? ENV_FILE);
  const dataDir = resolve(base.dataDir ?? DATA_DIR);
  const port = (base.port ?? ORACLE_PORT) + i;
  if (i === 0) return { name, envFile, dataDir, port };
  return { name, envFile: `${envFile}.oracle-${name}`, dataDir: resolve(dataDir, `oracle-${name}`), port };
}

/**
 * The public, pinned half of the local oracle set: each oracle's verdict address,
 * anchor account and URL, read from the env files setup wrote. A real set would be
 * agreed with the people running the other oracles; nothing here is a secret.
 */
export function localOracleSet(base: { envFile?: string; dataDir?: string; port?: number } = {}): { address: string; anchor: string; url: string }[] {
  return LOCAL_ORACLES.map((name) => {
    const p = localOracleProfile(name, base);
    const env = existsSync(p.envFile) ? parse(readFileSync(p.envFile)) : {};
    if (!env.ORACLE_VERDICT_ADDRESS || !env.ORACLE_ANCHOR_ADDRESS) {
      throw new Error(`oracle ${name}: ${p.envFile} has no ORACLE_VERDICT_ADDRESS or ORACLE_ANCHOR_ADDRESS; run npm run setup`);
    }
    return { address: env.ORACLE_VERDICT_ADDRESS, anchor: env.ORACLE_ANCHOR_ADDRESS, url: `http://${LOCALHOST}:${p.port}` };
  });
}
