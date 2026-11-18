# Verdict: ESCROW-001 Phase 4 re-review, round r4 (EDR-014)

**Reviewer:** Gpno (sole final reviewer named in EDR-014)
**For:** Christopher Terrell
**Date:** 2026-11-15, 1:17 AM CST (2026-11-15 07:17 UTC)
**Verdict:** PASS WITH FINDINGS

This review is of the uncommitted tree produced by applying the attached 44-file diff to `6cf7d44`. No branch was created. Nothing was committed. No file in the repository checkout was modified.

The previous blocking holes are closed for the attacks that failed the 2026-11-14 review. N26's original public-fail / private-pass pair now refuses startup and does not anchor. N32 fails closed when the lookback is incomplete, and the oracle does not anchor in that case. N33 keeps the signed fail when the public write throws. N36 returns 409 for a 0.3.x `verified_pass`. One narrower hole remains (N37): a later entry for a job that already has a matching entry is not compared, so a mismatched head can still be anchored. It does not block 0.4.0. N31 stays open and blocks only the tag.

## Inputs

| Item | Value |
|---|---|
| Base | `6cf7d4455919fbfac6cf19f0c3223f07d2323bbf` (current main). Same `xrpl-escrow/src` and `xrpl-escrow-py/src` as `b5f36bf` (`git diff` of those directories is empty). |
| Authoritative diff | `phase4-r4-since-6cf7d44.diff`, SHA-256 `2d2c0e48d1008d71c7cd296cc8b2dcbca6fadedf8fb58eab91d333de3de4488e`, 12,058 lines, 44 files. The other two diffs named in the brief were not in this environment and were not reviewed. |
| Apply | `git archive 6cf7d44` into `/tmp/phase4-r4`, then `git apply --check --whitespace=nowarn` and `git apply --whitespace=nowarn`. Both exited 0. No reject. |
| Resulting tree | `b7030cd12e6208b47c5d0c3ce457e45c21df6488`, from `git add -A` and `git write-tree` in a scratch repo under `/tmp/phase4-r4`. `git rev-parse HEAD` failed. There is no commit. A second `git write-tree` after `npm ci` returned the same hash; `node_modules` was not in the index. |
| Source vs `b5f36bf` | Under `xrpl-escrow/src` and `xrpl-escrow-py/src`, the only files that differ are the six this diff changes: `anchors.ts`, `oracle/server.ts`, `oracle/verdict-store.ts`, `sdk/index.ts`, `kit.py`, `verdict_log.py`. Because those directories are identical on `6cf7d44` and `b5f36bf`, that difference is exactly this diff. |
| Prior verdict in the tree | `xrpl-escrow/docs/reviews/VERDICT.md` SHA-256 `6e6135f219b069274c4a995df676c050aee5a4ffb0b05c8673478b62d433da9c`, matching the brief's `6e6135f2…da9c`. |
| Tags | Still no `v0.4.0`. |

## What was run, and what was only claimed

Run on the applied tree. Node v22.23.4, npm 10.9.9, Python 3.12.3, pytest 9.2.0. Services bound to `127.0.0.1`. No testnet transaction was submitted. No seed, fulfillment, or preimage was printed.

| Step | Result | Status |
|---|---|---|
| `npx tsc --noEmit` | 0 errors | Reproduced |
| `npm run test:unit` | 9 files, **112/112** | Reproduced. Matches the claim |
| `python -m pytest` (no `--testnet`) | **38 passed, 1 skipped** | Reproduced. Matches the claim |
| Reviewer bypass script | `phase4-r4-repro/bypass-output.json` | Reproduced |
| `npm test` 117/117, `demo:phase4` 28/28, `pytest --testnet` 39, Python demo 16/16 | — | **Claimed only**, in the 2026-11-15 logs inside the diff. Not run here |
| Windows on this tree | — | **Not run.** The log in the tree is the earlier `b5f36bf` run |

