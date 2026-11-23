// size-range (EDR-016): passes when the deliverable is from minBytes to maxBytes
// long, counted in UTF-8 bytes. For "delivered a file" style criteria.
import type { SizeRangeSpec } from "../../check-spec.js";
import type { CheckContext, CheckResult } from "./types.js";

export function sizeRange(spec: SizeRangeSpec, ctx: CheckContext): CheckResult {
  const bytes = Buffer.byteLength(ctx.content, "utf8");
  const pass = bytes >= spec.minBytes && bytes <= spec.maxBytes;
  return { type: "size-range", pass, detail: `${bytes} bytes (allowed ${spec.minBytes} to ${spec.maxBytes})` };
}
