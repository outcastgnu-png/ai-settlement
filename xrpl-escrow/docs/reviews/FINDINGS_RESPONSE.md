# Response to Gpno's verdict (PASS WITH FINDINGS)

Verdict: [`VERDICT-2026-10-20-deb71ea.md`](VERDICT-2026-10-20-deb71ea.md), for commit `deb71ea`. The fixes below were committed on
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
- **Second review:** Gpno found a schema that passes this policy and is still exponential (N1,
  nested `anyOf` over local `$ref`s). See "Second review" below for the fix.

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

## Second review (2026-10-21, `VERDICT.md`, on `af9a4db`): PASS WITH FINDINGS

Verdict: findings 3, 4, 6 and 7 fixed, 5 partly. Two new blocking findings, N1 and N2, one nit,
N6, and four process items for Christopher (N3, N4, N5, N7). Christopher approved the commit of the
changes below on 2026-10-21 at 05:40 UTC ("yes"), after `7317e48` (the Windows run) was brought
into this copy of the repo.

| # | Finding | Status | What changed |
|---|---|---|---|
| N1 | Exponential validation from nested `anyOf` over local `$ref`s, allowed by the policy | Fixed | Two layers. (1) `src/schema-policy.ts` now resolves every local `$ref`: a `$ref` that points nowhere, a recursive `$ref`, more than 64 `$ref`s, or a schema that exceeds 4096 nodes once every `$ref` is inlined is refused. Gpno's bomb at N=22 is refused in milliseconds, and the registry returns 400 for it. Ordinary reuse of a definition is still allowed. (2) The JSON Schema check now runs in a worker thread (`src/oracle/checks/json-schema-worker.ts`) with a hard timeout, 2 s by default (`src/oracle/checks/json-schema.ts`). On timeout the worker is killed, the check fails with "took longer than 2000 ms and was stopped", and a fresh worker serves the next request. `runChecks` is now async and the oracle awaits it. |
| N2 | Replay guard keyed on the raw signature string; a re-cased signature replays | Fixed | `ReplayGuard` is keyed on `replayKey()` = sha256 of the upper-cased public key and the exact message that was signed (`action|jobId|timestamp|payloadHash`), not on the signature (`src/auth.ts`). Any encoding of the same signature maps to the same key. The persisted file format is unchanged. |
| N3 | Which EDR-011 text Christopher accepted | Resolved | Christopher chose "restore" (2026-10-21 05:40 UTC). The four clauses are back in `edr/EDR-011_ESCROW_PHASE1_TESTNET_DEMO.md`, each marked "(restored 2026-10-21)" |
| N4 | `e54e6d8` committed without explicit approval | Resolved | Approved after the fact by Christopher (2026-10-21 05:40 UTC). From now on every commit gets its own explicit approval |
| N5 | All approvals written by the implementer | **Awaiting Christopher** | He said yes to signing `edr/ACCEPTANCES.md` himself; a signature line is there for him |
| N6 | Duplicate `node_modules` line; old verdict-log path no longer ignored | Fixed | `xrpl-escrow/.gitignore` lists `node_modules` once, without the trailing slash, so it also matches the symlinked `node_modules` in the cloud build copy (the reason for the second line), and ignores the old `src/oracle/verdicts.jsonl` path again |
| N7 | EDR numbers continue PersonalAi's series | Resolved | Christopher chose to keep the numbers |

Also fixed: the README's Windows quickstart said `escrow-demo`; the folder is `xrpl-escrow` (found
by the Windows run).

Evidence:
- `test/oracle.test.ts` "refuses $ref chains that blow up when expanded, and recursive $ref"
  (N1 policy), "stops a validation that runs past the timeout and keeps working afterwards" (N1
  worker; a test-only request holds the worker for 5 s against a 300 ms timeout), and the
  re-cased-signature cases in "answers only the job's provider, and only once per signature" (N2).
  `test/registry.test.ts` "refuses job schemas that could make validation slow" now includes the
  N=22 bomb and a recursive `$ref`.
- Results (Linux, Node 22.22.0): `typecheck` 0 errors; `test:unit` **54/54**; `demo:phase2`
  **49/49** on testnet (`logs/2026-10-21-phase2-fixes2.txt`, transactions in
  `logs/2026-10-21-phase2-fixes2-txs.json`). `npm test` in full not yet re-run.

## Phase 3 review (2026-10-21, `VERDICT.md`, on `a0f6e1b` plus the uncommitted Phase 3 tree): FAIL

The second review's verdict is archived as `VERDICT-2026-10-21-af9a4db.md`. The third
(confirmation) verdict on `a0f6e1b` was never placed in the repo; it should be archived as
`VERDICT-2026-10-21-a0f6e1b.md` once Christopher shares its text.

