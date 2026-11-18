# Verdict: N37 fix after v0.4.0 (EDR-014, EDR-015 N34)

**Reviewer:** Gpno (sole final reviewer named in EDR-014)
**For:** Christopher Terrell
**Date:** 2026-11-17, 11:29 PM CST (2026-11-18 05:29 UTC)
**Verdict:** PASS

This review is of the uncommitted tree produced by applying `n37-since-abd8b52.diff` to `abd8b52`. No branch was created. Nothing was committed. No file in the repository checkout was modified.

N37 is closed. The r4 later-entry repro now refuses startup and does not anchor. A second entry with an unknown `verdictHash` is refused too. `verifyVerdictLog()` without a verdict returns `ok: false` on that log. Refusing every second entry for a job does not brick a log the oracle itself can write. No new finding.

## Inputs

| Item | Value |
|---|---|
| Base | `abd8b5248df1a8edeada79b38b72fe09c2ee1bd1`, tree `5c28b91fccd32c72b19ec115cad4b52e2cc74ddd`. Commit time 2026-11-15 1:55 AM CST (07:55 UTC). This is the commit `v0.4.0` points at. |
| Current main | `90baa82076f55d96650661953500739c43dbb458`. Against `abd8b52` it changes only `edr/ACCEPTANCES.md` and `edr/EDR-015_ESCROW_PHASE5_SHARED_VERIFIERS.md`. |
| Full diff | SHA-256 `57a0ad399bd7c8cb10e6b5c6b79c17df6a47497d1da8e1a5f890398a71fcdf4e`, 23 files. |
| Code diff | SHA-256 `595d7d62310eba54b954ce61f22ec568f927f82d4eb0aed9fa83a42679580102`, 13 files. Every code-diff path is in the full diff, and each of those file patches is byte-identical. The ten files only in the full diff are nine logs and `xrpl-escrow/test/vectors/verdict-log.json`. |
| Prior r4 verdict | SHA-256 `a79b57e2e4453f653faf0af4fd34fd9aae4489a6eacec8f02a835e56cbcc3cd6`. Matches the brief's `a79b57e2…3cd6`. |
| Apply to `abd8b52` | `git apply --check` and `git apply` both exited 0. Git reported three "new blank line at EOF" whitespace warnings (diff lines 1024, 1043, and 1058). They did not reject the patch. |
| Apply to `90baa82` | `git apply --check` exited 0. No path in the N37 diff is a path `90baa82` changes. |
| Resulting tree | `373baa5e879722159be2ebce30512ce2c58df7b4`, from `git add -A` and `git write-tree` in a scratch repo at `/tmp/n37-tree`. **Matches the claimed hash.** `git rev-parse HEAD` failed. There is no commit. The same hash was returned after the tests and after the revert checks, once the three source files were restored. |

## What was run, and what was only claimed

Node v22.23.4, npm 10.9.9, Python 3.12.3, pytest 9.2.0. Services bound to `127.0.0.1`. No testnet transaction was submitted. No seed, fulfillment, or preimage was printed.

| Step | Result | Status |
|---|---|---|
| `npx tsc --noEmit` | 0 errors | Reproduced |
| `npm run test:unit` | **114/114** | Reproduced |
| `python -m pytest` (no `--testnet`) | **39 passed, 1 skipped** | Reproduced |
| N37 repro and the three revert checks | see below | Reproduced |
| `npm test` 119/119, first run 118/119, `demo:phase4` 28/28, `pytest --testnet` 40, Python demo 16/16 | The logs in the diff say this. `2026-11-15-n37-npm-test-run1.txt` does contain `readyState 0` and `1 failed \| 118 passed (119)` in `test/phase2-flow.test.ts`. The rerun log says 119 passed. The demo log says 28/28. The Python logs say 39+1, 40, and 16/16. | **Claimed only.** Not run here. Those commands submit testnet transactions, and no finding needed one |
| Windows on this tree | — | **Not run.** Not in the diff |

Reverting each piece, in the throwaway tree only, makes the new test fail. The files were restored afterward and the tree hash was unchanged.

