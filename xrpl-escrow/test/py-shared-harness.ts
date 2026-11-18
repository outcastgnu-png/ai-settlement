// Starts a throwaway registry and three oracles of a shared set (EDR-015; no
// ledger: every escrow "exists"), with oracle 3 dissenting (ORACLE_FAULT=fail),
// for the Python SDK's shared-verification tests. Prints the set and the test
// watcher token as one JSON line and stops when stdin closes.
// Used by xrpl-escrow-py/tests/test_shared_local.py; not a service to run by hand.
import { TOKENS, startSharedLocal } from "./helpers.js";

const local = await startSharedLocal(3, [undefined, undefined, "fail"]);
console.log(JSON.stringify({ registryUrl: local.registry.url, oracles: local.set(), watcherToken: TOKENS.watcher }));
process.stdin.resume();
process.stdin.on("end", async () => {
  await local.close();
  process.exit(0);
});
