// Shamir secret sharing over GF(256) (EDR-015). The client splits a job's
// 32-byte preimage into n shares so that any k of them rebuild it and fewer
// than k say nothing about it. Each byte of the secret is the constant term of
// its own random polynomial of degree k-1; share x holds that polynomial's
// value at x for every byte.
//
// The field is GF(2^8) with the AES reduction polynomial x^8+x^4+x^3+x+1
// (0x11B), so adding is XOR. Share x-coordinates are 1..n, in the order of the
// job's oracle set. A share is written as hex of [x, y_0, ..., y_31].
//
// Combining k shares always gives *some* 32 bytes, even from a wrong share, so
// callers check the result against the job's condition (see `combineForCondition`
// in the SDK). The Python SDK implements the same field and encoding
// (xrpl_escrow/shamir.py) and is checked against test/vectors/shamir.json.
import { randomBytes } from "node:crypto";

export const MAX_SHARES = 255;

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    // multiply by the generator 3: x*2 xor x, reduced by 0x11B
    x ^= (x << 1) ^ (x & 0x80 ? 0x11b : 0);
    x &= 0xff;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

export function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error("division by zero in GF(256)");
  if (a === 0) return 0;
  return EXP[LOG[a] + 255 - LOG[b]];
}

export interface Share {
  x: number; // 1..255
  y: Buffer; // one byte per secret byte
}

/** Source of the polynomials' random coefficients; tests pass a fixed one for vectors. */
export type RandomSource = (n: number) => Buffer;

function checkParams(k: number, n: number) {
  if (!Number.isInteger(k) || !Number.isInteger(n)) throw new Error("threshold and share count must be whole numbers");
  if (k < 2) throw new Error("threshold must be at least 2 (one share would be the secret)");
  if (n < k) throw new Error("share count must be at least the threshold");
  if (n > MAX_SHARES) throw new Error(`at most ${MAX_SHARES} shares`);
}

/**
 * Split `secret` into `n` shares with threshold `k`. The coefficients come from
 * `random` (default crypto.randomBytes), read as k-1 bytes per secret byte, in order.
 */
export function split(secret: Buffer, k: number, n: number, random: RandomSource = randomBytes): Share[] {
  checkParams(k, n);
  if (secret.length === 0) throw new Error("secret must not be empty");
  const coeffs = random(secret.length * (k - 1));
  if (coeffs.length !== secret.length * (k - 1)) throw new Error("random source returned the wrong number of bytes");
  const shares: Share[] = [];
  for (let x = 1; x <= n; x++) {
    const y = Buffer.alloc(secret.length);
    for (let i = 0; i < secret.length; i++) {
      // Horner, highest coefficient first: a_{k-1} ... a_1, then the secret byte a_0.
      let acc = 0;
      for (let j = k - 2; j >= 0; j--) acc = gfMul(acc, x) ^ coeffs[i * (k - 1) + j];
      y[i] = gfMul(acc, x) ^ secret[i];
    }
    shares.push({ x, y });
  }
  coeffs.fill(0);
  return shares;
}

/**
 * Rebuild the secret from shares by Lagrange interpolation at x = 0. Every share
 * given is used, so pass exactly the ones you trust. Throws on fewer than 2
 * shares, repeated x values, or shares of different lengths; it cannot tell a
 * wrong share from a right one.
 */
export function combine(shares: Share[]): Buffer {
  if (shares.length < 2) throw new Error("need at least 2 shares");
  const len = shares[0].y.length;
  const xs = new Set<number>();
  for (const s of shares) {
    if (!Number.isInteger(s.x) || s.x < 1 || s.x > MAX_SHARES) throw new Error(`share x must be 1..${MAX_SHARES}`);
    if (xs.has(s.x)) throw new Error(`share ${s.x} is given twice`);
    xs.add(s.x);
    if (s.y.length !== len || len === 0) throw new Error("shares have different lengths");
  }
  const out = Buffer.alloc(len);
  for (const sj of shares) {
    // basis_j(0) = product over m != j of x_m / (x_m - x_j); minus is xor here
    let basis = 1;
    for (const sm of shares) if (sm.x !== sj.x) basis = gfMul(basis, gfDiv(sm.x, sm.x ^ sj.x));
    for (let i = 0; i < len; i++) out[i] ^= gfMul(basis, sj.y[i]);
  }
  return out;
}

export const encodeShare = (s: Share): string => Buffer.concat([Buffer.from([s.x]), s.y]).toString("hex");

export function decodeShare(hex: string, length = 32): Share {
  if (typeof hex !== "string" || !new RegExp(`^[0-9a-f]{${2 * (length + 1)}}$`).test(hex)) {
    throw new Error(`a share is ${length + 1} bytes of lowercase hex`);
  }
  const raw = Buffer.from(hex, "hex");
  if (raw[0] === 0) throw new Error("share x must not be 0");
  return { x: raw[0], y: raw.subarray(1) };
}

/** Every way to pick `k` items from `items`, in order. */
export function choose<T>(items: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (items.length < k) return [];
  const [first, ...rest] = items;
  return [...choose(rest, k - 1).map((c) => [first, ...c]), ...choose(rest, k)];
}
