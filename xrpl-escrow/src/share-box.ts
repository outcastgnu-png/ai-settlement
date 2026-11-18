// Sealing a secret share to one oracle (EDR-015). Each oracle has an X25519
// "share key" of its own (ORACLE_SHARE_KEY in its .env), separate from its
// ed25519 verdict key. The oracle publishes the public half on /health,
// signed by its verdict key (`shareKeyStatement`), so a client that pins the
// oracle's verdict address can check the share key really is that oracle's.
//
// A sealed share ("box") is: a fresh ephemeral X25519 key, ECDH with the
// oracle's share key, HKDF-SHA256 (salt = ephemeral public key || oracle
// public key) to an AES-256-GCM key, and the share encrypted under it. The
// context string binds the box to one job, one oracle and one share index;
// it is both the HKDF info and the GCM associated data, so a box can't be
// replayed into another job or handed to another oracle.
//
// The Python SDK seals the same way (xrpl_escrow/share_box.py); both are
// checked against test/vectors/share-box.json.
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from "node:crypto";
import type { Wallet } from "xrpl";
import { signPayload, verifyPayload } from "./auth.js";

export const BOX_VERSION = 1;
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");
const HEX32 = /^[0-9a-f]{64}$/;

export interface ShareBox {
  v: number;
  epk: string; // ephemeral X25519 public key, 32 bytes hex
  iv: string; // 12 bytes hex
  ct: string; // the encrypted share, hex
  tag: string; // GCM tag, 16 bytes hex
}

export interface BoxContext {
  jobId: string;
  oracle: string; // the oracle's verdict address
  index: number; // the share's x value, 1..n
}

export const boxContext = (c: BoxContext) => `xrpl-escrow/share/v1|${c.jobId}|${c.oracle}|${c.index}`;

export function privateKeyFromHex(hex: string): KeyObject {
  if (!HEX32.test(hex)) throw new Error("an X25519 private key is 32 bytes of lowercase hex");
  return createPrivateKey({ key: Buffer.concat([PKCS8_X25519, Buffer.from(hex, "hex")]), format: "der", type: "pkcs8" });
}

export function publicKeyFromHex(hex: string): KeyObject {
  if (!HEX32.test(hex)) throw new Error("an X25519 public key is 32 bytes of lowercase hex");
  return createPublicKey({ key: Buffer.concat([SPKI_X25519, Buffer.from(hex, "hex")]), format: "der", type: "spki" });
}

export const publicHex = (key: KeyObject): string =>
  (createPublicKey(key).export({ format: "der", type: "spki" }) as Buffer).subarray(SPKI_X25519.length).toString("hex");

const privateHex = (key: KeyObject): string =>
  (key.export({ format: "der", type: "pkcs8" }) as Buffer).subarray(PKCS8_X25519.length).toString("hex");

/** A new share key, as the 32-byte private key hex that goes in .env. */
export function generateShareKey(): string {
  return privateHex(generateKeyPairSync("x25519").privateKey);
}

/** The public share key for a private one in .env. */
export const shareKeyPublic = (privateHex: string) => publicHex(privateKeyFromHex(privateHex));

function aesKey(shared: Buffer, epk: string, rpk: string, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.from(epk + rpk, "hex"), Buffer.from(info, "utf8"), 32));
}

/**
 * Seal `share` to the oracle whose public share key is `recipient`. Tests pass a
 * fixed `ephemeral` private key and `iv` to make vectors; never do that otherwise.
 */
export function seal(share: Buffer, recipient: string, ctx: BoxContext, fixed?: { ephemeral: string; iv: string }): ShareBox {
  const eph = fixed ? privateKeyFromHex(fixed.ephemeral) : generateKeyPairSync("x25519").privateKey;
  const epk = publicHex(eph);
  const shared = diffieHellman({ privateKey: eph, publicKey: publicKeyFromHex(recipient) });
  const info = boxContext(ctx);
  const key = aesKey(shared, epk, recipient, info);
  const iv = fixed ? Buffer.from(fixed.iv, "hex") : randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(info, "utf8"));
  const ct = Buffer.concat([cipher.update(share), cipher.final()]);
  key.fill(0);
  shared.fill(0);
  return { v: BOX_VERSION, epk, iv: iv.toString("hex"), ct: ct.toString("hex"), tag: cipher.getAuthTag().toString("hex") };
}

/** Open a box with this oracle's private share key. Throws if it was not sealed to this key for exactly this context. */
export function open(box: unknown, privateKey: string, ctx: BoxContext): Buffer {
  const b = box as Partial<ShareBox> | null;
  if (!b || typeof b !== "object" || b.v !== BOX_VERSION || typeof b.epk !== "string" || !HEX32.test(b.epk)
    || typeof b.iv !== "string" || !/^[0-9a-f]{24}$/.test(b.iv) || typeof b.tag !== "string" || !/^[0-9a-f]{32}$/.test(b.tag)
    || typeof b.ct !== "string" || !/^([0-9a-f]{2}){1,256}$/.test(b.ct)) {
    throw new Error("not a share box");
  }
  const priv = privateKeyFromHex(privateKey);
  const rpk = publicHex(priv);
  const shared = diffieHellman({ privateKey: priv, publicKey: publicKeyFromHex(b.epk) });
  const info = boxContext(ctx);
  const key = aesKey(shared, b.epk, rpk, info);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(b.iv, "hex"));
    decipher.setAAD(Buffer.from(info, "utf8"));
    decipher.setAuthTag(Buffer.from(b.tag, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(b.ct, "hex")), decipher.final()]);
  } catch {
    throw new Error("the share box does not open with this oracle's key for this job and index");
  } finally {
    key.fill(0);
    shared.fill(0);
  }
}

/** What an oracle signs with its verdict key to vouch for its share key. */
export interface ShareKeyStatement {
  purpose: "xrpl-escrow/share-key";
  oracle: string;
  shareKey: string;
}

export function signShareKey(verdictKey: Wallet, shareKey: string): { shareKey: string; shareKeySignature: string } {
  const body: ShareKeyStatement = { purpose: "xrpl-escrow/share-key", oracle: verdictKey.address, shareKey };
  return { shareKey, shareKeySignature: signPayload(body, verdictKey) };
}

/** True when `shareKey` is vouched for by the verdict key behind `publicKey`, which must belong to the pinned `oracle`. */
export function verifyShareKey(oracle: string, publicKey: string, shareKey: string, signature: string): boolean {
  if (typeof shareKey !== "string" || !HEX32.test(shareKey) || typeof signature !== "string") return false;
  const body: ShareKeyStatement = { purpose: "xrpl-escrow/share-key", oracle, shareKey };
  return verifyPayload(body, signature, publicKey, oracle);
}
