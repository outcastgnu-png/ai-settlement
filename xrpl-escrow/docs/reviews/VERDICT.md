# Verdict: ESCROW-001 Phase 3 review (EDR-013 developer preview)

**Reviewer:** Gpno (sole final reviewer under EDR-013, accepted 2026-10-21 16:45 UTC)
**Date:** 2026-10-21
**Tree reviewed:** `a0f6e1b` (main) plus uncommitted Phase 3 work. `git rev-parse HEAD` = a0f6e1b169f9; `git status` shows 23 paths (10 modified, 13 new)
**Verdict:** FAIL (not ready for public release)

The previous verdict (`a0f6e1b`, the third review) is to be archived as `VERDICT-2026-10-21-a0f6e1b.md`.

## Summary

The Phase 3 work itself is mostly sound. The reputation fix is correct and its test catches a revert. The Python SDK passes its tests, and its signatures match the TypeScript kit for every input a verdict actually carries. The verdict-key pinning, the testnet check and the validated-ledger handling all hold. **But neither blocker from the third review is fixed.** Since `a0f6e1b`, the only changed source files are `src/registry/db.ts` and `src/wallets.ts`. `src/schema-policy.ts`, `src/oracle/checks/json-schema.ts` and `json-schema-worker.ts` are byte-identical. I reproduced N8 again in this tree. The third verdict said N8 and N9 must be fixed before anything leaves localhost. A public developer preview is exactly that, so the verdict is FAIL. The threat model also says "no regex keywords" are allowed, which N8 shows is untrue (N12). If N8 and N9 are fixed and N12 is corrected, I expect PASS WITH FINDINGS on re-review.

## Diff integrity

`git add -N . && git diff a0f6e1b` gives 45 files. After stripping `index` lines it is identical to `phase3.diff`. The tree matches the diff.

## Reproduced

| Step | Result |
|---|---|
| `npx npm@11 ci` (Node 22.22.0, Linux) | 83 packages, no install-script warnings, 0 vulnerabilities. `better-sqlite3` loads from its bundled `prebuilds/` |
| `npm run typecheck` | 0 errors |
| `npm run test:unit` | **55/55** (5 files) |
| Reputation mutation: `db.ts` reverted to a0f6e1b | 1 failed / 11 passed (`still counts a job as expired_unclaimed after it is refunded`); restored |
| Python 3.13.5 venv, `pip install -e .[test]`, `python -m pytest` | **20 passed, 1 skipped** |
| Testnet: `npm test` 59/59, `pytest --testnet`, demo 12/12 | **Not reproduced.** I rely on the implementer's logs (Linux). Windows was not run for Phase 3 |

## Prior findings

| # | Status | Evidence | Blocks public release? |
|---|---|---|---|
| N8 `$ref` into data keywords bypasses the policy | **not fixed** | `src/schema-policy.ts:23` still skips `DATA_VALUES` (enum/const/default/examples) when walking, but `expand` (lines 91–109) follows `$ref` into them. Reproduced: `schemaProblem({"$defs":{"x":{"enum":[{"type":"string","pattern":"^(a+)+$"}]}},"properties":{"v":{"$ref":"#/$defs/x/enum/0"}}})` returns `null` (accepted) | **Yes** |
| N9 single-worker head-of-line blocking | **not fixed** | `src/oracle/checks/json-schema.ts` has not changed since a0f6e1b: there is still one worker, a 2 s kill, serial validation, and no rate limit on a provider re-requesting `/verify` | **Yes** |
| N5 blank owner signature | open | `edr/ACCEPTANCES.md:26`: `Signed: ____ (Christopher Terrell), date: ____`. The EDR-013 row (line 7) records the acceptance with a quote, but the owner signature is still unsigned across EDR-011, 012 and 013 | Yes (governance). Christopher must sign it in a commit |
| N10 Windows run stale | open, carries over | The brief says Windows has not been run for Phase 3. The last Windows run was at e54e6d8 | Yes. The quickstart is written for Windows |
| N11 placeholder git identity | open | `git log -1 --format=%ae` = `noreply@anthropic.com` | No, but fix it before the public repo |
| N1–N4, N6, N7 | no regression seen | — | — |

