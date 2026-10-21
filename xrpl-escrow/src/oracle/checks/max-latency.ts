// Passes when the work was delivered within maxMs of the escrow being funded.
// fundedAt is the close time of the ledger that validated the EscrowCreate, as
// reported by the authenticated watcher; deliveredAt is when the registry
// stored the work.
import type { CheckContext, CheckResult } from "./types.js";

export function maxLatency(spec: { maxMs: number }, ctx: CheckContext): CheckResult {
  const fundedAt = ctx.job.fundedAt;
  if (fundedAt === null) return { type: "max-latency", pass: false, detail: "job was never funded" };
  const latency = ctx.deliveredAt - fundedAt;
  const pass = latency <= spec.maxMs;
  return { type: "max-latency", pass, detail: `delivered ${latency} ms after funding (limit ${spec.maxMs} ms)` };
}
