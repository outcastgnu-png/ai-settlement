# Verdict: ESCROW-001 Phase 4 re-review (EDR-014, auditable verifier)

**Reviewer:** Gpno (sole final reviewer named in EDR-014)
**For:** Christopher Terrell
**Date:** 2026-11-14, 11:44 PM CST (2026-11-15 05:44 UTC)
**Verdict:** FAIL

This review is of commit `b5f36bf124e84fbcaa5f0c578278a57ecac917e0` (`b5f36bf`), tree `e1f8b8f982d95f1e5e263b20084a69a7952e4b9d`. The merge commit `b8872321e7de4d737139b47fa346057c429562ee` has the same tree. No branch was created. No file in the checkout was modified.

0.4.0 must not be tagged on this tree. N26 is only partly fixed: the oracle will anchor a public fail and still return a fulfillment from a disagreeing private copy, and `verifyVerdictLog()` without that copy returns `ok: true`. N32 reopens N29 past the 400-transaction lookback: the SDK returns `ok: true`, and the oracle will start and anchor a second chain. N31 is not finished: the passing Windows log is not in the tree.

## Inputs

| Item | Value |
|---|---|
| Code under review | `b5f36bf124e84fbcaa5f0c578278a57ecac917e0`. Same tree as merge `b8872321e7de4d737139b47fa346057c429562ee` (PR #8, 2026-11-12 12:02 AM CST / 06:02 UTC). |
| Base | `5986030831720f144ff9849c48f25020973dc9f2`, tree `d901ac3986e5276c1ca32e6e768f4845468426e3`. Merge of PR #6, 2026-11-07 12:18 PM CST (18:18 UTC). |
| Attached diff | `phase4-r3.diff`, SHA-256 `3742a02c3fdb964f60d17bb540d720de8aceb1b4686c0e036b643e7a2fdb546c`, 493,481 bytes, 81 files. |
| Diff check | `git diff 5986030 b5f36bf` is byte-identical. Same 81 paths, same order, same patch body for every file. |
| Handoff r2 claim | The handoff's `phase4-r2.diff` was not in this environment. `git diff 5986030 f5ee6d2` is 48 files and its SHA-256 is `bb40813c0780bbd15faef39c43579285755a3b636e6e90ffff933992212561fa`, the digest the handoff names. That is `f5ee6d2`, not the tree under review. |
| Governing EDR | `edr/EDR-014_ESCROW_PHASE4_AUDITABLE_VERIFIER.md`. Accepted by Christopher 2026-11-07 12:14 PM CST (18:14 UTC). Reviewer Gpno. Scope "Auditable verifier (as drafted)". |
| How the tree was built | `git worktree add --detach /tmp/phase4-review-b5f36bf b5f36bf`. Repro scripts live under `/opt/cursor/artifacts/phase4-r3-repro/`. |
| Tags | `v0.3.0` and `v0.3.1` only. There is no `v0.4.0` tag. |

### The five tree questions

1. **Does `phase4-r3.diff` equal `git diff 5986030 b5f36bf`?** Yes. Byte-identical, and file by file. Both trees: base `d901ac3986e5276c1ca32e6e768f4845468426e3`, review `e1f8b8f982d95f1e5e263b20084a69a7952e4b9d`.
2. **Are `b5f36bf` and `b8872321` the same tree?** Yes. Both `e1f8b8f982d95f1e5e263b20084a69a7952e4b9d`.
3. **Does `6cf7d4455919fbfac6cf19f0c3223f07d2323bbf` differ from `b8872321` only in the acceptance and its evidence?** Yes. Tree `5b2d8111d8d1a06c93371f3f30e1f3ce5d64d7e2`. The only changes are `edr/ACCEPTANCES.md` (one added row: eb0c313 approved after the fact, Windows run passed 2026-10-28) and these 13 files under `xrpl-escrow/logs/2026-10-28-eb0c313-windows/`: `00-identity.txt`, `01-npm-ci.txt`, `02-typecheck.txt`, `03-test-unit.txt`, `04-oracle-run1.txt`, `04-oracle-run2.txt`, `04-oracle-run3.txt`, `05-npm-test-testnet.txt`, `05a-setup.txt`, `06-pytest-install.txt`, `06-pytest.txt`, `07-pytest-testnet.txt`, `SUMMARY.md`. No Phase 4 source change. Author date is 2026-11-04 12:55 AM CST (06:55 UTC); committer date is 2026-11-12 12:08 AM CST (06:08 UTC).
4. **Is `f5ee6d2`'s tree `868c7cf6`, and does it equal `03e0d77`?** Yes. Both are `868c7cf6dec9381ae5a616087591dff6825b1509`. `f5ee6d2` is 2026-11-08 10:03 PM CST (2026-11-09 04:03 UTC). The merge `03e0d77` is 2026-11-08 10:05 PM CST (04:05 UTC).
5. **Is `b5f36bf`'s tree `e1f8b8f9`?** Yes. Full id `e1f8b8f982d95f1e5e263b20084a69a7952e4b9d`. Commit time 2026-11-11 11:59 PM CST (2026-11-12 05:59 UTC).

`b5f36bf` is not only the Windows logs. Against `f5ee6d2` it also changes `CHANGELOG.md`, `xrpl-escrow/docs/reviews/FINDINGS_RESPONSE.md`, `xrpl-escrow/package.json`, `xrpl-escrow/src/auth.ts`, `xrpl-escrow/src/oracle/vault.ts`, and adds `xrpl-escrow/src/fs-util.ts` and `xrpl-escrow/test/fs-util.test.ts`.

## What was run, and what was only claimed

Run in `/tmp/phase4-review-b5f36bf`, Node v22.23.4, npm 10.9.9, Python 3.12.3, pytest 9.2.0. Services bound to `127.0.0.1`. No testnet transaction was submitted. No seed, fulfillment, or preimage was printed. The Windows npm is 11.16.0 and its Python is 3.14.6; those runs were not repeated here.

| Step | Result | Status |
|---|---|---|
| `npx tsc --noEmit` | 0 errors | Reproduced |
| `npm run test:unit` | 9 files, **107/107** | Reproduced |
| `vitest run test/finality.test.ts --reporter=verbose` | **7/7**, including the 1024-eviction test (12.7 s) | Reproduced |
| `python -m pytest` (no `--testnet`) | **36 passed, 1 skipped** | Reproduced |
| Reviewer bypass script and Python parity script | see findings | Reproduced. Output in `phase4-r3-repro/` |
| Read-only `account_tx` of `raU1zQN3PxSGmYh9e14cBVSz3R7PKK9xvG` | `network_id` 1; 9 anchors; one genesis; lookback complete; newest seq 8, ledger 22260835, hash prefix `2dff1b72` | Reproduced. Matches the claimed Windows Python demo head |
| `npm test`, `demo:phase4`, `pytest --testnet`, Python demo | — | **Not run.** They submit testnet transactions. The logs in the tree and the attached Windows logs are claimed only |
| Windows | — | **Not run here.** Assessed from the attached logs and from the ledger read above |

## Checklist (Phase 4 section of `xrpl-escrow/docs/reviews/REVIEW.md`)

| Claim | Result |
|---|---|
| Edit, remove, reorder, or a wrong key fails the chain check, and a broken file refuses startup | **Holds.** Reviewer `chain-edit` case, plus the unit file. Both SDKs still agree on `test/vectors/verdict-log.json` (pytest). |
| A copy that disagrees with an anchor fails | **Holds for every anchor the 400-transaction read actually returns.** A second genesis and an older disagreeing seq both set `ok` false, in both SDKs. Startup refuses when that disagreement is in the list it uses. **Does not hold past the cap (N32):** a disagreeing genesis on the next page leaves `ok: true`. |
| SDKs read the anchor from the ledger, not from the oracle | **Holds.** `listAnchors` / `list_anchors` use `account_tx`. `verifyVerdictLog` does not read `GET /verdicts/anchors`. Pins are the constructor arguments (`sdk/index.ts` 110–117), not `/health`. |
| Entries hold hashes and outcomes only | **Holds for the writer.** A deliverable `PRIVACY-TOKEN-deliverable-9f3c` and the check detail were absent from `verdict-log.jsonl`. `verdictEntry` stores check type and pass/fail only (`verdict-log.ts` 104–111). |
| The two SDKs agree on the new vectors | **Holds,** including where both are wrong. Odd `MemoType`, odd `MemoData`, a null anchored entry, reordered checks, `issuedAt` drift, a lying summary, an unanchored verdict, and the 400-transaction false `ok` all match (`parity-output.txt`). |
| `xrpl-tx-validated` uses `delivered_amount` and rejects a bad hash | **Holds.** Delivered `"1"` against a 5,000,000 drop `Amount` fails. Delivered `"1000000"` with `Amount` `"1"` passes. `0x`, a trailing newline, a leading space, and 62 hex characters fail and do not call the lookup. |
| A thrown lookup signs nothing | **Holds.** `noNetwork` returned HTTP 503, left the job `delivered`, and wrote no log line. |
| A job's first signed verdict is final (N25) | **Holds for the original attacks.** 1024 later jobs, restart, two overlapping `/verify` calls, a deleted or rewritten `verdict-log-signed.jsonl`, and a 0.3.x `verified_fail` all keep the fail and release nothing. **Does not hold** if the public append throws and the process keeps running (N33). A 0.3.x `verified_pass` is verified again (N36). |
| An entry's public fields must match the signed verdict (N26) | **Holds when the caller passes the verdict.** A lying summary, reordered checks, and a shifted `issuedAt` set `ok` false in both SDKs. **Does not hold** for the oracle's own serve path, or for `verifyVerdictLog()` with no verdict (N26 below). |
| Every anchor is checked, and one account anchors one log (N29) | **Holds inside the window,** including startup refusal and the ledger-seeded "already anchored" mark. **Does not hold** when `lookbackComplete` is false (N32). |
| With a verdict, `ok` means it is pinned (N30) | **Holds.** Default is to refuse the tail (`allowUnanchored` / `allow_unanchored` omitted or false). Opting in returns `ok: true` and `verdictAnchored: false`. Both SDKs. |
| The threat model matches the code | **Does not hold** on the sentences named under N26 and N32. The 10 second slack sentence (`docs/THREAT_MODEL.md` 83) does match the code. The tail and `allowUnanchored` sentence (line 73, item 1) matches N30. |

`FINDINGS_RESPONSE.md` at this commit marks N25–N30 fixed and N31 in progress. N26 and N29 are not fully fixed. The N31 row describes the `f5ee6d2` Windows failure and a dirty-tree rerun. It does not describe the attached 2026-11-12 log, and that log is not in the commit.

## Findings

### N25 — A signed fail is not final

**Status:** Partially closed
**Severity:** High (original). The remaining hole is N33 and does not, by itself, block the tag.
**Blocks 0.4.0 release:** No

**Where it was:** `src/oracle/server.ts` 193–230, `src/oracle/verdict-store.ts` 36–119. The 1024-entry map is gone. The log and `verdict-log-signed.jsonl` are the record.

**What holds, reproduced:**

- Not-found, then restart, then a validated `tesSUCCESS` payment: the same fail, no fulfillment, log length unchanged, status stays `verified_fail` (`bypass-output.json`, `n25-restart`). The project's own test does this after 1024 other jobs and passed here (`finality-verbose.txt`).
- Two `/verify` calls in flight for one job: one log line, both answers fail, a later valid payment does not flip it (`n25-concurrent`).
- Deleting the signed line, or rewriting it so its hash no longer matches the public entry: HTTP 409, and the tampered object is not served (`n25-tampered-signed-copy`, and the unit test "signed copy is gone").
- A crash that leaves a complete signed line and drops the public line is repaired on the next start (unit test, passed).
- A 0.3.x `verified_fail` with nothing in the new log: HTTP 409 (`n25-0.3.x-verified-fail`).

**What does not hold:** N33 and N36.

**Resolution:** Keep the sticky log. Close N33 before relying on "the first signed verdict is final" across an I/O error. Correct the `verified_*` sentence; the code only special-cases `verified_fail` (`server.ts` 201–202).

### N26 — The public log can disagree with the verdict the oracle serves

**Status:** Partially closed
**Severity:** High
**Blocks 0.4.0 release:** Yes

**Where:** `src/oracle/verdict-store.ts` 66–69 (load links a signed verdict by `verdictHash` and does not call `entryMismatch`). `src/oracle/server.ts` 193–199 and 233 (the private object is served, and a fulfillment is returned when that object's `verdict` is `pass`). `src/sdk/index.ts` 184–194 and `xrpl-escrow-py/src/xrpl_escrow/verdict_log.py` 293–304 (`ok` does not inspect a mismatched entry unless the caller passes the verdict). `docs/THREAT_MODEL.md` 72.

**What holds:** If the caller passes the signed verdict, a public `pass` whose `verdictHash` is a fail, a reordered `checks` array, and an `issuedAt` shifted by 5 ms all set `ok` false. Both SDKs. Key order inside a check object is not a mismatch, which is what canonical JSON is for. `VerdictStore.append` still builds the entry with `verdictEntry`, so the honest writer does not emit the lie. A hand-edited signed file that does not hash to the log entry yields 409, not a fulfillment.

**Repro of what remains** (`n26-public-fail-private-pass`, no testnet write):

1. Deliver a job. Stop the oracle. Leave the genesis line.
2. Put a signed **pass** in `verdict-log-signed.jsonl`.
3. Append a public entry signed by the same verdict key whose `verdict` is `fail`, whose check `pass` is false, and whose `verdictHash` is the pass.
4. Start the oracle. It starts. `anchorNow()` pins that entry (seq 1 on the stand-in ledger).
5. `POST /verify` returns `verdict: pass` and a fulfillment. The public line still says `fail`. `entryMismatch` is `"verdict"`.
6. `verifyVerdictLog()` with no verdict returns `ok: true` and `problems: []`. The same call with the pass returns `ok: false`. Python agrees (`parity-output.txt`, `n26-holder`: `withoutVerdictOk: true`).

**Impact:** This is the operator the log is supposed to constrain. They hold the verdict key, so they can sign the entry. After the anchor, a reader who trusts `ok` and the public `verdict` field sees a pinned fail. The provider was given the fulfillment. The pass is not recoverable from the public entry: `verdictHash` covers the signature and the check details, which the log omits, so an honest entry and this lie look the same to someone who does not hold the pass. The threat-model sentence "it just can't hide it … or show it differently later" (`docs/THREAT_MODEL.md` 72) is not true of this tree.

The original N26 direction (public pass, hash of a fail, caller holds the fail, SDK says ok) is closed.

**Resolution:** On load, and again before returning a stored verdict, require `entryMismatch(entry, verdict)` to be null. If it is not, refuse to start, or answer 409 and do not return a fulfillment. Do not anchor an entry that fails that check. Add this pair (public fail, private pass, anchor on the public entry, `verifyVerdictLog()` with and without the pass) next to the existing lying-summary vector.

### N27 — A null entry makes the verifier throw

**Status:** Closed
**Severity:** Low
**Blocks 0.4.0 release:** No

**Where:** `src/verdict-log.ts` 159–161. `xrpl-escrow-py/src/xrpl_escrow/verdict_log.py` 103–104.

**Repro:** `anchorProblem([null], …)` returned `entry 0 is missing or not an object` and did not throw. Python `anchor_problem([None], …)` returned the same string (`matchesTs: true`).

### N28 — Odd-length anchor memo hex

**Status:** Closed
**Severity:** Low
**Blocks 0.4.0 release:** No

**Where:** `src/verdict-log.ts` 241–243. Python `verdict_log.py` 175–177.

**Repro:** One extra nibble on `MemoType` parses as null in both SDKs. One extra nibble on `MemoData` parses as null in both. An even memo still parses as seq 0 in both. TypeScript skips an odd `MemoType` and still reads a later good memo (`oddThenGood` seq 0). Python's loop uses the same `continue`; that two-memo case was executed in TypeScript only.

### N29 — Newest anchor only, and ordinary re-runs publish a second chain

**Status:** Partially closed
**Severity:** Medium (original). The cap hole is N32.
**Blocks 0.4.0 release:** No

**Where the fix holds:** `src/anchors.ts` 9–45, `src/verdict-log.ts` 174–183, `src/oracle/server.ts` 264–276, `src/oracle/verdict-store.ts` 191–217.

**Reproduced:**

- Two seq-0 hashes in one `account_tx` page: `ok` false, and the problem names two genesis entries.
- A newer anchor whose hash is not the log entry at that seq: `ok` false.
- Startup with that second genesis in the list the oracle actually consults: `refusing to start` (`n29-startup-refuses-visible-second-genesis`, and the unit test).
- The local anchor book does not suppress a publish. An anchor read from the ledger that matches the head does (`already-anchored-source`).
- `account_tx` throwing `noNetwork` at startup: the oracle does not start, and the anchor callback is not called (`startup-ledger-down`). The genesis file is created on disk before that check. Nothing is published.
- The Windows account `raU1zQN3…` was reused with the same `data/` directory. A read-only lookup on 2026-11-14 11:44 PM CST shows one genesis, lookback complete, and the newest anchor still the Python demo's head (seq 8, ledger 22260835, hash prefix `2dff1b72`). That reuse did not fork. The account is inside the 400-transaction window, so this lookup does not exercise N32.

**What does not hold:** N32. `FINDINGS_RESPONSE.md` 172 says a missing anchor still fails closed. That sentence is false.

### N30 — `ok: true` when the caller's verdict is only in the tail

**Status:** Closed
**Severity:** Low
**Blocks 0.4.0 release:** No

**Where:** `src/sdk/index.ts` 184–192. `verdict_log.py` 296–303. Defaults: the TypeScript option is omitted, so it is not allowed; Python `allow_unanchored` defaults to `False` (line 269).

**Repro:** A verdict at seq 1 with the anchor on genesis: `ok` false, `verdictAnchored` false, problem "after the newest anchor". The same call with the flag set: `ok` true, `verdictAnchored` false. Both SDKs (`n30-unanchored-default`, `n30-allow-unanchored`, `parity-output.txt` `n30`).

### N31 — No commit, and no Windows run

**Status:** Partially closed
**Severity:** Process
**Blocks 0.4.0 release:** Yes

**What is now true:** The Phase 4 tree has a commit, `b5f36bf`, and it is on main as `b8872321` (identical tree). `f5ee6d2` equals its merge `03e0d77`. There is a commit to point at. The attached Windows log for 2026-11-12 12:01–12:16 AM CST names `b5f36bf` and tree `e1f8b8f9`, which match this review. I did not run Windows.

**What the attached `b5f36bf` log claims, and what I could check:**

| Claim in the log | This review |
|---|---|
| Clean tree, Windows 11, Node 24.18.0, Python 3.14.6 | Claimed. Not repeated. |
| `test:unit` 107/107, finality 7/7 five times | The same counts passed on Linux. The Windows run is claimed. |
| `npm test` 112/112, `demo:phase4` 28/28, `pytest --testnet` 37, Python demo 16/16 | Claimed only. Not run here. |
| Offline pytest 36 passed, 1 skipped | Reproduced on Linux. |
| No `[fs] replaced` line, no `EPERM` | Claimed. The retry path was not exercised on that run. `test/fs-util.test.ts` passed here with an injected `EPERM`. |
| No seed in the log | I scanned the attached `f5ee6d2` and `b5f36bf` logs. The only hit is the sentence that tells the operator to remove `ORACLE_ANCHOR_SEED` from `.env`. No seed value, fulfillment, or preimage. |
| Reused `.env` and `data/` from the `f5ee6d2` run, anchor `raU1zQN3…` | Confirmed in the log text. The ledger read above shows that account still has one genesis and the demo's newest anchor. Continuing the same data directory is what N29 requires. A fresh data directory on that seed would be the fork. |

**What is not done:** EDR-014 asks for the Windows log to be kept in `logs/`. The passing 2026-11-12 log is not in `b5f36bf` and not in `6cf7d44`. The commit contains `logs/windows-2026-11-08-f5ee6d2/` (the failure: unit 102/103, `npm test` 107/108, `EPERM` renaming `vault.json.tmp` and `replay.json.tmp`) and `logs/windows-2026-11-08-rename-retry/`. That second run's `00-applied-status.txt` is a dirty worktree (`fs-util.ts` untracked). Its unit log says 107/107 and does not name `b5f36bf`. `FINDINGS_RESPONSE.md` still says a Windows run on the fix commit is what closes N31.

The `f5ee6d2` failure log's "107/108" and "102/103" match the summary the user described. I did not re-run them.

**Resolution:** Put the passing Windows log for the commit that is actually tagged into `logs/`. Do not treat the dirty-tree rerun as that log. N31 stays open until that file is in the tree Gpno reviews.

### N32 — Past 400 account transactions the lookback fails open, and the oracle will anchor a fork

**Status:** New
**Severity:** High
**Blocks 0.4.0 release:** Yes

**Where:** `src/anchors.ts` 28–45 (`complete` is false when a marker remains at `maxTx`). `src/sdk/index.ts` 170–194 (`lookbackComplete` is stored and never added to `problems`; `ok` is `problems.length === 0`). `src/oracle/server.ts` 266–268 (the startup callback returns `.anchors` and drops `.complete`). `xrpl-escrow-py/src/xrpl_escrow/verdict_log.py` 213–233 and 286–304, and `kit.py` 126–130 (same). `docs/THREAT_MODEL.md` 73, the clause "failing closed past that". `FINDINGS_RESPONSE.md` 172, "a missing anchor still fails closed". README 238–239 says every older anchor is read, and does not mention the cap.

**Repro** (mock `account_tx`, no testnet write; `n29-flood-400` and `n29-startup-flood`):

1. Newest-first history: one AccountSet whose memo is this log's genesis, then 399 payments, then a second seq-0 AccountSet with a different hash. `listAnchors(..., 400)` returns only the first genesis, `complete: false`, and stops after 4 pages. `listAnchors(..., 500)` returns both and `anchorHistoryProblems` names two genesis entries.
2. `EscrowKit.verifyVerdictLog` uses the default 400. Result: `ok: true`, `problems: []`, `lookbackComplete: false`. Python `list_anchors` / `verify_verdict_log` do the same (`parity-output.txt`, `n29-flood`: `ok: true`, `lookback: false`).
3. Same shape, but the 400 newest transactions are payments and the only real genesis for this verdict key sits on the next page. `startOracle` is given the production expression `(await listAnchors(...)).anchors`. It starts. `anchorNow()` publishes a new genesis. The hidden hash was `56565656…`. The published hash prefix was `043a75a5`. The stand-in anchorer recorded the call. No AccountSet was submitted to testnet.

Payments count toward the 400 because `seen` counts every account transaction (`anchors.ts` 37–40). Anyone can pay the anchor account. After the window slides past a previous genesis, a new data directory does not trip the startup refusal, and a reader who trusts `ok` accepts the new log.

**Impact:** N29's one-account-one-log rule holds only while every disagreeing anchor is inside the newest 400 transactions. The threat model says the opposite. An honest log whose own anchors have merely aged out of the window can also show `ok: true` while `lookbackComplete` is false, which is the same fail-open bit: the field is reported, and `ok` ignores it.

**Resolution:** If `complete` is false, `verifyVerdictLog` / `verify_verdict_log` must add a problem and set `ok` false. `startOracle` must refuse to start, or refuse to anchor, when the read is incomplete. Add the 401st-transaction case to the shared vectors, with `ok: false` in both SDKs, and a startup test that does not publish.

### N33 — A failed public append does not stick the verdict already written to the signed file

**Status:** New
**Severity:** Medium
**Blocks 0.4.0 release:** No

**Where:** `src/oracle/verdict-store.ts` 112–118. The signed line and `#signed` are updated before `#appendEntry`. `#byJob` is set only after the public write (line 94). `src/oracle/server.ts` 218–229 runs the checks again when `issued()` is null.

**Repro** (`n25-io-between-writes`): the public log was mode `0444` before `/verify`. The signed file then contained `fail`. The HTTP status was 500 (the server logged `EACCES` from `appendFileSync` in `#write`). After the file was made writable and the same hash resolved to a validated payment, the next `/verify` returned `pass` and a fulfillment. The public log's only line for that job was `pass`. The signed file was `fail`, then `pass`. After restart, the verdict served was `pass`.

The unit test that drops the public line and restarts still passes. That is process death. This is the process surviving the `appendFileSync` error.

**Impact:** A remote provider cannot chmod the operator's log. A full disk, or any local writer that can make `verdict-log.jsonl` unwritable while `verdict-log-signed.jsonl` still accepts a line, can leave a signed fail that the next verify ignores. If the checks would now pass, the fulfillment is released and the public log never shows the fail. Restarting before that second verify would have repaired the fail. The bug is that the process does not need to restart.

**Resolution:** Once the signed line is durable, `issued()` must return it, including after a thrown public append. The next `/verify` should retry the public write and return that same verdict. It must not run the checks again. Add a test that fails the public `appendFileSync` once, then verifies again with a lookup that would now pass.

### N34 — Phase 4 was merged to main before this re-review

**Status:** New
**Severity:** Process
**Blocks 0.4.0 release:** Yes

**Where:** History on `main`, not a source line. EDR-014, "Boundaries": no commit, merge, or push without Christopher's approval for that commit, and a review request is not commit approval.

**Evidence:** PR #7 merged `f5ee6d2` as `03e0d77` on 2026-11-08 10:05 PM CST (2026-11-09 04:05 UTC). PR #8 merged `b5f36bf` as `b8872321` on 2026-11-12 12:02 AM CST (06:02 UTC). Both are ancestors of current `main` (`6cf7d44`). This re-review is the first Gpno verdict on those commits. The previous verdict, dated 2026-11-08 CST, was a FAIL of an uncommitted diff and said not to tag. The code under review was already on main when this review started.

**Impact:** Main is not a candidate for the 0.4.0 tag even apart from N26 and N32. A later reader cannot tell from the tag history that the merged tree was still waiting on the reviewer named in the EDR.

**Resolution:** Leave the merges in the history. Do not tag 0.4.0 on `b5f36bf`, `b8872321`, or `6cf7d44`. The next tag waits on a tree where N26 and N32 are closed and on a verdict that says so.

### N35 — What has to happen before the 0.4.0 tag

**Status:** New
**Severity:** Process
**Blocks 0.4.0 release:** Yes

**Evidence:** No `v0.4.0` tag exists. EDR-014's acceptance evidence still requires the Windows log in `logs/`, and Gpno's Phase 4 verdict recorded in `xrpl-escrow/docs/reviews/VERDICT.md` with the previous verdict archived. This file is the re-review. It is not in the repository. `6cf7d44` records the eb0c313 acceptance only.

**Resolution, in order:**

1. Fix N26 (refuse a stored verdict that disagrees with its public entry; do not anchor it) and N32 (`ok` false, and do not anchor, when the lookback is incomplete).
2. Keep N33 from flipping a persisted fail. It does not block on its own; it should not ship under the threat-model sentence that a not-found result fails for good.
3. Hand Gpno that commit. Do not merge it as the release commit before that verdict if the EDR's approval rule is still in force.
4. Run the Windows commands in the Phase 4 section of `REVIEW.md` on that commit, with a fresh anchor wallet if `data/` is not the log that wallet already anchors. Put that log in `logs/`.
5. Archive the current `VERDICT.md` and commit the passing verdict.
6. Tag `v0.4.0` only on that tree.

### N36 — A 0.3.x `verified_pass` with nothing in the log is verified again

**Status:** New
**Severity:** Low
**Blocks 0.4.0 release:** No

**Where:** `src/oracle/server.ts` 201–202. The 409 for a pre-chain job checks `verified_fail` only. `FINDINGS_RESPONSE.md` 168 and the re-review handoff say `verified_*`.

**Repro:** A job marked `verified_pass` by the oracle token, with a matching deliverable and no log line, returned HTTP 200, `verdict: pass`, and a fulfillment (`n25-0.3.x-verified-pass`). The same setup with `verified_fail` returned 409.

**Impact:** A 0.3.x pass can be decided again. The checks can now fail, which appends a fail the registry will not move off `verified_pass` (the status update runs only while the job is `delivered`, `server.ts` 236–240). Or they pass, and the fulfillment is released again. That fulfillment is the one the old pass already entitled the provider to. It is not the N25 fail-then-pass theft. The response document overclaims the code.

**Resolution:** Make `verified_pass` 409 when the log has no entry, matching `verified_fail`, or change `FINDINGS_RESPONSE.md` to the sentence in `server.ts` 201. Add the pass case next to the existing 0.3.x test.

## `replaceFileSync` (the Windows retry)

**Where:** `src/fs-util.ts` 15–37. Callers: `src/oracle/vault.ts` 52–55 and `src/auth.ts` 65–70. Both write the whole temp file with `writeFileSync`, then rename it over the destination. The verdict log and the signed copy use `appendFileSync` and do not go through this helper.

**What holds, reproduced** (`fs-util` in the bypass output, injected rename, Linux):

- `EPERM` twice, then a real rename: the destination is `NEW`, the temp file is gone, one warning, three tries.
- `EIO`: thrown immediately, destination stays `OLD`, temp file left in place. Not swallowed.
- `EPERM` on every try: thrown after 8 attempts (the unit test's "after 7 retries"), destination stays `OLD`.
- A rename that moves the file and then reports `EPERM`: the retry throws `ENOENT` (not retryable, not swallowed). The destination is `NEW`. The directory has one file, not two.

The retry delays sum to 1030 ms (`test/fs-util.test.ts`, passed inside the 107). A non-retryable `code` is rethrown at `fs-util.ts` 29. The last retryable error is rethrown at line 32.

**What this environment could not show:** Windows `MoveFileEx` atomicity, a real `EPERM` from a scanner holding the file, and whether the `fs.renameSync` live binding can be hooked under `SecretVault`. A hook installed on `fs.renameSync` from the repro did not intercept `vault.put` (`vault-rename.roundTrip` is false, and a following put of `job-c` succeeded). The vault test that did run is the direct helper, plus a normal put of two jobs that round-trips through AES-GCM. I did not demonstrate a partial vault write. The write-then-rename order means a crash during `writeFileSync` leaves the previous destination in place; a crash during a successful rename is the operating system's rename.

The claimed Windows log shows the retry was not taken on 2026-11-12. That does not falsify the helper. It means the flake did not recur. The `f5ee6d2` log is the one that shows the unfixed `EPERM`.

## Release gating

| Gate | State |
|---|---|
| N25 original attacks (1024, restart, concurrency, missing signed copy) | Closed on this tree. Reproduced. |
| N26 holder check | Closed. The serve-and-anchor direction is not. **Blocks the tag.** |
| N27, N28, N30 | Closed. Reproduced in both SDKs. |
| N29 inside the window, ledger-seeded anchor mark, ledger down at startup | Closed. Reproduced. |
| N32 lookback | **Open. Blocks the tag.** |
| N33 I/O gap between the two writes | Open. Does not block on its own. |
| N31 Windows evidence in `logs/` for the reviewed commit | The passing run is claimed and is not in the tree. **Blocks the tag.** |
| N34 merge before the verdict | **Blocks the tag** on `b5f36bf` / `b8872321` / `6cf7d44`. |
| Linux offline tests | Reproduced: typecheck 0, unit 107/107, finality 7/7, pytest 36 passed and 1 skipped. |
| Linux testnet `npm test`, both demos, `pytest --testnet` | Claimed in the 2026-11-09 logs in the diff, and again in the attached Windows log. Not run here. |
| Windows | Claimed for `b5f36bf`. Not run here. Ledger read corroborates that run's anchor head and shows one genesis. |
| `v0.4.0` | Do not tag. |

## Limitations

- The checkout used for reading was already a detached `b5f36bf`. The tests ran in a second detached worktree. `git status` on the original checkout was empty at the end. No branch, commit, push, tag, or GitHub comment.
- `npm test`, `demo:phase4`, `pytest --testnet`, and the Python demo were not run. The partial-payment result is a stand-in lookup, not a `tfPartialPayment` transaction on the ledger.
- The N32 startup publish used the test stand-in anchorer. It records that `startOracle` called it. It did not submit an AccountSet.
- The 400-transaction cases used a mock `account_tx`. The only live ledger call was the read-only history of `raU1zQN3…` on `wss://s.altnet.rippletest.net:51233`, `network_id` 1.
- A fulfillment was returned to the test process in the N26 and N33 cases. It was not printed. The bypass log records `fulfillment: true` only.
- The oracle's own `console.error` of the injected `EACCES` is in `bypass-output.txt`. It names a temp path and the stack. It does not contain a seed or a fulfillment.
- `SecretVault`'s rename was not fault-injected. See the `replaceFileSync` section.
- One testnet endpoint was used for the read-only lookup. A lying server remains the residual the threat model already names (`docs/THREAT_MODEL.md` 74).

## Artifacts

- `/opt/cursor/artifacts/VERDICT.md` (this file)
- `/opt/cursor/artifacts/phase4-r3-repro/bypass.ts` and `bypass-output.txt` / `bypass-output.json`
- `/opt/cursor/artifacts/phase4-r3-repro/parity.py` and `parity-output.txt`
- `/opt/cursor/artifacts/phase4-r3-repro/vectors.json` (signed verdicts and public keys used for parity; no seeds)
- `/opt/cursor/artifacts/phase4-r3-repro/ledger-readonly.ts` and `ledger-readonly.txt`
- `/opt/cursor/artifacts/phase4-r3-repro/test-unit.txt`, `finality-verbose.txt`, `pytest.txt`
- `/opt/cursor/artifacts/phase4-r3-repro/git-diff-5986030-b5f36bf.diff` (byte-identical to the attached diff)