## New findings

| # | Severity | Finding | Evidence | Blocks public release? |
|---|---|---|---|---|
| N12 | Medium | The threat model claims a protection that does not hold: "JSON Schemas are limited (no regex keywords …)". N8 smuggles `pattern` through. The only thing left is the 2 s worker kill, and N9 makes that a denial-of-service lever. Neither limitation is listed | `docs/THREAT_MODEL.md:35-38` | Yes (fix the code or state the gap) |
| N13 | Low | Python `canonical_json` differs from JS `JSON.stringify` outside the documented types: `1e-7` becomes `1e-07` (JS: `1e-7`); integers above 2^53 stay exact (JS rounds, so 2^53+1 becomes …992); `NaN` becomes `NaN` (JS: `null`); a lone surrogate raises an error (JS escapes it as `\ud800`). These all agree: non-ASCII, U+2028, control characters, `0.1`, `1.5e300`, `1e21`. Verdicts only carry ints and strings, and a mismatch makes verification fail closed, so there is no forgery. Either reject floats, NaN and out-of-range ints, or match JS | `xrpl-escrow-py/src/xrpl_escrow/auth.py:46-73` | No |
| N14 | Low | Key sort order may differ for keys outside the BMP: Python sorts by code point, JS by UTF-16 code unit. Fails closed. Not exercised by the vectors | `auth.py:63` | No |
| N15 | Low | `DeliverResult.verdict_signature_valid` is only advisory. `claim()` does not check it before submitting EscrowFinish. The ledger condition protects the funds, but SDK users may assume a check that is not there. Document it or enforce it | `kit.py:~139-148` | No |
| N16 | Low | `submit_validated` ignores the preliminary engine result. A `tem`/`tef` rejection is polled until `LastLedgerSequence` passes, then reported as "expired", which hides the real error. It still never reports success wrongly, and `tec` codes are returned from the validated meta correctly | `escrow.py:32-50` | No |
| N17 | Low | Quickstart: `git clone <repo URL>` is a placeholder; it uses `npm install` (not `npm ci`) and Windows-only `\` paths. The offline parts work on Linux with `/` paths | `QUICKSTART.md:20-23,55-59` | Yes (needs the real URL) |
| N18 | Info | `services.py` starts Node services with `subprocess.Popen` (fixed argv, no shell, stdin DEVNULL). Nothing runs deliverable content: there is no `exec`, `eval` or shell in the SDK. I found no seed or secret printed in `env.py`, `demo.py` or `services.py` | — | No |

## Checks that held

- Verdict pinning: `verify_verdict` requires `verdict.oracle == pinned` **and** that the public key derives to that address. A `None` pin fails. The pin comes only from the env file or the constructor, never from the oracle (`auth.py:86-91`, `kit.py:65-71`).
- Testnet only: `assert_testnet` aborts if `network_id != 1` or the id is missing (`config.py:24-33`).
- Hex-case replay: `replay_key` upper-cases the public key over the exact message (`auth.py:41-43`), matching N2's TS fix. `test_kit_local.py` passes. I did not run a replay across an oracle restart from Python; TS behaviour was verified in review 3.
- The reputation fix counts jobs from the event log, and the mutation test fails when it is reverted.
- `allowScripts` gives a quiet npm 11 install, and the kit works without the scripts.

## Release blockers outside the code

- No `LICENSE` file.
- `SECURITY.md:13` contact is "[contact to be added before the public release]".
- The tree is uncommitted. The commit needs Christopher's approval.
- Windows has not been run for Phase 3 (N10).
- The owner signature is blank (N5).
- The testnet results have not been reproduced independently.

## Required for PASS

Fix N8: walk or refuse `$ref` targets inside data keywords, with a test that fails when the fix is reverted. Fix N9: per-provider verify rate or concurrency limits, or a worker pool with a queue budget, with a test. Correct the threat model (N12). Then re-run the Windows tests (N10).