- Removing the second-entry throw: `test/finality.test.ts` "later entry" fails because `launchOracle()` resolves.
- Restoring first-match `findVerdict`: the verdict-log test fails because `mismatch` is null.
- Removing `duplicateJobProblems` from `verifyVerdictLog`: that test fails because `ok` is true.
- Restoring first-match `find_verdict`: `test_a_later_entry_for_a_job_is_caught` fails because the "entry 2 names this verdict" problem is absent. `ok` stays false from the duplicate check, which was left in place.

## N37

**Status:** Closed
**Blocks 0.4.0 release:** No. v0.4.0 is already tagged. This fix does not block the next merge.

**Where:** `xrpl-escrow/src/oracle/verdict-store.ts` 72–87. Any later verdict entry for a `jobId` already in the map throws before the oracle listens or anchors. An entry whose `verdictHash` is in the signed file is still compared with `entryMismatch`. `xrpl-escrow/src/verdict-log.ts` 210–219 and `xrpl-escrow-py/src/xrpl_escrow/verdict_log.py` 147–156 walk every entry that names the hash and return the first mismatch. `duplicateJobProblems` is `verdict-log.ts` 227–238. `duplicate_job_problems` is `verdict_log.py` 159–166. Both SDKs call it from `verifyVerdictLog` / `verify_verdict_log` whether or not a verdict was passed (`sdk/index.ts` 172, `verdict_log.py` 304).

**Repro** (`n37-repro/bypass-output.txt`):

1. A real pass is served. The oracle is stopped. A second signed, chained entry for that job says fail and keeps the pass's `verdictHash`. `entryMismatch` is `"verdict"`. Restart throws `second verdict for job` and `refusing to start`. The anchor list does not grow.
2. The same shape with `verdictHash` set to 64 `ab` bytes, which is not in the signed file, also throws `second verdict for job`. No new anchor.
3. The duplicate inserted between the pass and a later other job, with the tail re-signed so the sequence numbers still run 0,1,2,3, also refuses.
4. Appending that second entry to the file while the process is up does not change the served verdict. `anchorNow()` does not publish the edited hash. The next start refuses.
5. On a copy of the log plus that second entry, `verifyVerdictLog()` with no verdict returns `ok: false` and the problem `job … has 2 verdict entries (1, 2)`. With the pass, it is also `ok: false`, and the problems include `entry 2 names this verdict but its verdict differs`. `findVerdict` returns that mismatch whether the lying line is visited first or after the honest line.

**Parity.** Existing vector objects are unchanged. Top-level keys added are `laterEntryLog` and `duplicateCases`. `findCases` grew from 4 cases to 5. The new name is "a later entry for the job names the pass but says fail (Gpno N37)". No previous `findCases` object changed. Python `duplicate_job_problems` matches both `duplicateCases` expected arrays. Python `find_verdict` on that new case returns no entry and the same "entry 2 names this verdict but its verdict differs" string. `verify_verdict_log` on `laterEntryLog` with no verdict returns `ok: false` and the two-entry problem.

**Lookalike ids.** `duplicateJobProblems` compares the `jobId` string exactly. A leading space, an uppercased id, and an id with an added combining mark are not reported as duplicates (`caseSpaceUnicodeAreDuplicates: [false, false, false, true]`; the true is `normalize("NFD")` of an ASCII id, which is the same string). Startup still refuses a second line that keeps the signed verdict's hash and only changes the id's case or adds a space: the error is the field mismatch, and nothing is anchored (`case-variant.txt`). A second line whose id differs only by case and whose `verdictHash` is unknown does start. That is a different `jobId`, signed by the operator, not two entries for one id. It does not recreate N37.

**Does "any second entry" brick a real log?** No path in this tree writes two verdict entries for one job. `append` throws if the job is already in `#byJob` or `#pending` (`verdict-store.ts` 141–142). The crash repair keeps one pending verdict per `jobId` and skips a job the public log already has (lines 97–100). A retry of a failed public write logs that same pending verdict once (N33). A 0.3.x `verified_pass` or `verified_fail` with nothing in the log is 409 and writes nothing (N36). I did not have the cloud oracle's 9-entry log in this tree, so I did not recount it. The honest log loaded by the unit test has no duplicate (`duplicateJobProblems` empty in that test, which passed).

