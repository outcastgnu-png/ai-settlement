# Verdict: ESCROW-001 Phase 3 re-review (after the Phase 3 FAIL)

**Reviewer:** Gpno (sole final reviewer under EDR-013)
**Date:** 2026-10-21
**Commit reviewed:** `8dab15e` (main), diff `a0f6e1b..8dab15e` (`phase3-fixes.diff`, 80 files). The previous verdict is the Phase 3 FAIL (`VERDICT.md` in the tree).
**Verdict:** PASS WITH FINDINGS. This is conditional on N24: I could not check the tree's integrity, so that check still has to be done.

## Summary

Both Phase 3 blockers are fixed.

**N8.** `schemaProblem` now does one walk that knows where each value sits in the schema. A `$ref` has to resolve to a subschema object. A pointer that passes through `enum`, `const`, `default`, `examples` or any other data, or that stops on a name map, a list or a scalar, is refused. The target of every `$ref` is walked like the rest of the schema. My old bypass is refused, and so are 22 new variants I tried. Reverting the fix makes both N8 tests fail.

**N9.** The timeout clock now starts at the worker's `started` message. A crashed worker, a slow start or a full queue gives `CheckUnavailable`, which becomes a 503 with no verdict signed, logged or recorded. Checks are single-flight per job and deliverable, and their results are remembered (at most 1024). A job can have at most 8 checks. Both SDKs retry a 503 a bounded number of times with backoff. Reverting the fix makes the 503, single-flight, queue-full and max-checks tests fail.

N12 to N17 are fixed. LICENSE, NOTICE, a real `SECURITY.md` contact and the owner signature line are all present.

What's new:
- **N19 (low):** a gap in how `$id` is handled.
- **N20 (low):** one N9 test doesn't fail when its fix is reverted.
- **N21 (low/medium):** the SDK's retry budget is shorter than the worst case a single attacker can hold the checker.
- **N22 (info):** the Windows run was on the pre-commit working tree plus a patch.
- **N23 (nits):** stale documentation.

None of these blocks the public release. N24 does need to be closed first. The zip could not be opened on the review box, so I could not confirm HEAD, a clean tree, or the author of `8dab15e`. I reviewed a tree rebuilt from the diff instead (details below).

## Integrity

| Check | Result |
|---|---|
| HEAD = `8dab15e`, clean `git status` | **Not verified** (N24) |
| Tree matches `phase3-fixes.diff` | **Not verified** (N24) |
| `8dab15e` only adds the signature line, authored by Christopher Terrell <outcastgnu@gmail.com> | **Not verified** (N24). In the diff, the signature change is `edr/ACCEPTANCES.md` lines 703–708 |
| The diff itself | Read in full (4943 lines). The code and test changes it contains are the ones listed in `FINDINGS_RESPONSE.md` "Phase 3 review" |

How I reviewed instead: I took my Phase 3 tree, which is `a0f6e1b` plus the uncommitted Phase 3 work that matched `phase3.diff` byte for byte, and applied every source and test change from `phase3-fixes.diff`. The TypeScript files were `schema-policy.ts`, `json-schema.ts`, `json-schema-worker.ts`, `checks/index.ts`, `oracle/server.ts`, `registry/server.ts`, `sdk/index.ts`, `auth.ts`, `oracle.test.ts` and `registry.test.ts`. The Python files were `auth.py`, `kit.py`, `escrow.py`, `test_parity.py`, `test_kit_local.py` and `test_retry.py`. The counts I got match the brief's exactly, which is good evidence that the rebuild is faithful. It does not replace checking the zip.

## Reproduced (Linux, Node 22.22.0, npm 11, Python 3 venv)

| Step | Expected | Result |
|---|---|---|
| `npx npm@11 ci` | no script warnings | OK, 0 vulnerabilities. Plain npm 10 runs the `better-sqlite3` gyp build and fails, which is expected because npm 10 ignores `allowScripts` |
| `npm run typecheck` | 0 | **0 errors** |
| `npm run test:unit` | 61/61 | **61/61** |
| `vitest run test/oracle.test.ts` ×3 | 27/27 | **27/27, 27/27, 27/27**. No flakes |
| `python -m pytest` | 25 + 1 skipped | **25 passed, 1 skipped** |
| `make-sdk-vectors.ts` regenerated | unchanged | byte-identical. The verdict signature `3C4CD669…` matches the diff |
| Testnet (`npm test` 65/65, `pytest --testnet` 26, demo 12/12) | — | **Not run.** I relied on the logs (see N22) |

