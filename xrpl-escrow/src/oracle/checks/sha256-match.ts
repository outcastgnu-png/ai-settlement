// Passes when the deliverable's SHA-256 equals the hash agreed in the job spec.
import { sha256Hex } from "../../auth.js";
import type { CheckContext, CheckResult } from "./types.js";

export function sha256Match(spec: { sha256: string }, ctx: CheckContext): CheckResult {
  const actual = sha256Hex(ctx.content);
  const pass = actual === spec.sha256.toLowerCase();
  return { type: "sha256-match", pass, detail: pass ? "sha256 matches the spec" : `sha256 ${actual} does not match the spec` };
}
