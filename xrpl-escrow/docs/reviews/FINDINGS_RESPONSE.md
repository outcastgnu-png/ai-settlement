# Response to Gpno's verdict (PASS WITH FINDINGS)

Verdict: [`VERDICT.md`](VERDICT.md), for commit `deb71ea`. The fixes below were committed on
`main` on top of `deb71ea` with Christopher's approval ("Yes proceed", 2026-10-21 05:07 UTC).

| # | Finding | Status | What changed |
|---|---|---|---|
| 1 | EDR-011 missing; EDRs not accepted by name; EDR-012 names Codex | **Resolved** | On 2026-10-20 at 17:04 UTC Christopher wrote: "I accept EDR-011 and EDR-012, reviewer Gpno". This is recorded in `edr/ACCEPTANCES.md`, and EDR-012 now shows Status Accepted with Gpno as reviewer. EDR-011 had never been written down; at his request it is now `edr/EDR-011_ESCROW_PHASE1_TESTNET_DEMO.md`, restating `xrpl-escrow/CLAUDE.md`, Status Accepted |
| 2 | Phase branches missing; commit approval not on record | **Resolved by Christopher** | On 2026-10-20 at 16:41 UTC Christopher chose "Keep history": `main` stays as it is and the branch requirement is waived. His 08:14 UTC message asked for `git init` and the baseline commit, which is the approval for `ed122ab` and `deb71ea` |
| 3 | Node 20 documented, but `npm ci` needs Node 22.12 or newer | Fixed | `engines.node` is `>=22.12` in `package.json` and the lockfile. `.npmrc` sets `engine-strict=true`, so older Node versions fail at install with a clear message. README, REVIEW.md and REVIEW_HANDOFF.md say Node 22.12 or newer |
| 4 | Forged `ledger` events accepted by the registry | Fixed | See "Finding 4" below |
| 5 | ReDoS through Ajv; unbounded cache | Fixed (worker timeout not added) | See "Finding 5" below |
| 6 | Minor items | Fixed, except plain HTTP | See "Finding 6" below |
| 7 | Run-log transaction hashes no longer retrievable from public servers | Fixed for future runs | `demo:phase2` now saves every transaction's validated JSON to `logs/<date>-phase2-txs.json` and never overwrites an earlier log |

## Finding 4: authenticated registry writes, and an escrow check on the ledger

- `npm run setup` adds two random 32-byte tokens to `.env`: `ORACLE_SERVICE_TOKEN` and
  `WATCHER_SERVICE_TOKEN`.
- `PUT /jobs/:id/condition` and `POST /jobs/:id/events` with `source: "oracle"` need
  `Authorization: Bearer <ORACLE_SERVICE_TOKEN>`. Events with `source: "ledger"` need the
  watcher's token. Tokens are compared in constant time (`src/auth.ts` `checkBearer`). A missing
  or wrong token gets 401, and the oracle's token can't post ledger events.
- Before it verifies anything, the oracle reads the escrow from the latest validated ledger and
  checks that it exists, pays the job's provider, holds the job's price, uses the job's condition
  and has the job's `CancelAfter` (`src/oracle/server.ts` `ledgerEscrowCheck`). If any of these
  fails, it returns 409 with no verdict and no fulfillment, and the job's status doesn't change.
  This holds even if something gets past the token check.
- Evidence:
  - `test/registry.test.ts` "accepts internal writes only with the right service token".
  - `test/oracle.test.ts` "releases nothing when the escrow is not on the ledger as agreed".
  - On testnet, the demo check "a forged ledger event without the watcher's token is refused"
    returned 401, and every pass in the run went through the real escrow check.

## Finding 5: limits on JSON Schemas

- `src/schema-policy.ts` refuses these schema keywords: `pattern` and `patternProperties` (both
  run the schema's own regex), `uniqueItems` (compares array items pairwise), `format` (no format
  plugins are loaded) and `$data`. It also refuses any `$ref` that isn't local, any schema over
  16 KB, and nesting deeper than 32 levels. Property names such as `pattern` inside `properties`
  are still allowed.
- The registry applies the policy when a job is created (400), and the oracle applies it again
  before compiling. The compiled-validator cache holds at most 256 entries, and each schema is
  removed from Ajv's own registry after compiling.
- Evidence:
  - The Gpno case, `pattern: "^(a+)+$"` checked against 40 a's followed by `!`, is now refused
    in under 100 ms (`test/oracle.test.ts`).
  - `test/registry.test.ts` "refuses job schemas that could make validation slow".
  - On testnet, the demo check "a job schema with a regex pattern is refused" returned 400.
- **Not done:** running checks in a worker thread with a timeout. With regex keywords and
  `uniqueItems` banned, and schemas and deliverables size-capped, I know of no remaining
  super-linear Ajv keyword. A worker timeout would still be good defense in depth before Phase 3,
  and it is listed as a gap.

## Finding 6: minor items

| Item | Change |
|---|---|
| Replay set lost on restart | `ReplayGuard` in `src/auth.ts` saves used signatures to `data/oracle-replay.json`. Test: "remembers used signatures across a restart" |
| Verdict key is the wallet seed | Verdicts are signed with a separate ed25519 key, `ORACLE_VERDICT_SEED`, which is not a funded account. Its public address, `ORACLE_VERDICT_ADDRESS`, is in `.env` |
| `verifyVerdict` address optional, taken from `/health` | `verifyVerdict(verdict, oracleAddress)` now requires the address. The SDK takes it from `oracleAddress` or `ORACLE_VERDICT_ADDRESS` and never from `/health`. Test: "does not trust a verdict from an oracle address other than the pinned one" |
| `max-latency` uses a forgeable `fundedAt` | The watcher reports `fundedAt` as the close time of the ledger that validated the EscrowCreate, and only the watcher's token can set it |
| `verdicts.jsonl` under `src/` | It is now `data/verdicts.jsonl`, gitignored with the rest of `data/`. This departs from the path in `CLAUDE_PHASE2.md` |
| Fulfillment over plain HTTP | **Not changed.** The services bind to 127.0.0.1 only. TLS is needed before anything leaves localhost, which already requires a new EDR |

## Results after the fixes (2026-10-20, Linux, Node 22.22.0)

| Command | Result |
|---|---|
| `npm run typecheck` | 0 errors |
| `npm run test:unit` | **52/52** (7 condition, 11 registry, 20 oracle, 6 watcher, 8 SDK) |
| `npm run demo:phase2` | **49/49** checks: the 47 checks from the reviewed run plus the 2 new security checks. Log: `logs/2026-10-20-phase2-fixes.txt`; transactions: `logs/2026-10-20-phase2-fixes-txs.json` (9 of 9 validated) |
| `npm test` | **54/54** in 364.9 s, including both testnet flows |

The Phase 1 code, `npm run demo` and its 18 checks are unchanged.

## Still open

- The NOT DEMONSTRATED items in `VERDICT.md`: the Windows run, the README quickstart,
  `expired_unclaimed` on testnet, and watcher reconnect.
- Running checks in a worker with a timeout (finding 5), and TLS for any non-localhost deployment
  (finding 6).