The record named `n32-401` inside `bypass-output.json` is a bad harness: the memo's oracle address was not the address passed to the kit, so both calls reported "no anchor". It is not evidence about the product. The 401-transaction behavior below comes from `listAnchors` in `n32-maxTx-values`, from `floodCases` in `test/vectors/verdict-log.json`, and from the unit test that passed in the 112.

## Checklist

| Claim | Result |
|---|---|
| N26 original pair refuses startup, does not anchor, and is not served | **Holds.** Startup throws, and the anchor callback count stays 0. A checks flip and an `issuedAt` shift also refuse. Editing either file while the process is up does not change the verdict the process serves or the head it will anchor; the next start then refuses. |
| N32 incomplete read | **Holds** for `verifyVerdictLog` / `verify_verdict_log` and for startup. A 400-transaction cap over a 401-row history returns `complete: false` and only the newest genesis. At 10,000, or at the default, both geneses are read. |
| N33 signed line sticks | **Holds** for a directory in place of the log and for mode `0444`. The lookup runs once. Later verifies return the same fail and no fulfillment, including after restart. |
| N36 `verified_pass` | **Holds.** HTTP 409, nothing logged. |
| N25, N27, N28, N29, N30, and the earlier holds | **Hold** on the checks below. |
| Threat model | The N32 sentence is now true, including the payment flood. The N26 sentence is true for the first entry of a job and too broad for a later entry (N37). |

## Findings

### N25 — A signed fail is not final

**Status:** Closed
**Blocks 0.4.0 release:** No

The 1024-eviction test is inside the 112. A separate restart, with the hash then made into a validated payment, kept the same fail and released nothing (`n25-restart`). A 0.3.x `verified_fail` is still 409.

### N26 — The public log can disagree with the verdict the oracle serves

**Status:** Closed
**Blocks 0.4.0 release:** No

**Where the fix is:** `xrpl-escrow/src/oracle/verdict-store.ts` 71–79, on the first entry for each job. `xrpl-escrow/src/oracle/server.ts` 199–201, before a stored verdict is served. `docs/THREAT_MODEL.md` 72.

**Repro** (`n26-startup-refuse`, `n26-other-fields`, `n26-edit-while-running`):

1. A real pass was served, with a fulfillment present. The oracle was stopped. The public entry was re-signed so it says fail and its check `pass` is false, while `verdictHash` still names the pass.
2. The next start throws `verdict differs` and `refusing to start`. The anchor list length does not change.
3. The same shape with only the check `pass` bit flipped, and with `issuedAt` increased by 5, also refuses.
4. While a consistent oracle is running, rewriting the public file does not change the served verdict (it stays the original pass) and `anchorNow()` does not publish the edited hash (`fileIsAnchored: false`). After that edit, restart refuses.

The 409 path is in `server.ts` 200–201. This repro never reached it, because startup already refused, which is the stronger gate. A later entry for the same job is a different case (N37).

The threat-model sentence that a reader who holds no verdict cannot tell whether an entry matches a verdict they have never seen matches the code: `verifyVerdictLog()` without a verdict still checks the chain, the signatures, and the anchors, not the hidden preimage of `verdictHash`.

### N27 — A null entry makes the verifier throw

**Status:** Closed
**Blocks 0.4.0 release:** No

`anchorProblem([null], …)` returned `entry 0 is missing or not an object` and did not throw. The Python test file that covers the same vector passed in the 38.

### N28 — Odd-length anchor memo hex

**Status:** Closed
**Blocks 0.4.0 release:** No

An extra nibble on `MemoType` and on `MemoData` both parse as null in this run. The shared vectors passed in pytest.

### N29 — One anchor account, every anchor in the window

**Status:** Closed
**Blocks 0.4.0 release:** No

Two seq-0 hashes still produce the "more than one log" problem (`n29-two-genesis`). The unit test that refuses startup on a visible second genesis is in the 112. The cap beyond the window is N32, not a return of the old fail-open.

### N30 — `ok` on an unanchored verdict

**Status:** Closed
**Blocks 0.4.0 release:** No

The unit test still expects `ok: false` and `verdictAnchored: false` unless `allowUnanchored` is set, and that test passed. The Python suite passed the same vector.

