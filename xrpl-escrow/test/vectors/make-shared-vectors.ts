// Writes test/vectors/shamir.json and test/vectors/share-box.json: Shamir splits
// with fixed coefficients, and share boxes with fixed keys and nonces, so the
// Python SDK can be checked against the same bytes (EDR-015). Vector keys only.
// Run with: npx tsx test/vectors/make-shared-vectors.ts
import { writeFileSync } from "node:fs";
import { sha256Hex } from "../../src/auth.js";
import { encodeShare, split } from "../../src/shamir.js";
import { seal, shareKeyPublic } from "../../src/share-box.js";

const bytes = (label: string, n: number) => {
  let out = "";
  for (let i = 0; out.length < 2 * n; i++) out += sha256Hex(`${label} ${i}`);
  return out.slice(0, 2 * n);
};

const splits = [[2, 3], [3, 5], [2, 2], [4, 7]].map(([k, n], c) => {
  const secret = bytes(`secret ${c}`, 32);
  const coefficients = bytes(`coefficients ${c}`, 32 * (k - 1));
  const shares = split(Buffer.from(secret, "hex"), k, n, () => Buffer.from(coefficients, "hex")).map(encodeShare);
  return { k, n, secret, coefficients, shares };
});
// Edge bytes: an all-zero and an all-ff secret.
for (const [name, fill] of [["zero", "00"], ["ff", "ff"]]) {
  const secret = fill.repeat(32);
  const coefficients = bytes(`coefficients ${name}`, 32);
  splits.push({ k: 2, n: 3, secret, coefficients, shares: split(Buffer.from(secret, "hex"), 2, 3, () => Buffer.from(coefficients, "hex")).map(encodeShare) });
}
writeFileSync("test/vectors/shamir.json", `${JSON.stringify({ field: "GF(2^8), reduction 0x11B, share = hex(x || y)", splits }, null, 1)}\n`);

const boxes = [1, 2, 3].map((index) => {
  const recipientPrivate = bytes(`recipient ${index}`, 32);
  const recipientPublic = shareKeyPublic(recipientPrivate);
  const ephemeralPrivate = bytes(`ephemeral ${index}`, 32);
  const iv = bytes(`iv ${index}`, 12);
  const context = { jobId: `6f7c1e9a-0000-4000-8000-00000000000${index}`, oracle: "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH", index };
  const share = splits[0].shares[index - 1];
  return { recipientPrivate, recipientPublic, ephemeralPrivate, iv, context, share, box: seal(Buffer.from(share, "hex"), recipientPublic, context, { ephemeral: ephemeralPrivate, iv }) };
});
writeFileSync("test/vectors/share-box.json", `${JSON.stringify({ scheme: "X25519 + HKDF-SHA256 + AES-256-GCM, see src/share-box.ts", boxes }, null, 1)}\n`);
console.log(`wrote ${splits.length} splits and ${boxes.length} boxes`);
