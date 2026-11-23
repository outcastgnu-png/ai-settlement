// Lists the shared jobs (EDR-015) where the oracles of the set disagreed: at
// least one signed pass and one signed fail. Honest oracles running the same
// deterministic checks agree, so each line here is worth a look; every verdict
// in it is signed by its oracle and in that oracle's own log. For a job with a
// signed spec (EDR-016) it also shows the criteria the set split on.
//
//   npm run splits
import { REGISTRY_URL } from "./local-config.js";
import { EscrowKit } from "./sdk/index.js";

const kit = new EscrowKit({ registryUrl: REGISTRY_URL, oracleAddress: "", anchorAddress: "" });
const splits = await kit.splitJobs();
if (splits.length === 0) console.log(`No split jobs in the registry at ${REGISTRY_URL}.`);
for (const s of splits) {
  console.log(`job ${s.jobId} (${s.status}, ${s.threshold} of ${s.oracles.length} needed)`);
  console.log(`  passed: ${s.passed.join(", ") || "none"}`);
  console.log(`  failed: ${s.failed.join(", ") || "none"}`);
  // A signed spec (EDR-016): which criteria the oracles disagreed on. Every oracle judged the same spec hash.
  if (s.specHash) console.log(`  spec ${s.specHash}`);
  for (const c of s.criteria ?? []) console.log(`  split on criterion ${c.id}: passed by ${c.passed.join(", ")}; failed by ${c.failed.join(", ")}`);
  if (!s.specHash) console.log("  unsigned spec: no per-criterion results");
}