## Mutation (revert) checks

| Fix reverted | Tests that fail |
|---|---|
| `schema-policy.ts` → `a0f6e1b` | 2 tests: oracle "refuses a $ref into enum, const…" and registry "refuses job schemas that could make validation slow" |
| `json-schema.ts` + worker → `a0f6e1b` | 3 tests: queue-full/crash, 503-retry, single-flight. **"does not count a fresh worker's start-up" still passes** (N20) |
| `oracle/server.ts` → `a0f6e1b` | 2 tests: 503-retry, single-flight |
| `registry/server.ts` → `a0f6e1b` | 1 test: "limits how many checks" |
| Python retry, `claim` check, `canonical_json` | Read; the new tests cover them. Not mutated |

## N8 probes (on the rebuilt `schemaProblem`)

| Case | Result |
|---|---|
| Old bypass `#/$defs/x/enum/0` with `^(a+)+$` | refused: "not a subschema" |
| `~1` (`a~1b`), `~0`, `%24defs`/`%65num`, `%2F` inside a token | all refused |
| Into `default` under `properties`; `dependentSchemas/a/const`; `dependencies/a` (array) | refused |
| `items: [R]` (array form) | refused (pattern found) |
| Chain `$defs/a → $defs/b/examples/0` | refused |
| Pointing at another `$ref` string (`#/$defs/a/$ref`) | refused |
| `$anchor` (`#foo`); a `$id` inside `enum` with a URL ref | refused (non-pointer, non-local) |
| `not/const`, `if/enum/0`, `contains/const`, `additionalProperties/enum/0`, `title` | refused |
| Leading-zero index `anyOf/00` | refused |
| Property *named* `enum` (`#/properties/enum`), `prefixItems/0`, plain `$defs` chains | allowed. Correct, these are subschemas |
| `$id` rebasing (N19) | **allowed** by the policy. Ajv resolves it differently |

## N9 review

- **Timeout scope.** Correct. The startup timer (30 s) is replaced by the job timer only when `started` arrives (`json-schema.ts` in the diff around 3941–3976). Time in the queue is never timed, because `run()` starts only when the request reaches the head of the queue.
- **503 path.** Correct. `CheckUnavailable` is caught before signing (`oracle/server.ts`, diff around 4071–4077), so nothing is written to the log and no event is posted. The test confirms the log line count and the `delivered` status.
- **Single-flight and cache.** Keyed `jobId|sha256(deliverable)`. The registry accepts a deliverable only while the job is `funded`, so a deliverable can't change after it is posted, and there is no stale result or cache poisoning. The cache is FIFO-bounded at 1024. `running` is cleared in `finally`. A run that ends in 503 is not remembered.
- **SDK retry.** Bounded in both SDKs: 4 attempts, sleeps of 1 s, 2 s and 3 s, a fresh signature each time, and only on 503. There is no infinite loop. `test_retry.py` covers the Python side.
- **Global queue.** `MAX_WAITING = 8` and the single worker are shared by all providers. See N21.

## Prior findings

