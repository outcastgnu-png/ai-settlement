// contains-text (EDR-016): passes when the deliverable contains the spec's text
// exactly: literal, case-sensitive, no regular expression (the schema policy
// refuses regex for the same reason: a hostile pattern can take forever).
import type { ContainsTextSpec } from "../../check-spec.js";
import type { CheckContext, CheckResult } from "./types.js";

export function containsText(spec: ContainsTextSpec, ctx: CheckContext): CheckResult {
  const pass = ctx.content.includes(spec.text);
  // The detail never quotes the deliverable, only says whether the agreed text was found.
  return { type: "contains-text", pass, detail: pass ? "the agreed text is in the deliverable" : "the agreed text is not in the deliverable" };
}
