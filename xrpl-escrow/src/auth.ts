// Signed requests and signed verdicts, using XRPL account keys.
//
// A provider proves who it is by signing "<action>|<jobId>|<timestamp>|<payloadHash>"
// with its wallet key; the server checks that the public key derives to the
// job's provider address. The oracle signs its verdicts the same way.
import { createHash } from "node:crypto";
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

/** Throws 401/403 unless `auth` is a fresh, valid signature by `expectedAddress`. */
export function checkRequest(
  auth: unknown, action: string, jobId: string, payloadHash: string, expectedAddress: string, seen?: Set<string>,
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
  if (seen) {
    if (seen.has(a.signature)) throw new HttpError(401, "auth already used");
    seen.add(a.signature);
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
