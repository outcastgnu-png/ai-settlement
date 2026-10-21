// Signed requests and signed verdicts, using XRPL account keys.
//
// A provider proves who it is by signing "<action>|<jobId>|<timestamp>|<payloadHash>"
// with its wallet key; the server checks that the public key derives to the
// job's provider address. The oracle signs its verdicts the same way.
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { dirname } from "node:path";
import { deriveAddress, sign, verify } from "ripple-keypairs";
import type { Wallet } from "xrpl";
import { HttpError } from "./http.js";

export const sha256Hex = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const hexOf = (text: string) => Buffer.from(text, "utf8").toString("hex").toUpperCase();

export interface RequestAuth {
  publicKey: string;
  timestamp: number; // unix ms
  signature: string;
}

const MAX_SKEW_MS = 120_000;

const requestMessage = (action: string, jobId: string, timestamp: number, payloadHash: string) =>
  hexOf(`${action}|${jobId}|${timestamp}|${payloadHash}`);

export function signRequest(wallet: Wallet, action: string, jobId: string, payloadHash = ""): RequestAuth {
  const timestamp = Date.now();
  return {
    publicKey: wallet.publicKey,
    timestamp,
    signature: sign(requestMessage(action, jobId, timestamp, payloadHash), wallet.privateKey),
  };
}

/**
 * Remembers request signatures for longer than the freshness window, so a
 * signed request can be used once. With a file path it survives restarts.
 */
export class ReplayGuard {
  readonly #used = new Map<string, number>(); // signature -> request timestamp (ms)

  constructor(readonly path?: string) {
    if (path && existsSync(path)) {
      const saved = JSON.parse(readFileSync(path, "utf8")) as Record<string, number>;
      for (const [sig, ts] of Object.entries(saved)) this.#used.set(sig, ts);
    }
  }

  /** Records the signature; false if it was already used. */
  use(signature: string, timestamp: number): boolean {
    const cutoff = Date.now() - 2 * MAX_SKEW_MS;
    for (const [sig, ts] of this.#used) if (ts < cutoff) this.#used.delete(sig);
    if (this.#used.has(signature)) return false;
    this.#used.set(signature, timestamp);
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.#used)));
      renameSync(tmp, this.path);
    }
    return true;
  }
}

/** Throws 401/403 unless `auth` is a fresh, valid signature by `expectedAddress`. */
export function checkRequest(
  auth: unknown, action: string, jobId: string, payloadHash: string, expectedAddress: string, replay?: ReplayGuard,
): void {
  const a = auth as Partial<RequestAuth> | undefined;
  if (!a || typeof a.publicKey !== "string" || typeof a.signature !== "string" || typeof a.timestamp !== "number") {
    throw new HttpError(401, "signed auth {publicKey, timestamp, signature} required");
  }
  if (Math.abs(Date.now() - a.timestamp) > MAX_SKEW_MS) throw new HttpError(401, "auth timestamp is stale");
  let valid = false;
  try {
    valid = verify(requestMessage(action, jobId, a.timestamp, payloadHash), a.signature, a.publicKey);
  } catch {
    valid = false;
  }
  if (!valid) throw new HttpError(401, "bad signature");
  if (deriveAddress(a.publicKey) !== expectedAddress) throw new HttpError(403, "only the job's provider may do this");
  if (replay && !replay.use(a.signature, a.timestamp)) throw new HttpError(401, "auth already used");
}

const digest = (text: string) => createHash("sha256").update(text).digest();

/** Throws 401 unless the request carries `Authorization: Bearer <expected>`. Compared in constant time. */
export function checkBearer(headers: IncomingHttpHeaders, expected: string, who: string): void {
  const header = headers.authorization ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!given || !timingSafeEqual(digest(given), digest(expected))) {
    throw new HttpError(401, `only the ${who} may do this`);
  }
}

/** JSON with sorted keys, so a verdict signs and verifies byte-for-byte the same everywhere. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value).sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function signPayload(payload: unknown, wallet: Wallet): string {
  return sign(hexOf(canonicalJson(payload)), wallet.privateKey);
}

/** True if `signature` over `payload` was made by the key behind `publicKey`, which must belong to `address`. */
export function verifyPayload(payload: unknown, signature: string, publicKey: string, address: string): boolean {
  try {
    return deriveAddress(publicKey) === address && verify(hexOf(canonicalJson(payload)), signature, publicKey);
  } catch {
    return false;
  }
}
