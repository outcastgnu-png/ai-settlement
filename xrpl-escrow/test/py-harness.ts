// Starts a throwaway registry and oracle (no ledger: every escrow "exists")
// for the Python SDK's cross-language tests, prints their addresses and the
// test watcher token as one JSON line, and stops when stdin closes.
// Used by xrpl-escrow-py/tests/test_kit_local.py; not a service to run by hand.
// For signed specs (EDR-016) it also starts a stand-in ledger for EscrowCreate memos (memoLedgerUrl).
import { startLocal, startMemoLedger, TOKENS } from "./helpers.js";

const local = await startLocal();
const memoLedger = await startMemoLedger();
console.log(JSON.stringify({
  registryUrl: local.registry.url, oracleUrl: local.oracle.url, oracleAddress: local.verdictKey.address,
  watcherToken: TOKENS.watcher, memoLedgerUrl: memoLedger.url,
}));
process.stdin.resume();
process.stdin.on("end", async () => {
  await local.close();
  await memoLedger.close();
  process.exit(0);
});
