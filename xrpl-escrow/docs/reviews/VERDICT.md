# Verdict: ESCROW-001 Phase 4 (EDR-014, auditable verifier)

**Reviewer:** Gpno (sole final reviewer named in EDR-014)
**For:** Christopher Terrell
**Date:** 2026-11-08 (Central Standard Time)
**Verdict:** FAIL

This review is of the supplied uncommitted diff against base `5986030831720f144ff9849c48f25020973dc9f2` (`5986030`). There is no Phase 4 commit hash. `e80f884` is not in this clone and was not treated as the target. The Phase 3 verdict is historical context only and is not a Phase 4 approval.

0.4.0 must not be tagged on this tree. N25 and N26 break the two properties this phase adds: a transaction check that fails for good, and a public log that cannot show a different outcome from the signed verdict. N31 also blocks a tag: there is no commit to tag, and the Windows run EDR-014 requires has not been done.

## Inputs

| Item | Value |
|---|---|
| Base reviewed | `5986030831720f144ff9849c48f25020973dc9f2` (main). Workspace was clean. No branch was created. |
| Larger diff | SHA-256 `5d50eadedd4b42ca3ebbfdd493013b2650766ac50f3045151f28c19b7eefc8ab` (5515 lines, 42 files) |
| Smaller diff | SHA-256 `affeab30571fb7f298751909381a45f5248eebda060d2fe987b5208aef10b81e` (4633 lines, 36 files) |
| Diff comparison | All 36 files present in both diffs are byte-identical. The larger diff only adds six log files: `xrpl-escrow/logs/2026-11-07-phase4.txt`, `2026-11-07-phase4-npm-test.txt`, `2026-11-07-phase4-test-unit.txt`, `2026-11-07-phase4-txs.json`, and `xrpl-escrow-py/logs/2026-11-07-pytest-testnet.txt`, `2026-11-07-python-demo.txt`. No source ambiguity. |
| Governing EDR | `edr/EDR-014_ESCROW_PHASE4_AUDITABLE_VERIFIER.md` and `edr/ACCEPTANCES.md` at the base. Status Accepted. Christopher, 2026-11-07 12:14 PM CST (18:14 UTC). Reviewer Gpno. Scope "Auditable verifier (as drafted)". |
| Handoff | Says the work is not committed, and also says "push of e80f884" is not done. Those statements conflict. The review target is the diff, not that hash. `claude/project-thread-c278tc` is not a remote branch tip from this clone. |
| How the tree was built | `git archive 5986030` into `/tmp/escrow-phase4-review` (no `.git`, no branch), then `git apply` of the larger diff. One apply warning: a new blank line at EOF. Not a source difference. |

## What was run, and what was only claimed

Independently run in the isolated Linux review environment, Node v22.23.4, npm 11.21.1 for `npm ci`, Python 3.12.3. Services in the local repro bound to `127.0.0.1`. No testnet transaction was submitted. No seeds, fulfillments, or preimages were printed.

| Step | Result | Status |
|---|---|---|
| `npx tsc --noEmit` | 0 errors | Reproduced |
| `vitest` unit files named in `package.json` `test:unit` | 7 files, **94/94** | Reproduced. Matches the claimed Linux unit log. |
| `python -m pytest` (no `--testnet`) | **34 passed, 1 skipped** | Reproduced. Matches the claimed offline count. |
| `npm test` (98/98, includes testnet flows) | — | **Not run.** Would submit testnet transactions. The supplied log is claimed evidence only. |
| `npm run demo:phase4` (27/27) | — | **Not run.** Claimed log only. The public transaction hashes in that log were re-fetched read-only; see below. |
| `pytest --testnet` (35) and Python demo (16/16) | — | **Not run.** Claimed logs only. |
| Windows | — | **Not done**, by the handoff and by the absence of a Windows log in either diff. |
| Read-only testnet | `network_id=1` on `wss://s.altnet.rippletest.net:51233` | Reproduced for lookups only. |

Read-only confirmation of the supplied demo transactions (not a re-run of the demo):