| # | Status | Evidence | Blocks public release? |
|---|---|---|---|
| N8 | fixed | `src/schema-policy.ts` `resolveSchemaPointer` / `walk` (diff 4158–4323); probes above; revert fails 2 tests | No |
| N9 | fixed (stated scope) | `json-schema.ts`, `oracle/server.ts`, `registry/server.ts` `MAX_CHECKS = 8`, SDK retries; revert fails 6 tests in total | No (N21 is residual) |
| N12 | fixed | `docs/THREAT_MODEL.md` states the exact keyword list, the `$ref`-to-subschema rule, the N8 history and an availability row. Small overstatements are in N19 and N21 | No |
| N13 | fixed | Refuses `0.5`, `1e-7`, `1.0`, `-0.0`, `inf`, `nan`, ±2^53, `10**20`, lone surrogates and non-string keys. Byte parity with TS `canonicalJson` on 5 edge-case objects (C0 controls, DEL, U+2028/2029, quotes, backslash, BOM, NBSP, `é ✓`, safe-range ints, booleans, null) | No |
| N14 | fixed | Sorted by the UTF-16-BE bytes of each key, which is code-unit order. Agrees with TS on `{"\uE000","😀","\uFFFF","","Z","a","é"}` and on U+10000/U+10FFFF keys | No |
| N15 | fixed | `kit.py` `claim()` checks with `condition_of_fulfillment` before any ledger call, and the docstring says the verdict is not checked. Test passes | No |
| N16 | fixed (code read) | `escrow.py` raises on a preliminary `tem`/`tef`/`tel` result; `ter` and `tes` keep polling the validated ledger. Exercised only on testnet | No |
| N17 | fixed | `QUICKSTART.md` step 2 uses the release zip and `npm ci` and gives the macOS/Linux spellings. Read only; I didn't drive it by hand (Windows log: first job paid) | No |
| N5 | signature present | `edr/ACCEPTANCES.md`: `Signed: "I Christopher Terrell give my acceptance on 10/21/2026 15:45 UTC5"`. Authorship unverified (N24) | No, once N24 is checked |
| N10 | done, see N22 | Windows logs consistent | No |
| N11 | settled per the brief | Approval at 21:35 UTC (4:35 PM CDT). Author unverified (N24) | No |
| LICENSE / NOTICE / SECURITY | done | Apache-2.0 at the root, in `xrpl-escrow/` and in `xrpl-escrow-py/`. `NOTICE` reads © 2026 Christopher Terrell. `pyproject` says `license = "Apache-2.0"`, as do `package.json` and the lockfile. `SECURITY.md` gives the contact outcastgnu@gmail.com and a 7-day reply | No |
| Replay test change | no weakening | `signRequest(..., timestamp = Date.now())` only lets the *signer* choose its own timestamp. The server still enforces ±120 s skew and the replay key over `publicKey|message` (message includes timestamp), persisted. Python `sign_request(timestamp=None)` matches. The test now signs 5 distinct requests, which is the correct model | No |
| N1–N4, N6, N7, N18 | no regression seen | — | — |

## New findings

