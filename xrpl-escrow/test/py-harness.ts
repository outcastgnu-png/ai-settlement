// Starts a throwaway registry and oracle (no ledger: every escrow "exists")
// for the Python SDK's cross-language tests, prints their addresses and the
// test watcher token as one JSON line, and stops when stdin closes.
// Used by xrpl-escrow-py/tests/test_kit_local.py; not a service to run by hand.
import { startLocal, TOKENS } from "./helpers.js";

const local = await startLocal();
console.log(JSON.stringify({
  registryUrl: local.registry.url, oracleUrl: local.oracle.url, oracleAddress: local.verdictKey.address,
  watcherToken: TOKENS.watcher,
}));
process.stdin.resume();
process.stdin.on("end", async () => {
  await local.close();
  process.exit(0);
});