### N31 — Commit and Windows run

**Status:** Open
**Severity:** Process
**Blocks 0.4.0 release:** Yes, the tag only. It does not fail this verdict.

**Where:** `xrpl-escrow/logs/windows-2026-11-12-b5f36bf/`. This tree is not a commit.

**Evidence:** The 15 sections in the earlier attached Windows log are byte-identical to the same file names in that directory (`SUMMARY.md`, identity, npm ci, typecheck, unit, five finality runs, npm test, demo, pytest, pytest testnet, Python demo). The directory also contains `07a-pytest-install.txt`, `2026-11-12-phase4.txt`, and `2026-11-12-phase4-txs.json`, which that concatenation did not split out. `SUMMARY.md` still describes the `b5f36bf` run (tree `e1f8b8f9`), not this tree. A scan of those files found no seed, fulfillment, or preimage. `00-identity.txt` names `b5f36bf` and `e1f8b8f982d95f1e5e263b20084a69a7952e4b9d`.

**Impact:** There is still nothing to tag. A Windows run of `b5f36bf` is not a Windows run of this diff. EDR-014 still wants the log for the build that is tagged.

**Resolution:** After this tree is committed, run the Phase 4 Windows commands on that commit and put the log in `logs/`. N31 then closes. Until that commit exists, N31 blocks the tag and does not, by itself, reject these fixes.

### N32 — Lookback fails open, and the oracle can anchor a fork

**Status:** Closed
**Blocks 0.4.0 release:** No

**Where:** `xrpl-escrow/src/anchors.ts` 15 and 42–54 (default 10,000, page size 200, `complete: !marker`). `xrpl-escrow/src/sdk/index.ts` 175–178. `xrpl-escrow/src/oracle/server.ts` 271–280. `xrpl-escrow-py/src/xrpl_escrow/verdict_log.py` 214–240 and 294–296. `docs/THREAT_MODEL.md` 73.

**Repro:**

- Default constant is 10000. Over a 401-row history (matching genesis, 399 payments, then a second genesis), `listAnchors(..., 400)` returns one anchor and `complete: false` after 2 pages. `listAnchors(..., 10000)` returns both anchors and `complete: true` (`n32-maxTx-values`). `floodCases` in the vector file records the same shape: at 400, `complete: false` and `anchorSeqs: [0]`; at 1000, `complete: true`, two seq-0 hashes, and the two-genesis problem. The unit test expects `ok: false` and the lookback problem at `maxTx: 400`. It passed. Pytest's incomplete-lookback test passed.
- `startOracle` with `complete: false` throws `refusing to start` and the anchor callback is not called (`n32-startup-incomplete`, `anchorCalls: 0`).
- Python `verify_verdict_log(..., lookback_complete=False)` adds the max-tx problem and sets `ok` false.

**`ANCHOR_LOOKBACK_TX` is not rejected.** It is coerced.

| Value | TypeScript `Number(...)` | What `listAnchors` then does on a multi-page history | Python `int(...)` at import |
|---|---|---|---|
| `0`, `-5` | 0, -5 | One page, then stop. A remaining marker makes `complete` false, so startup and `ok` fail closed | 0, -5, same loop |
| `10.5`, `foo` | 10.5, NaN | Same as 0: one page, then fail closed if a marker remains | `ValueError`. The Python module does not import |
| `1e4` | 10000 | The normal cap | `ValueError` |
| `100000000000000` | that number | Reads until the marker ends, so it sees the second genesis and `complete` is true | accepted if it is an integer |

A value that stops early does not false-pass. A huge value reads more, which is the safe direction. There is no separate "this override is invalid" error.

**Payments past 10,000.** The threat model now says anyone can pay the anchor account and push old anchors out of the window, and that this makes the check fail, never pass. That matches the code. For this testnet preview the effect is that the oracle will not start, and `verifyVerdictLog()` returns `ok: false`, until the operator raises `ANCHOR_LOOKBACK_TX` or uses a new anchor wallet. That is an availability limit, not a forged pass. Severity for the preview: Low. It does not block the tag. It is disclosed honestly.

