// Starts a throwaway registry and three oracles of a shared set (EDR-015; no
// ledger: every escrow "exists"), with oracle 3 dissenting (ORACLE_FAULT=fail),
// for the Python SDK's shared-verification tests. Prints the set and the test
// watcher token as one JSON line and stops when stdin closes.
// Used by xrpl-escrow-py/tests/test_shared_local.py; not a service to run by hand.
// For signed specs (EDR-016) it also starts a stand-in ledger for EscrowCreate memos (memoLedgerUrl).
import { TOKENS, startMemoLedger, startSharedLocal } from "./helpers.js";

const local = await startSharedLocal(3, [undefined, undefined, "fail"]);
const memoLedger = await startMemoLedger();
console.log(JSON.stringify({ registryUrl: local.registry.url, oracles: local.set(), watcherToken: TOKENS.watcher, memoLedgerUrl: memoLedger.url }));
process.stdin.resume();
process.stdin.on("end", async () => {
  await local.close();
  await memoLedger.close();
  process.exit(0);
});