## Other findings

| Finding | Status | Blocks this merge |
|---|---|---|
| N25 first verdict final | Closed. The 1024 test is in the 114. | No |
| N26 public fields must match | Closed. Startup still compares a signed copy on every entry it accepts, and the unit test for the lying summary passed. | No |
| N27 null anchor entry | Closed. Covered by the passing vector tests. | No |
| N28 odd-length memo hex | Closed. Covered by the passing vector tests. | No |
| N29 one account, every anchor in the window | Closed. The second-genesis unit test is in the 114. | No |
| N30 `ok` means pinned | Closed. The tail test is in the 114. | No |
| N31 Windows evidence | The `b5f36bf` log remains the one in the tree. There is no Windows log for this N37 tree. Same split as r4: it does not fail this verdict. It blocks the merge until the commit of this tree has its own log in `logs/`. | Merge only |
| N32 incomplete lookback fails closed | Closed. The 114 includes the fail-closed lookback test. | No |
| N33 sticky verdict when the public write throws | Closed. The directory test is in the 114. | No |
| N34 unmerged until this pass | Satisfied so far. This tree is uncommitted and unmerged. | No |
| N35 do not tag `b5f36bf`, `b8872321`, or `6cf7d44` | Closed. `v0.4.0` points at `abd8b52`, not those three. | No |
| N36 0.3.x `verified_pass` is 409 | Closed. The test is in the 114. | No |
| N37 | Closed, above. | No |

No N38.

Chain linkage, privacy of log lines, `delivered_amount`, a malformed hash, a 503 with no verdict, and `127.0.0.1` were not re-broken by this diff. The files that implement them are unchanged except `sdk/index.ts` and `verdict_log.py`, which only add the duplicate-job problem. The unit file and the Python suite that cover those holds passed.

## Docs

They match the code. `CHANGELOG.md` has an Unreleased section for N37, and 0.4.0 is dated 2026-11-15. The README says a job has one entry and two entries for the same job fail the check. The threat model says every entry is compared, not only the first, and that a second entry makes startup and the SDK check fail even for a reader without the verdict. `FINDINGS_RESPONSE.md` has "After 0.4.0: N37" and names the tests that fail when the fix is reverted. Those tests do fail, as run above.

The new logs do not contain a seed, a fulfillment string, or a preimage. The word "fulfillment" appears only in sentences such as "fulfillment released to the provider" and "no fulfillment, signed fail verdict", plus a public transaction hash on the EscrowFinish line.

## Before merge

1. Commit exactly this tree to a branch. `git diff abd8b52 <commit>` must be this 23-file diff, and `git rev-parse <commit>^{tree}` must be `373baa5e879722159be2ebce30512ce2c58df7b4`.
2. Run the Windows commands for this commit and put that log in `logs/`. That is the merge gate, not a reason to reject the fix.
3. Do not merge before that commit is the one this verdict passed. EDR-015's N34 rule is met by leaving it unmerged until this pass. This verdict is that pass for the code. The Windows log is the remaining condition on the merge.

## Limitations

- The review tree was `/tmp/n37-tree`. The scratch `git init` was not committed.
- Testnet `npm test`, the demos, and `pytest --testnet` were not run.
- The case-variant run that was allowed to start left a local process up until it was killed. It did not anchor (`newAnchors: 0`) and it was not a testnet transaction.
- The cloud oracle's 9-entry log was not in this tree.

## Artifacts

- `/opt/cursor/artifacts/VERDICT.md` (this file)
- `/opt/cursor/artifacts/n37-repro/bypass.ts`, `bypass-output.txt`
- `/opt/cursor/artifacts/n37-repro/case-variant.ts`, `case-variant.txt`
- `/opt/cursor/artifacts/n37-repro/test-unit.txt`, `pytest.txt`
- `/opt/cursor/artifacts/n37-repro/revert-startup.txt`, `revert-find.txt`, `revert-duplicate.txt`, `revert-python.txt`