- `BD6866AA…61DEF` is a validated `tesSUCCESS` Payment. `meta.delivered_amount` is `"1000000"`. API v2 has `DeliverMax` and no `Amount`. Partial-payment flag is clear.
- `41F7DFE0…F6E8` is a validated Payment with `tecNO_DST_INSUF_XRP` and `delivered_amount` null.
- `7B8039EE…0EF9` is a validated `tesSUCCESS` AccountSet. It is the demo's anchor (ledger 22144195, seq 2, hash `884f09f5…80f5`). It is still on the ledger.
- `latestAnchor` against the demo anchor account and verdict address does **not** return that anchor. It returns a later seq-2 anchor with a different hash. Fifteen anchor memos from that account are listed in `phase4-repro/anchors-readonly.txt`. Five different seq-0 hashes are on the ledger. See N29.

## Checklist

| Claim | Result |
|---|---|
| Edit, remove, reorder, or a wrong key fails `checkChain` / `check_chain`, and a broken file refuses startup | **Holds** for a broken chain and for a different key. Covered by `test/verdict-log.test.ts` (passed in the 94) and by `tests/test_verdict_log.py` (passed). `VerdictStore` re-reads the file and throws unless `checkChain` passes (`src/oracle/verdict-store.ts` 26–35). A same-key fork that still links is a different question; the oracle will start on it and can anchor it (N29). |
| A copy that disagrees with the anchor fails | **Holds for the newest anchor.** Truncation below the anchored sequence fails. A rewritten suffix at the anchored index fails. Tested in the unit file. Older anchors are not compared (N29). |
| SDKs read the anchor from the ledger, not from the oracle | **Holds.** `latestAnchor` / `latest_anchor` use `account_tx`. `verifyVerdictLog` does not read `GET /verdicts/anchors`. That route serves the local book, which the comment correctly calls a convenience (`verdict-store.ts` 89). Pins come from `ORACLE_VERDICT_ADDRESS` and `ORACLE_ANCHOR_ADDRESS`, not from `/health` (`sdk/index.ts` 32–42, 132–134). I called `latestAnchor` on testnet and got a real AccountSet memo. |
| Entries hold hashes and outcomes only | **Holds for the writer.** `verdictEntry` keeps check type and pass/fail and drops `detail` (`verdict-log.ts` 102–109). A local job whose deliverable was `PRIVACY-TOKEN-deliverable-9f3c` did not put that string or the fulfillment in `verdict-log.jsonl`. The check type name is stored, which is intended. The public summary can still disagree with the hashed verdict (N26). |
| The two SDKs agree | **Holds on the shared vectors** (pytest). U+2028 canonical form is the same 16-byte string on Node 22.23.4 and Python 3.12.3 (raw U+2028, not a `\u2028` escape). **Does not hold** for an odd-length `MemoType` (N28). |
| `xrpl-tx-validated` passes only on a validated `tesSUCCESS` transaction with the stated fields, using `delivered_amount` for payments | **Holds as a predicate.** Partial payment: delivered `"1"` against a 5 XRP `Amount` fails; a tiny `Amount` with delivered `"1000000"` passes, so `Amount` / `DeliverMax` is not what is counted (`xrpl-tx.ts` 87–89). IOU object fails the drop-string test. `tec*`, `validated: false`, null close time, and a non-64-hex deliverable (`0x`, whitespace, JSON) fail. Registry rejects a bad spec and a third tx check (`registry/server.ts` 50–58, `MAX_TX_CHECKS = 2`). `createdAt` is set by the registry (`db.ts` 159–161), not by the client. The 10 s slack is implemented and the unit test allows a close 5 s before `createdAt`. I did not submit a partial payment. The live demo payments are full payments; their shape matches the field the code reads. The fail is not final (N25). |
| A failed ledger lookup signs nothing | **Holds for a thrown lookup.** `txnNotFound` and a timeout/`noNetwork` were classified separately: not-found becomes `{found:false}` and is a signed fail (the unit test requires that); a thrown error becomes `CheckUnavailable`, HTTP 503, no log line, status left at `delivered` (unit test plus this review's probe). Persistence and the later race do not hold (N25). |
| Pagination, startup, shutdown | **Mostly holds.** `from=-1` and `limit=1e2` return 400 (`server.ts` 141–145). `limit` is capped at 500. Startup refuses non-JSON and a broken chain. Shutdown calls `AnchorSchedule.stop`, which anchors again (`server.ts` 273–279, 286–291). The anchor book is not checked against the ledger, so a local edit can suppress the next publish until the head moves (`verdict-store.ts` 145–149). Readers still use the ledger. |
| Threat model | **Does not hold on two sentences** it adds. "it just can't … show it differently" (`docs/THREAT_MODEL.md` 72) is N26. "A transaction still unvalidated when verified fails for good, since a job's verdict is final" (line 74) is N25. The unanchored tail, split views between readers, a verdict never logged, a new chain, a lying testnet server, and local-only scope are stated and match the code. The new-chain row understates how easily honest re-runs do it (N29). |
| Own verdict inclusion | Inclusion is by `verdictHash` plus `jobId` only. It returns the entry even when the public `verdict` field is the opposite (N26), and `ok` is true when that entry sits past the anchor (N30). |

## Findings

### N25 — A signed fail is not final, and a later pass releases the fulfillment

**Severity:** High
**Blocks 0.4.0 release:** Yes

**Where:** `xrpl-escrow/src/oracle/server.ts` 107–108, 115, 181–183, 194–223, 228–234. `xrpl-escrow/src/oracle/checks/xrpl-tx.ts` 78–82. `docs/THREAT_MODEL.md` 74. The log is not consulted on a cache miss (`verdict-store.ts` has `append` and no lookup by job).

**What the code does:** The signed verdict is remembered only in a process-local map of 1024 entries. `POST /verify/:jobId` still accepts `verified_fail` and `verified_pass`. On a miss it runs the checks again, appends a new signed entry, and, on a pass, returns `toFulfillment(secret)`. The registry status is updated only while the job is still `delivered`, so it stays `verified_fail`. `xrpl-tx-validated` turns "not found" and "not validated" into a signed fail, not a 503. Those outcomes change if the same hash is looked up later.

**Repro (local, no testnet write):** `phase4-repro/repro.ts`, output in `phase4-repro/repro-output.txt`.

1. Deliver a 64-hex hash. Lookup returns not found. Result: `verdict=fail`, no fulfillment, status `verified_fail`, one log entry.
2. Verify 1024 other funded jobs (12.5 s, escrow double held open). The victim's map entry is evicted.
3. Point the same hash at a validated `tesSUCCESS` payment whose `delivered_amount` meets `minDrops` and whose close time is after `createdAt`. Verify again.
4. Result: `verdict=pass`, fulfillment present, status still `verified_fail`, signatures differ, log entries for that job are `fail,pass`, `checkChain` is ok. The fulfillment string is not in the log file.
5. Separate job, unvalidated lookup, then `restartOracle()`, then a validated lookup. Same result: fail, then pass with a fulfillment, status stays `verified_fail`, log grew by one.

The escrow double returns "open", which is what `ledgerEscrowCheck` (`server.ts` 92–104) returns while the escrow object is still on the ledger. A `verified_fail` does not finish or cancel it. I did not submit `EscrowFinish`. The value returned is the fulfillment that `finishEscrow` submits.

**Impact:** The provider can take the XRP after the oracle has signed a fail and the registry shows `verified_fail`. The client who believed the new threat-model sentence and waited out `CancelAfter` loses the race if the provider repeats verify after a restart or after 1024 other verdicts. Restart is enough on its own; the operator does not have to be malicious. Both verdicts stay in the chain, so the log shows the contradiction and does not hide it. The secret is still released. A thrown lookup (timeout, disconnect) is still a 503 with no verdict; this finding is the signed not-found / unvalidated / fail path, not the 503 path.

**Resolution:** Make the first signed verdict for a job id sticky. On startup, load it from the log. On a later verify, return that verdict and do not run checks again. Do not return a fulfillment if the stored verdict is fail. Add two tests: fill 1024 later jobs, and restart the process. Both must keep the original fail, omit the fulfillment, and leave the log length unchanged. Keep 503, with no log line, for thrown lookups.

### N26 — The public log can say pass while the signed verdict says fail, and the SDK returns ok

**Severity:** Medium
**Blocks 0.4.0 release:** Yes

**Where:** `xrpl-escrow/src/verdict-log.ts` 162–164 (`verdictInLog` matches `verdictHash` and `jobId` only). `xrpl-escrow/src/sdk/index.ts` 197–201 (inclusion does not compare fields and does not change `ok` when the summary disagrees). `xrpl-escrow-py/src/xrpl_escrow/verdict_log.py` 107–112 and 231–234. Writer at `verdict-log.ts` 102–109 copies `verdict` and `checks` separately from `verdictHash`. `docs/THREAT_MODEL.md` 72.

**Repro:** same script, line `summary-lie`. A verdict key signed an entry whose `verdict` is `pass` and whose `checks[0].pass` is true, while `verdictHash` is the hash of a fail verdict for that `jobId`. `checkChain` returned ok. `verdictInLog` returned seq 1. `EscrowKit.verifyVerdictLog` against a ledger whose newest anchor is that entry returned `sdkOk=true` and `problems=none`. The holder's verdict is `fail`. The public field is `pass`.

**Impact:** This is the operator the log is meant to constrain. The entry is signed, so the contradiction is inside a signature, but the check a holder is told to run does not notice it. Anchoring does not fix it: the anchor commits to the entry hash, and that hash covers both the lie and the `verdictHash`. Anyone who only reads the log sees the summary. Anyone who only checks `ok` and a non-null `verdictEntry` is told their verdict is logged.

**Resolution:** `verdictInLog` / `verdict_in_log` must require `verdict`, `checks` (type and pass), `evidenceHash`, `condition`, `provider`, and `issuedAt` to match the signed verdict. `verifyVerdictLog` must add a problem and set `ok` false when they do not. Reject an append that fails the same check. Add the lying entry above as a vector in `test/vectors/verdict-log.json` so both SDKs fail it.

### N27 — A null entry makes the verifier throw instead of returning a failed check

**Severity:** Low
**Blocks 0.4.0 release:** No

**Where:** `xrpl-escrow/src/verdict-log.ts` 154–158. `anchorProblem` reads `entries[anchor.seq].hash` after the length check. `checkChain` already rejects a null entry, but `verifyVerdictLog` still calls `anchorProblem` (`sdk/index.ts` 186–188). Python `anchor_problem` (`verdict_log.py` 100–102) raises `AttributeError` on a non-dict the same way.

**Repro:** `anchorProblem([null], {v:1, seq:0, hash: <64 hex>, oracle}, oracle)` threw `TypeError: Cannot read properties of null (reading 'hash')`.

**Impact:** A served or hand-copied log with a null at the anchored index crashes the caller. It does not return `ok: true`. The oracle itself refuses to start on that file.

**Resolution:** If the indexed value is missing or not an object, return a problem string. Add that case next to the existing junk test.

### N28 — TypeScript accepts an odd-length anchor MemoType; Python rejects it

**Severity:** Low
**Blocks 0.4.0 release:** No

**Where:** `xrpl-escrow/src/verdict-log.ts` 186. The type check is `/^[0-9A-Fa-f]*$/` and `Buffer.from(hex, "hex")`, which drops a trailing nibble. `xrpl-escrow-py/src/xrpl_escrow/verdict_log.py` 131 requires `len(memo_type) % 2`.

**Repro:** The same memo with one extra nibble on `MemoType` parsed as seq 1 in TypeScript (`typeLen=57`) and as `None` in Python (`parity-output.txt`). The oracle's own `anchorMemos` writes even-length hex, so normal anchors match. Only an AccountSet from the anchor account with a hand-built odd type splits the SDKs: TypeScript can treat it as the newest anchor and Python will skip it and see an older one, or none.

**Also seen, not a current bypass:** Python `anchor_problem` with `seq: -1` returned None, because `entries[-1]` is the last row and the hash matched. `parse_anchor_memo` rejects `seq < 0` (line 144), and both SDKs parse before they compare. TypeScript rejects it too (`verdict-log.ts` 196).

**Resolution:** Reject an odd-length `MemoType` and `MemoData` in TypeScript the way Python does. Add the odd-nibble memo to the shared vectors.

### N29 — The SDK trusts the newest anchor only, and ordinary re-runs already publish conflicting chains

**Severity:** Medium
**Blocks 0.4.0 release:** No

**Where:** `xrpl-escrow/src/sdk/index.ts` 82–102 and `xrpl-escrow-py/src/xrpl_escrow/verdict_log.py` 169–186 return the first matching AccountSet in newest-first order and stop. Nothing walks older anchors. `AnchorSchedule` anchors whatever the local head is (`verdict-store.ts` 145–151) and does not refuse a new genesis when the account has already anchored a different one. `docs/THREAT_MODEL.md` 73 item (4) says a new chain is outside what the log proves and that the anchors then disagree.

**Evidence:** Read-only `account_tx` of the anchor account in the supplied demo log (`raK9TiatzKYjNqLW26ne2bvvsYE67672Qc`), oracle `rBTtuCrBKoLB9dVMRnuMiY63aThM7HELAT`. Fifteen successful anchor memos, five different seq-0 hashes. The demo's own anchor is still there: ledger 22144195, seq 2, hash `884f09f5…80f5`, tx `7B8039EE…0EF9`. `latestAnchor` during this review (2026-11-08 CST) returned ledger 22144457, seq 2, hash `e8182658…d491`, tx `2FDFE6A5…67C4`. `matches-claimed-demo-head=false`. Full list: `phase4-repro/anchors-readonly.txt`. The supplied Python demo log uses the same verdict address and the same anchor account, so a second local run is enough to explain new genesis hashes. I did not need a malicious third party.

**Impact:** `verifyVerdictLog` of the first demo log now fails against the latest anchor, or it passes a later log, with no problem string that another anchored genesis exists. The ledger still has the disagreement. The tool the EDR tells a reader to run does not report it. The threat model describes this as something an operator might do. The demos do it by reusing one faucet anchor wallet across fresh data directories. Lookback is also capped at 400 account transactions (`maxTx = 400`), and every payment to that account counts. This account had 16 transactions, so the cap did not hide an anchor here. Past 400, a missing anchor fails closed (`ok` false), it does not false-pass.

**Resolution:** When verifying, collect anchors inside the lookback and report every genesis hash and every seq whose hash is not the log entry at that seq. `ok` must be false if more than one genesis is anchored for the pinned oracle. On startup, if the account's newest anchored genesis is not this file's genesis, refuse to start or refuse to anchor until the operator points at a new anchor account. Say in the threat model and the setup output that a second demo on the same `ORACLE_ANCHOR_SEED` publishes a second chain.

### N30 — `ok: true` when the caller's verdict is only in the unanchored tail

**Severity:** Low
**Blocks 0.4.0 release:** No

**Where:** `sdk/index.ts` 193–201. `unanchored` is reported, and the verdict check does not require `verdictEntry.seq <= anchor.seq`. The unit test locks this in: `test/verdict-log.test.ts` 263–270 expects `ok: true`, `anchor.seq` 2, `unanchored: 1`, and the job's verdict found. Python `tests/test_verdict_log.py` 62–67 expects the same (`verdict_entry` seq 3, `unanchored == 1`). `docs/THREAT_MODEL.md` 73 item (1) says the tail can be rewritten before the next anchor (default 10 minutes, `local-config.ts` 27, and on shutdown).

**Impact:** A holder who treats `ok` as "my verdict is pinned" is wrong for any verdict newer than the anchor. The field `unanchored` is the warning, and it is easy to miss. This matches the written threat model. It is a footgun in the flag, not an undisclosed hole.

**Resolution:** Set `verdictAnchored` from `verdictEntry.seq <= anchor.seq`. If the caller passed a verdict, add a problem when it is past the anchor, or document `ok` in the README with that sentence next to the example.

### N31 — No commit, and no Windows run

**Severity:** Process
**Blocks 0.4.0 release:** Yes

**Evidence:** This review's `HEAD` is `5986030831720f144ff9849c48f25020973dc9f2`. `git status` was empty. `e80f884` is not an object in this clone. EDR-014 acceptance evidence asks for a Windows run on Christopher's PC with the log kept in `logs/`, and for Gpno's verdict to be recorded in `xrpl-escrow/docs/reviews/VERDICT.md` after the previous one is archived. Neither diff contains a Windows log. The handoff says Windows is not done and that the tree is not committed, and it also mentions a push of `e80f884`. That hash was not reviewed.

**Impact:** There is nothing to tag. A later commit could differ from this diff. The Linux counts above are for this diff. They do not transfer to an unseen commit or to Windows.

**Resolution:** Commit the reviewed tree, or hand Gpno the commit hash and a `git diff 5986030 <hash>` that matches the larger diff's source (the log files may differ). Run the Windows commands in the Phase 4 section of `xrpl-escrow/docs/reviews/REVIEW.md` and keep that log. Do not tag 0.4.0 from a working tree.

## What held

These were checked and are not findings.

- Chain linkage: sequence must equal the index, `prev` must be the previous entry hash, the hash covers the canonical body plus the signature, and the signature must be from the pinned verdict address. Removing, reordering, editing, or signing with another key fails. Both SDKs agree on `test/vectors/verdict-log.json`.
- Normal log lines omit deliverable text, check `detail`, the fulfillment, and the secret. The fulfillment is returned on the verify HTTP response only, which the threat model already treats as visible to other local processes.
- Anchor memos require the exact type, exact key set `hash,oracle,seq,v`, log version 1, a non-negative safe integer sequence, and a lowercase 64-hex hash. Uppercase hashes, extra fields, version 2, and negative sequences are rejected by both parsers (odd length aside, N28).
- The oracle binds `127.0.0.1` (`http.ts` `listenLocal`, `local-config.ts` `LOCALHOST`). `connectTestnet` aborts unless `network_id === 1`. The read-only session saw network id 1.
- Payment amount is `meta.delivered_amount`, not `Amount` or `DeliverMax`. That matches the live API v2 payment. EscrowCreate still has `Amount` in the saved escrow transactions, and the code uses `tx.Amount` only for EscrowCreate.
- Thrown ledger errors do not sign. The unit test "answers 503 with no verdict when the ledger lookup fails, then verifies on a retry" passed in the 94, and this review's `noNetwork` probe returned `CheckUnavailable`.
- `GET /verdicts` rejects a non-integer `from` and `limit`. Pages are taken from the in-memory array, which only appends, so a slow reader does not see a torn page from the honest process.

## Release gating

| Gate | State |
|---|---|
| Code on this diff | **Fail.** N25 and N26. |
| Linux offline tests | Reproduced: typecheck 0, unit 94/94, pytest 34 passed and 1 skipped. |
| Linux testnet `npm test`, both demos, `pytest --testnet` | Claimed in the supplied logs (98/98 before the fork-splice unit test, demo 27/27, pytest 35, Python demo 16/16). Not re-run here. The public txs in the TypeScript demo log are real. |
| Windows | Not done. Blocks the tag (N31). |
| Commit identity | Not established. No Phase 4 commit hash. Blocks the tag (N31). |
| Phase 3 leftovers | Not re-opened. In this tree `$id`, `$anchor`, and `$dynamicRef` are in `BANNED_KEYWORDS` (`schema-policy.ts` 25–27), so the old N19 ban is present. N20, N21, and N23 were not re-tested. N22 and N24 stay closed as Phase 3 process items; they are not Phase 4 approval. |

## Limitations

- No source file in the user's checkout was modified. The review tree was a detached archive under `/tmp`.
- `npm test`, `demo:phase4`, `pytest --testnet`, and the Python demo were not run, because they submit testnet transactions. Partial-payment behavior was executed against a stand-in lookup, not a `tfPartialPayment` transaction on the ledger.
- The finality repro used the unit-test escrow double. It shows the oracle returning a fulfillment after a logged fail. It does not itself move testnet XRP.
- One testnet endpoint was used for the read-only lookups. A lying server is the residual the threat model already names.
- A local clock that is behind network time widens the 10 s "validated before the job" slack (`xrpl-tx.ts` 95–97), because `createdAt` is local `Date.now()` and close time is ledger time. Not exploited here.
- The anchor book is an unauthenticated cache. Forging "this head is already anchored" suppresses the next AccountSet until the head changes. Readers fail closed against the ledger. Not given its own number.

## Artifacts

- `/opt/cursor/artifacts/VERDICT.md` (this file)
- `/opt/cursor/artifacts/phase4-repro/repro.ts` and `repro-output.txt` (N25, N26, N27, N28 TypeScript side, privacy, pagination, partial-payment predicate)
- `/opt/cursor/artifacts/phase4-repro/parity.py` and `parity-output.txt`
- `/opt/cursor/artifacts/phase4-repro/ledger-readonly.ts` and `ledger-readonly.txt`
- `/opt/cursor/artifacts/phase4-repro/anchors-readonly.ts` and `anchors-readonly.txt`
