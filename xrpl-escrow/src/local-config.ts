// Settings for the Phase 2 local services. Everything binds to 127.0.0.1;
// exposing a service beyond this machine needs a new EDR.
import { randomBytes } from "node:crypto";
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
export const VERDICT_LOG = env("VERDICT_LOG", resolve(DATA_DIR, "verdicts.jsonl"));
export const REPLAY_FILE = env("REPLAY_FILE", resolve(DATA_DIR, "oracle-replay.json"));

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
 */
export function ensureLocalSecrets(path = ENV_FILE): void {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const has = (key: string) => new RegExp(`^${key}=`, "m").test(current) || process.env[key] !== undefined;
  const add: string[] = [];
  const hex32 = () => randomBytes(32).toString("hex");
  if (!has("ORACLE_VAULT_KEY")) add.push(`ORACLE_VAULT_KEY=${hex32()}`);
  if (!has("ORACLE_SERVICE_TOKEN")) add.push(`ORACLE_SERVICE_TOKEN=${hex32()}`);
  if (!has("WATCHER_SERVICE_TOKEN")) add.push(`WATCHER_SERVICE_TOKEN=${hex32()}`);
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