| # | Severity | Finding | Evidence | Blocks public release? |
|---|---|---|---|---|
| N19 | Low | **`$id` re-bases refs in Ajv but not in the policy.** `resolveSchemaPointer` always resolves `#/…` against the root document, but Ajv resolves it against the nearest `$id`. I built a schema with trivial root `$defs.s0..sN` and, under `properties.v`, a subschema with `$id: "http://example.com/inner"`, its own anyOf-doubling `$defs` chain, and `$ref: "#/$defs/sN"`. The policy **accepts** it (1.5–2.1 KB, N = 16–22), because the expansion and recursion checks see only the trivial root targets. Ajv then sees a different graph and failed with "Maximum call stack size exceeded" in about 65 ms, which is caught as a fail on the attacker's own job. I found no way to get `pattern` past the policy this way, because every schema position as written is still walked. Still, the policy's model of Ajv is no longer exact, and the 2 s worker timeout is the only backstop | `src/schema-policy.ts` `resolveSchemaPointer` (diff 4199–4228); `BANNED_KEYWORDS` (diff 4156) | No. Fix before any hosted verifier: add `$id`, `$anchor`, `$dynamicRef`, `$dynamicAnchor`, `$recursiveRef` and a nested `$schema` to `BANNED_KEYWORDS`, with a test |
| N20 | Low (test) | **One N9 test doesn't fail on revert.** With `json-schema.ts` and the worker reverted to `a0f6e1b`, "does not count a fresh worker's start-up against the job" still passes. The old worker ignores `startDelayMs`, and a real cold start here takes under 1 s, so the 1000 ms assertion holds anyway. `FINDINGS_RESPONSE.md` says "All four oracle tests fail on the old code"; on Linux it is three | `test/oracle.test.ts` (diff 4438–4446); `FINDINGS_RESPONSE.md` N9 row | No. Make the test assert something only the new code does: for example, a start delay longer than the timeout must still pass, and the test must check that the delay hook actually ran |
| N21 | Low/Medium | **The SDK gives up before a single attacker job finishes.** The queue (8) and the worker are global, not per provider. One job can hold the worker for up to 8 checks × 2 s = 16 s, plus a cold start after each timeout kill. The SDK retry budget is about 6 s (4 attempts, sleeping 1 + 2 + 3 s). An attacker with 8 or more funded jobs verifying at the same time can make an honest `deliver()` raise a 503 to its caller. Funds stay safe and no fail verdict is signed, but the threat model's "Honest jobs are then delayed, not failed … the SDKs retry" overstates what the SDK does. The caller has to keep retrying until `CancelAfter` | `json-schema.ts` `MAX_WAITING` (diff 3895); `sdk/index.ts` (diff 4350–4357); `kit.py` `request_verification`; `docs/THREAT_MODEL.md` availability row (diff 556) | No (availability, documented). Say in the threat model and the SDK docs that the SDK stops after about 6 s and the caller should retry before the deadline, or lengthen the retry window with jitter. Per-provider fairness belongs with hosting |
| N22 | Info | **Windows evidence is from the pre-commit tree.** `logs/2026-10-21-phase3-windows.txt` says the run was "a0f6e1b + Phase 3 working tree (uncommitted)", then with `phase3-windows-n9-fix.patch` applied ("20 files changed"). It was not run on `7b2d357` or `8dab15e`. The logs agree with each other and with the brief: Node 24.18.0, npm 11.16.0, Python 3.14.6. Before the fix, unit was 60/61 and `npm test` 64/65 (the same-millisecond replay test bug). After it, `oracle.test.ts` was 27/27 three times, unit 61/61, `npm test` 65/65, pytest 25+1, `--testnet` 26/26, the first TS job paid, and the Python demo 12/12. The watcher log matches the explorer hashes in the demo logs. No `.env` values appear in the logs | `xrpl-escrow/logs/2026-10-21-phase3-windows*.txt` | No. Christopher or Claude should confirm with `git diff 7b2d357` against the tested tree that the patch is exactly what was committed |
| N23 | Nit | Stale docs: `QUICKSTART.md` "Stuck?" says the faucet "only funds wallets below 30 XRP" (it is now 60). `docs/trial/TRIAL_SCRIPT.md` step 1 still says `npm install` while the quickstart says `npm ci`. `FINDINGS_RESPONSE.md` still lists N11 as "open" and N5 as "needs his approval", which the brief says are settled. The signature line's "15:45 UTC5" (20:45 UTC) is two minutes before the 20:47 UTC the note attributes it to; that's harmless, but "UTC-5" would be clearer | `QUICKSTART.md` (diff 430); `TRIAL_SCRIPT.md` (diff 645); `FINDINGS_RESPONSE.md` (diff 2884–2886); `ACCEPTANCES.md` (diff 704) | No |
| N24 | Process | **Integrity not verified.** The zip `ai-settlement-phase3-rereview.zip` could not be opened on the review box: the attachment store isn't reachable from the shell, and the file reader doesn't open binary zips. So HEAD = `8dab15e`, a clean tree, tree = diff, and the author and signature-only scope of `8dab15e` are all unchecked. The review above is of a tree rebuilt from the diff | — | **Yes, until checked.** Either share the zip in a form the box can read, or Christopher runs `git rev-parse HEAD`, `git status --porcelain`, `git show --stat --format='%an <%ae>' 8dab15e` and `git diff a0f6e1b 8dab15e \| diff - phase3-fixes.diff` and pastes the output |

## Required for an unconditional PASS

1. Close N24, the integrity check above.
2. Recommended, not blocking: ban `$id`/`$anchor`/`$dynamic*` (N19), make the start-up test fail on revert (N20), and correct the retry wording in the threat model and the SDK docs (N21).