**Markers.** An unvalidated AccountSet is not an anchor (`n32-unvalidated-row`: 0 anchors). It still increments `seen`, so it consumes lookback. The code does not read a response-level `validated` flag. No marker means `complete: true`. A page that has a marker and no transactions does not increment `seen`; the loop keeps requesting. A mock that did that was aborted on the fourth call (`n32-empty-marker`). A normal rippled page is not empty. A server that lies was already outside what the log proves (`docs/THREAT_MODEL.md` 74). This hang is that residual, not a new fail-open.

`latestAnchor` / `latest_anchor` still default to 400 and drop the `complete` flag (`sdk/index.ts` 84–85, `verdict_log.py` 243–246). `verifyVerdictLog` does not use them. The check that sets `ok` is the one that fails closed.

### N33 — A failed public append lets the next verify sign a different verdict

**Status:** Closed
**Blocks 0.4.0 release:** No

**Where:** `xrpl-escrow/src/oracle/verdict-store.ts` 89–93 and 126–141. The signed line is stored in `#pending` before the public write. `issued()` retries that write and does not return null for a pending job.

**Repro** (`n33-directory`, `n33-eacces`):

- The public path was replaced with a directory. The first `/verify` returned 500. The signed file contained the job. A second `/verify`, after the stand-in lookup would have passed, also returned 500 while the directory was still there.
- With the log mode `0444`, the first verify returned 500 after one lookup. The next verify, with the file still unwritable and the payment now valid, returned 500 and did not call the lookup again (`lookupsWhileBlocked` stayed 1).
- After the file was restored, both cases returned `fail`, no fulfillment. Restart returned that same fail and no fulfillment.

### N34 — Merged before the re-review

**Status:** Accepted
**Blocks 0.4.0 release:** No

Christopher has left the merges in history, has not tagged `b5f36bf`, `b8872321`, or `6cf7d44`, and has kept this fix uncommitted until this verdict. That is the resolution from the previous review. This tree follows it.

### N35 — What had to happen before a tag of those commits

**Status:** Closed
**Blocks 0.4.0 release:** No

The requirement not to tag those three commits is accepted. The steps that remain before a 0.4.0 tag are the tag gate below. They are not a defect in this diff.

### N36 — A 0.3.x `verified_pass` is verified again

**Status:** Closed
**Blocks 0.4.0 release:** No

**Where:** `xrpl-escrow/src/oracle/server.ts` 204–206.

**Repro:** A job marked `verified_pass` with nothing in the log returned 409 and was not logged (`n36-verified-pass`).

### N37 — A later entry for the same job is not compared, and a mismatched head can be anchored

**Status:** New
**Severity:** Medium
**Blocks 0.4.0 release:** No

**Where:** `xrpl-escrow/src/oracle/verdict-store.ts` 71–75. The loop records every entry, then `continue`s when `#byJob` already has that `jobId`, before `entryMismatch`. `xrpl-escrow/src/verdict-log.ts` 209–214, and the same first-match loop in `xrpl-escrow-py/src/xrpl_escrow/verdict_log.py` 146–151. `findVerdict` stops at the first entry with that `verdictHash`. `docs/THREAT_MODEL.md` 72 says the oracle refuses to start, and so never anchors, when its private copy disagrees with the public entry.

**Repro** (`n26-later-entry`, no testnet write):

1. A job receives a real pass. The oracle is stopped.
2. A second entry is appended for that same job. It is signed by the verdict key, linked to the previous hash, says `fail`, and its `verdictHash` is the pass. `entryMismatch` on that pair is `"verdict"`.
3. Restart succeeds. `/verify` returns `pass` and a fulfillment, because the first entry is the one `issued()` returns.
4. `anchorNow()` publishes that second entry (`anchoredIsLie: true`).
5. `verifyVerdictLog()` with no verdict returns `ok: true` and no problems. The same call with the pass also returns `ok: true`, because the first entry with that hash is the honest pass.

