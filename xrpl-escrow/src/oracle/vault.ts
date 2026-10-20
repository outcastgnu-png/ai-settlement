// Encrypted storage for job secrets. Each secret is sealed with AES-256-GCM
// under ORACLE_VAULT_KEY (32 bytes, hex, from .env), with the job id as
// associated data so a sealed secret can't be moved to another job. The file
// survives oracle restarts; the key never touches disk outside .env.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface Sealed {
  iv: string;
  tag: string;
  ct: string;
}

interface VaultFile {
  version: 1;
  entries: Record<string, Sealed>;
}

export function parseVaultKey(hex: string | undefined): Buffer {
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("ORACLE_VAULT_KEY must be 32 bytes of hex (64 characters)");
  return Buffer.from(hex, "hex");
}

export class SecretVault {
  readonly #key: Buffer;

  constructor(readonly path: string, key: Buffer) {
    if (key.length !== 32) throw new Error("vault key must be 32 bytes");
    this.#key = key;
  }

  #read(): VaultFile {
    if (!existsSync(this.path)) return { version: 1, entries: {} };
    const file = JSON.parse(readFileSync(this.path, "utf8")) as VaultFile;
    return { version: 1, entries: { ...file.entries } };
  }

  has(jobId: string): boolean {
    return Object.hasOwn(this.#read().entries, jobId);
  }

  put(jobId: string, secret: Buffer): void {
    const file = this.#read();
    if (Object.hasOwn(file.entries, jobId)) throw new Error(`vault already holds a secret for job ${jobId}`);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(jobId, "utf8"));
    const ct = Buffer.concat([cipher.update(secret), cipher.final()]);
    file.entries[jobId] = { iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ct: ct.toString("hex") };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 1), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  /** The job's secret, or null if the vault has none. Throws if the entry fails authentication. */
  get(jobId: string): Buffer | null {
    const file = this.#read();
    if (!Object.hasOwn(file.entries, jobId)) return null;
    const sealed = file.entries[jobId];
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(sealed.iv, "hex"));
    decipher.setAAD(Buffer.from(jobId, "utf8"));
    decipher.setAuthTag(Buffer.from(sealed.tag, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(sealed.ct, "hex")), decipher.final()]);
  }
}
