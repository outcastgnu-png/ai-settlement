// Verification oracle for one job. It creates the job's secret and is the
// only party that holds it, so neither client nor provider can unlock the
// escrow alone. Phase 1 check: the deliverable's SHA-256 must equal the hash
// agreed in the job spec. Richer checks (schema, tests, AI judge) come later.
import { createHash } from "node:crypto";
import { makeSecret, toCondition, toFulfillment } from "./condition.js";

export const sha256Hex = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

export class JobOracle {
  readonly #secret = makeSecret();

  /** The condition the client locks the escrow with. Safe to share. */
  readonly condition = toCondition(this.#secret);

  /** Returns the fulfillment if the deliverable matches, otherwise null. */
  verify(deliverable: Buffer | string, expectedHash: string): string | null {
    return sha256Hex(deliverable) === expectedHash.toLowerCase() ? toFulfillment(this.#secret) : null;
  }
}