**Impact:** The original one-entry lie is rejected. This needs a second line. The pass is still a public line in the same chain, so a reader of the whole file can see pass and then fail. What the new sentence overclaims is that the oracle will not anchor any disagreeing entry it can check. It does not check past the first entry for a job, and the SDK does not either. The fulfillment in this repro is the one the honest pass already released. It is not a fail that later becomes a pass.

**Resolution:** On startup, run `entryMismatch` for every verdict entry whose `verdictHash` is in the signed file, including later lines for a job already seen. Refuse to start if any of them disagree. `findVerdict` should not stop at the first match when a later line with the same hash disagrees. Add this two-entry log next to the existing public-fail vector.

## Earlier holds

These were checked again and are not new findings.

- Chain linkage: the live log checks, and the same log fails for a different verdict address (`chain`).
- Privacy: deliverable text `PRIVACY-TOKEN-deliverable-9f3c` and the check detail are absent from the public log (`privacy`).
- `delivered_amount`: a payment whose `Amount` is 5,000,000 drops and whose delivered amount is `"1"` fails. A deliverable with a `0x` prefix fails and does not call the lookup (`tx-predicate`).
- Thrown lookup: HTTP 503, job not logged, status left `delivered` (`503`).
- Bind: both listeners in `/proc/net/tcp` are `0100007F` (`bind`).

## Release gating

| Gate | State |
|---|---|
| N26 original pair, N32 incomplete read, N33, N36 | Closed on this tree. Reproduced. |
| N25, N27, N28, N29, N30 | Closed. Reproduced here or by the 112 / 38. |
| N37 later entry | Open. Does not block the tag. |
| N31 | Open. Blocks the tag. Does not fail this verdict. |
| N34, N35 | Accepted / closed as process items. Do not tag `b5f36bf`, `b8872321`, or `6cf7d44`. |
| Linux offline tests | Reproduced: typecheck 0, unit 112/112, pytest 38 passed and 1 skipped. |
| Linux testnet counts and Windows on this tree | Claimed or not done. Not required to accept the diff. Required before the tag. |

### Before the 0.4.0 tag

1. Commit this reviewed tree onto a branch. `git diff 6cf7d44 <hash>` must be this 44-file diff, tree `b7030cd12e6208b47c5d0c3ce457e45c21df6488` if nothing else is added. Do not merge it to main before that commit is the one you intend to tag, and do not tag the three commits named above.
2. Run the Phase 4 Windows commands from `xrpl-escrow/docs/reviews/REVIEW.md` on that commit. If `data/` is not already the log that anchor wallet published, use a new anchor wallet. Put the log in `logs/`.
3. The confirmation that remains is that the commit's diff against `6cf7d44` is this diff and that the Windows log is for that commit. N37 can ship as a known limit; it should be fixed or the threat-model sentence narrowed before anyone treats "every entry" as absolute.

## Limitations

- No source file in the user's checkout was modified. The review tree is `/tmp/phase4-r4`. The scratch `git init` there was not committed.
- `npm test`, both demos, and `pytest --testnet` were not run.
- The N32 startup refusal used `anchorHistory` returning `complete: false`. It did not submit an AccountSet. The 401-row history was a mock `account_tx`.
- The `n32-401` object in `bypass-output.json` is the mis-addressed harness described above. Do not read it as the product's answer.
- One fulfillment was returned to the test process for the original pass and again in the N37 case. It was not printed. The log records `fulfillment: true` only.
- Python was not executed on the two-entry log. Its `find_verdict` returns on the first hash match, which is the same rule as TypeScript.
- The empty-page marker loop was aborted in the mock. It was not left running against a live server.

## Artifacts

- `/opt/cursor/artifacts/VERDICT.md` (this file)
- `/opt/cursor/artifacts/phase4-r4-repro/bypass.ts` and `bypass-output.txt` / `bypass-output.json`
- `/opt/cursor/artifacts/phase4-r4-repro/test-unit.txt` and `pytest.txt`
- `/opt/cursor/artifacts/phase4-r4-repro/n32-401-corrected.txt` (the harness error from the follow-up attempt; not a product result)
