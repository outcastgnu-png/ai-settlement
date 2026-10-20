// Settings for the Phase 2 local services. Everything binds to 127.0.0.1;
// exposing a service beyond this machine needs a new EDR.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "dotenv";

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
export const VERDICT_LOG = env("VERDICT_LOG", resolve("src", "oracle", "verdicts.jsonl"));

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

/** Add ORACLE_VAULT_KEY (32 random bytes, hex) to .env if it is missing. Never prints it. */
export function ensureVaultKey(path = ENV_FILE): void {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (/^ORACLE_VAULT_KEY=/m.test(current) || process.env.ORACLE_VAULT_KEY) return;
  const sep = current === "" || current.endsWith("\n") ? "" : "\n";
  writeFileSync(path, `${current}${sep}ORACLE_VAULT_KEY=${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
}