| # | Status | Where | Test that fails when the fix is reverted |
|---|---|---|---|
| N8 | fixed | `src/schema-policy.ts`: one walk over the schema as Ajv will see it. A `$ref` must point at a subschema; `resolveSchemaPointer` follows the pointer and refuses one that passes through `enum`, `const`, `default`, `examples` or other data, ends on a name map (`properties`), a list (`anyOf`) or a scalar, or indexes an array that isn't a schema list. Every `$ref` target is then checked for banned keywords like the rest. | `test/oracle.test.ts` "refuses a $ref into enum, const or other data" (includes your exact schema); `test/registry.test.ts` 400 for the same at job creation. The old policy file fails the oracle test |
| N9 | fixed | `src/oracle/checks/json-schema.ts`: the 2 s clock starts when the worker says it has started the request, so start-up after a kill and queue time never count; a crashed or slow-to-start worker and a full queue (8 waiting) throw `CheckUnavailable`. `src/oracle/server.ts`: that becomes 503 with no verdict signed, logged or recorded; one run of a job's checks at a time (concurrent asks share it); results remembered per job and deliverable, so asking again costs nothing. `src/registry/server.ts`: at most 8 checks per job. Both SDKs retry a 503 with a fresh signature | `test/oracle.test.ts`: "does not count a fresh worker's start-up", "turns a crashed worker or a full queue into CheckUnavailable", "answers 503 ... then verifies on a retry", "runs a job's checks once"; `test/registry.test.ts` "limits how many checks"; `xrpl-escrow-py/tests/test_retry.py`. Three of the four oracle tests failed on the old code; the start-up test passed on it too, and now checks that the slow start really happened, so it fails as well (N20) |
| N12 | fixed | `docs/THREAT_MODEL.md`: states the schema limits exactly, says N8 existed before 0.3.0, and adds the availability row (one worker, delays not fails, 503 and retry, a deadline can still pass) | — |
| N13 | fixed | `auth.py` `canonical_json` raises on floats, NaN, integers past 2^53 and lone surrogates | `tests/test_parity.py` |
| N14 | fixed | keys sort by UTF-16 code unit | `tests/test_parity.py` (checked against the TypeScript output) |
| N15 | fixed | `claim()` refuses a fulfillment that doesn't open the job's condition; the docs say it does not check the verdict | `tests/test_kit_local.py` |
| N16 | fixed | `submit_validated` raises a tem/tef/tel preliminary result at once | — (exercised only on testnet) |
| N17 | fixed | `QUICKSTART.md`: release zip until the public repository exists, `npm ci`, macOS/Linux spellings | — |
| N5 | fixed | Christopher gave the signature wording at 20:47 UTC; written into `edr/ACCEPTANCES.md` and committed under his name in `8dab15e` with his approval (21:35 UTC, "Approve both") | — |
| N10 | fixed | Windows run for Phase 3 on Christopher's PC (Windows 11, Node 24.18.0, Python 3.14.6). It found one test bug: five verify requests signed in the same millisecond were the same request, so four got "auth already used". The test now signs distinct timestamps; `signRequest` takes an optional timestamp and its docs say so. After that: oracle tests 27/27 on 3 runs, unit 61/61, npm test 65/65, pytest 25+1 and 26 with --testnet, quickstart first job paid, Python demo 12/12 | `logs/2026-10-21-phase3-windows*.txt` |
| N11 | fixed | `7b2d357` (the work) is authored by Claude; `8dab15e` (the signature line only) by Christopher Terrell <outcastgnu@gmail.com> | — |
| N18 | info | — | — |

Also done: Apache-2.0 `LICENSE` and `NOTICE`, and the `SECURITY.md` contact (Christopher's
choice, 20:47 UTC).

## Phase 3 re-review (Gpno, PASS WITH FINDINGS on `8dab15e`)

Gpno's re-review verdict is now `VERDICT.md`; the Phase 3 FAIL is archived as
`VERDICT-2026-10-21-phase3-fail.md`. Gpno's addendum (2026-10-21, 18:10 CT) closes N24 and N22,
so the verdict is an unconditional PASS WITH FINDINGS. The verdict lists N19, N20, N21 and N23 as
open and non-blocking because it reviewed `8dab15e`; they are fixed in `eb0c313`.

| # | Status | Where | Test that fails when the fix is reverted |
|---|---|---|---|
| N19 | fixed | `src/schema-policy.ts`: `$id`, `id`, `$anchor`, `$dynamicRef`, `$dynamicAnchor`, `$recursiveRef` and `$recursiveAnchor` are banned, and `$schema` is allowed only at the root, so a `$ref` always resolves from the root, as the policy reads it | `test/oracle.test.ts` "refuses $id, $anchor and other keywords that change what a $ref means" (includes your `$id` shape) |
| N20 | fixed | the start-up test now checks that the 1.5 s slow start really ran, so the old worker (which ignores the hook) fails it | `test/oracle.test.ts` "does not count a fresh worker's start-up" |
| N21 | documented | `docs/THREAT_MODEL.md` availability row, and the `requestVerification` / `request_verification` docs in both SDKs: the SDK stops after about 6 s; the work stays delivered and the caller asks again before `cancelAfter`. Retry behaviour unchanged, so both SDKs stay alike. Per-provider fairness comes with hosting | — |
| N22 | closed by Gpno (addendum) | `7b2d357` against the Windows-tested tree (`a0f6e1b` + the Phase 3 tree as zipped at 21:06 + `phase3-windows-n9-fix.patch`): no code or test file differs. Only the 16 Windows logs (added after the run), the N10 row here, and the blank signature line in `edr/ACCEPTANCES.md` differ | — |
| N23 | fixed | `QUICKSTART.md` faucet threshold 60 XRP; `npm ci` in `docs/trial/TRIAL_SCRIPT.md` and both READMEs; N5 and N11 rows above. "UTC5" in the signature is Christopher's own wording and is left as he wrote it | — |
| N24 | closed by Gpno (addendum) | From the repository: HEAD `8dab15e`, `git status --porcelain` empty, `8dab15e` authored by Christopher Terrell <outcastgnu@gmail.com> and touching only `edr/ACCEPTANCES.md` (5+, 1-), and `git diff a0f6e1b 8dab15e` identical to `phase3-fixes.diff`. Output in `handoff/N24-integrity.txt` | — |

## Still open

- The NOT DEMONSTRATED items from the first review were all run on Christopher's Windows PC on
  2026-10-21 at `e54e6d8` and passed (commit `7317e48`). Not re-run after the N1/N2 fixes.
- TLS for any non-localhost deployment (finding 6).
