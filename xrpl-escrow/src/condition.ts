// PREIMAGE-SHA-256 crypto-conditions (draft-thomas-crypto-conditions-04), the
// condition type XRPL escrows accept. The DER encoding for a 32-byte secret is
// fixed, so it is written out by hand:
//   condition   = A0 25 | 80 20 <sha256(secret)> | 81 01 20
//   fulfillment = A0 22 | 80 20 <secret>
import { createHash, randomBytes } from "node:crypto";

const SECRET_LENGTH = 32;

export function makeSecret(): Buffer {
  return randomBytes(SECRET_LENGTH);
}

function checkLength(secret: Buffer) {
  if (secret.length !== SECRET_LENGTH) throw new Error(`secret must be ${SECRET_LENGTH} bytes`);
}

/** Uppercase hex for EscrowCreate.Condition and EscrowFinish.Condition. */
export function toCondition(secret: Buffer): string {
  checkLength(secret);
  const fingerprint = createHash("sha256").update(secret).digest();
  return Buffer.concat([
    Buffer.from([0xa0, 0x25, 0x80, 0x20]),
    fingerprint,
    Buffer.from([0x81, 0x01, SECRET_LENGTH]),
  ]).toString("hex").toUpperCase();
}

/** Uppercase hex for EscrowFinish.Fulfillment. */
export function toFulfillment(secret: Buffer): string {
  checkLength(secret);
  return Buffer.concat([Buffer.from([0xa0, 0x22, 0x80, 0x20]), secret]).toString("hex").toUpperCase();
}
