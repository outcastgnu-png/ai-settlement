# Verdict: ESCROW-001 Phase 6 (EDR-016, signed job spec)

**Reviewer:** Gpno (sole final reviewer named in EDR-014; this review is the work for that review)
**For:** Christopher Terrell
**Date:** 2026-11-22, 8:40 PM CST (2026-11-23 02:40 UTC)
**Verdict:** PASS WITH FINDINGS

This review is of the uncommitted tree produced by applying `phase6-since-46ba283.diff` to `46ba283`. No branch was created. Nothing was committed. No file in the repository checkout was modified.

An oracle cannot sign a v1 verdict, or return a share, unless the EscrowCreate memo's hash matches the registry spec and both signatures verify. `fundJob` and `fund_job` rebuild the hash from the spec they just read and refuse to lock XRP without both signatures. One non-blocking finding: the memo's revision number is not required to equal the spec's revision (N41). A draft finding about U+2028 and U+2029 (N40) was withdrawn by Gpno before this verdict was issued, because RFC 8785 does not escape those characters; see N40.

## Inputs

| Item | Value |
|---|---|
| Base | `46ba2830c218505d6fb67e9976e2311169e4d1da`, tree `1b3a906681e13f0d7c31b120b6e5466517a12edc`. Merge of PR #16, 2026-11-22 5:50 PM CST (23:50 UTC). |
| Full diff | SHA-256 `6890ef48d6fd649c7c74823723e45684333d28b297175399039e0374a416a3e8`, 53 files. |
| Code diff | SHA-256 `81d1d5f5a860729d800a25605ce77e3031fec97d0c280e35847e4fe65784bdf0`, 42 files. Strict subset: every code-diff path is in the full diff and those patches are byte-identical. The other 11 files are logs, `package.json`, `package-lock.json`, and `job-spec.json`. |
| Apply | `git apply --check` and `git apply` both exited 0. No warnings. |
| Resulting tree | `522d7489e467f589d4357f3aeb7e50a88428d138`, from `git add -A` and `git write-tree` in `/tmp/p6`. **Matches the claimed hash.** No commit. The same hash was returned after the mutation checks, once the five source files were restored. |
| `verdict-log.json` | Blob `188305073f18a987b58b6f61c087d3eecd222558` on both `46ba283` and this tree. Phase 4 and 5 vectors are unchanged. |

## PR #16

`d84224e` ("Add EDR-016: Phase 6 signed job spec (accepted)", 2026-11-22 5:46 PM CST / 23:46 UTC) changes only `edr/ACCEPTANCES.md` and adds `edr/EDR-016_ESCROW_PHASE6_SIGNED_JOB_SPEC.md`. Its parent is `c7b859a`, which was the tip of main. The merge commit `46ba283` has the same tree as `d84224e`. Nothing in that commit is code. It was merged about four minutes after the commit, which is the same pattern as the earlier accepted EDRs. Nothing else is off.

## Comments after the Linux runs

The four added lines in `test/vectors/make-verdict-log-vectors.ts` are comments. They say not to regenerate `verdict-log.json` with the version 2 code. The vector file's blob matches `46ba283`, so it was not regenerated. The new header of `src/verdict-log.ts` is comments. The rest of that file is the version 2 implementation, which is this phase, not a separate post-run edit the diff can separate. The checked-in `logs/2026-11-23-phase6-tsc.txt` is empty, which is what `tsc --noEmit` prints when there are no errors. This review typechecked the tree as it stands: 0 errors.

## What was run, and what was only claimed

Node v22.23.4, npm 10.9.9, Python 3.12.3. No testnet transaction was submitted. No faucet and no demo was run. No seed, share, fulfillment, preimage, or private key was printed. Eight transaction hashes from the demo log were read back with the public testnet `tx` method.

| Step | Result | Status |
|---|---|---|
| `npx tsc --noEmit` | 0 errors | Reproduced |
| `npm run test:unit` | 12 files, **173/173** | Reproduced |
| `python -m pytest` (no `--testnet`) | **70 passed, 2 skipped** | Reproduced. Includes `test_job_spec.py` and `test_verdict_log.py` |
| JCS differential fuzz | 14 shared cases, no mismatch | Reproduced. `phase6-repro/jcs-fuzz.txt` |
| Edge checks | memo, signatures, both key types | Reproduced. `phase6-repro/edges.json` |
| Six mutation spot-checks | each named test failed | Reproduced. The address-binding case is the vector test, below |
| `npm test` 180/180, `demo:phase6` 43/43, `pytest --testnet` 72/72, Python demo 31/31 | The logs in the diff say this | **Claimed, and the logs agree.** The eight demo transactions also exist on testnet |
| Windows on this tree | — | **Not run.** Blocks the merge, not this verdict |

The unit log says 173 passed. The npm-test log says 18 files and 180 passed. The pytest log says 70 passed and 2 skipped. The testnet pytest log says 72 passed. The TypeScript demo log ends at 43/43 and prints each spec hash, both signer addresses, the memo, and per-criterion verdicts. The Python demo log ends at 31/31. A search of those logs found no seed assignment, vault key, share key, or preimage. The only "fulfillment" hit is the check name "two shares rebuild the fulfillment".

The eight hashes in `logs/2026-11-23-phase6-txs.json` were read from `https://s.altnet.rippletest.net:51234` (`tx` only). All eight are validated `tesSUCCESS` on testnet ledgers 22536760 through 22536780. Four are `EscrowCreate`, each with one memo of type `xrpl-escrow/job-spec`, format `application/json`, and a `specHash` that matches the hash printed in the demo log (`533150ea…`, `332c36dc…`, `f798c9ae…`, `6f7edcb9…`). Three are `EscrowFinish` and one is `EscrowCancel`, with no memo.

## Phase 6

| Question | Result |
|---|---|
| Verdict without a matching memo | `ledgerSpecCheck` reads the open escrow, takes `PreviousTxnID`, and requires a validated `tesSUCCESS` `EscrowCreate` with the job's account, destination, condition, sequence, and amount (`spec-ledger.ts` 32–73). The hash must equal `specHash` of the registry spec, and `agreementProblems` must be empty (77–93). A v1 job with no ledger connection throws 409 before any verdict is signed (`server.ts` 307–311). A returned problem is also a 409, before `store.append`. |
| Escrow later modified | While the object exists, Finish and Cancel have not run, because those delete it. If `PreviousTxnID` ever pointed at a transaction that is not this job's `EscrowCreate`, the type, account, destination, condition, sequence, or amount check fails closed and nothing is signed. |
| Locking XRP | `fundJob` (`sdk/index.ts` 460–477) and `fund_job` (`kit.py` 345–362) use the spec from that read. One signature, a hash pin that differs, or parties, price, or SLA that differ from the spec throws `refusing to lock XRP` before `createEscrow`. The memo is built from that same object. There is no second read between the check and the memo. `signSpec` refuses when the registry hash is not the hash the caller passed (423–429). |
| Who signed | `verifySpecSignature` requires the signature's address, `deriveAddress(publicKey)`, and the spec's client or provider address to be the same key (`job-spec.ts` 142–150). A provider signature presented as the client's, and a foreign key whose address string is the client's, are rejected (`edges.json`: `foreignKeyRejected`, `oneMissing`). Python accepted TypeScript signatures from an ed25519 wallet and a secp256k1 wallet (`pyAcceptsTsEd`, `pyAcceptsTsSecp`). Uppercase hashes are rejected. |
| Revisions | Same revision and a different hash is 409 (`registry/server.ts` 171–174). The next revision must be exactly N+1 and must keep client, provider, and nonce (175–178). Signatures are stored under `(job, spec_hash, role)`. The new row uses the new hash, so the old signatures stay on the archived revision and are not returned for the new one (`db.ts` 237–284). Both routes require `status === "draft"`. A shared job cannot change `priceDrops` (179). `bySpecHash` looks at current jobs and `spec_revisions` (259–263). A new job's spec must match the top-level client, provider, price, and SLA and must be revision 1 (101–108). A posted shared-job verdict whose `specHash` is not the job's is 400 (201–203). `revise-spec` is a client-signed request over the new hash (170). |
| Criteria and checks | `specProblem` refuses a criterion with no checks, subjective or objective, duplicate ids, and a rule other than `"all"` or `{atLeast: n}` for n from 1 to the number of criteria (`job-spec.ts` 195–216). The 8-check and two-`xrpl-tx-validated` limits live in `check-spec.ts`, which the registry, `specProblem`, and the oracle's check list import. `runCriteria` passes a criterion only when it has checks and every check passes, then applies the rule (`checks/index.ts` 45–56). |
| New checks | `size-range` requires `0 <= minBytes <= maxBytes` and `maxBytes >= 1`. `contains-text` rejects empty text and text over 256 UTF-8 bytes, and the oracle uses `String.includes` (`contains-text.ts` 8). An emoji is 4 bytes in both SDKs. `schema-policy.ts` still refuses `pattern` and `patternProperties`. |
| Verdict log v2 | `checkChain` refuses a version lower than the one already seen (`verdict-log.ts` 165). A v2 verdict entry must carry `specHash`, `specVersion`, `specRevision`, and `criteria` (187–190). `entryMismatch` compares those fields on v2 and returns `specHash` when a v1 entry is paired with a verdict that has spec fields (247–253). `verifyVerdictLog({ job })` compares the verdict hash with the memo of `createTx` (374–382). |
| Shared jobs | `requestSharedVerification` throws if both signatures do not check (613–616), sets status `refused` on 409 (622–625), and does not take a share whose verdict names another spec hash (634–636). `request_shared_verification` does the same (`kit.py` 512–525, 539). |
| Tamper proxy | `startSpecTamperProxy` refuses any registry host other than `127.0.0.1` and listens through `listenLocal` (`tamper-proxy.ts` 11–13). The only production-tree import is `demo-phase6.ts`. |
| Threat model and versions | The new row states the memo check, the refund when it fails, and the four things it does not cover: statements are not judged, a signer who does not read the spec has still signed it, the oracle trusts its testnet server, and Phase 1–5 specs stay unsigned. `package.json`, `package-lock.json`, `pyproject.toml`, and `__init__.py` are `0.6.0`. `CHANGELOG.md` has an unreleased 0.6.0 section. |

**JCS fuzz** (14 cases, both implementations): unsorted keys, nested objects, safe integers, booleans, quotes and slashes, ASCII controls, U+2028, U+2029, an emoji string, an emoji key sorted against U+E000, NBSP, NFD, and a small spec. No case produced different bytes. TypeScript rejects 1.5, NaN, Infinity, a lone surrogate, and an integer outside the safe range, and encodes `-0` as `0`. Python rejects a float, `2**53`, and `-0.0`, and encodes `True` as `true` (not `1`).

**Mutation results** (throwaway edits, then restored; tree hash unchanged):

- Dropping the memo-hash comparison: "an escrow memo whose hash differs from the spec the oracle holds is refused" and "the registry's spec changed after the lock" both fail.
- Skipping the signature check in `fundJob`: "the SDK refuses to lock XRP with one signature missing" fails.
- Removing the in-place edit rejection: "a signed spec is never edited in place" fails.
- Letting `checkChain` accept a lower version after a higher one: "a v1 entry after a v2 does not" fails.
- Removing the other-spec-hash rejection in `requestSharedVerification`: "an oracle that signs a verdict on another spec hash is reported, and its share is never combined" fails.
- Dropping `deriveAddress(publicKey) === address`: "match the vectors (deterministic signatures by fixed keys)" fails. That test rewrites the address field to the other party and expects rejection (`job-spec.test.ts` 86). A name filter that did not include this test passed; the suite that includes it does not. The guard is tested.

### N40 — Withdrawn: U+2028 and U+2029 are correctly left unescaped

**Status:** Withdrawn by Gpno before issue (not a finding)
**Severity:** None
**Blocks Phase 6:** No

The draft of this verdict said RFC 8785 requires U+2028 and U+2029 to be escaped. It does not. RFC 8785 section 3.2.2.2 serializes strings the way ECMAScript `JSON.stringify` does. That escapes only `"`, `\`, and the controls U+0000 to U+001F, and writes every other character as-is. `JSON.stringify("\u2028\u2029")` yields code points `22 2028 2029 22` (checked by Gpno on Node). Both SDKs leave the two characters raw and agree on them (`phase6-repro/jcs-fuzz.txt`, cases `line-sep` and `para-sep`), which is the RFC 8785 behaviour. Nothing to fix. Adding a shared vector that contains U+2028 and U+2029 would pin this behaviour down, but it is optional.

### N41 — The memo's revision number is not checked

**Status:** New
**Severity:** Low
**Blocks Phase 6:** No

**Where:** `specAgainstMemo` in `xrpl-escrow/src/spec-ledger.ts` 86–90 compares `memo.specHash` to the hash of the registry spec and then checks the signatures. It does not compare `memo.revision` to `spec.revision`. `parseSpecMemo` (`job-spec.ts` 282–303) also accepts a spec memo beside other memo types, does not read `MemoFormat`, and uses `JSON.parse`, which keeps the last duplicate key.

**Repro:** `phase6-repro/edges.json`. `memoMatch` is true. `memoMismatch` is true. `memoRevisionNotCompared` is true: the same spec with a memo revision of 9 and the real hash is accepted. `otherMemoIgnored` is true. `duplicateKeyLastWins` is true for `JSON.parse`.

**Impact:** The hash is of the whole spec, revision included, and both signatures have to verify over that hash. A memo that lies about its revision number, or repeats a key, still has to present the hash of the spec the registry holds. The oracle judges that spec. It does not judge a different one. The loose fields do not release a share.

**Resolution:** Require `memo.revision === spec.revision` next to the hash check. Rejecting a second spec memo is already done. Rejecting duplicate keys and requiring `MemoFormat` of `application/json` would match a stricter reading of the memo and is the same small change.

## Earlier findings

| Finding | Status | Blocks this merge |
|---|---|---|
| N25–N30, N32, N33, N36, N37 | Closed. The unit file and the unchanged `verdict-log.json` still verify in both SDKs. | No |
| N31 | The Windows run for the Phase 5 commit is on main. A Windows run of the Phase 6 commit still blocks the merge, not this verdict. | Merge only |
| N34 | Satisfied so far: this tree is uncommitted and unmerged. | No |
| N35 | Closed. `v0.4.0` is `abd8b52`. This tree's version fields say `0.6.0`. | No |
| N38 | Process note on the N37 merge. Not reopened. | No |
| N39 | Still open as documentation. `docs/THREAT_MODEL.md` still has no sentence that Python does not wipe the secret. Not a Phase 6 regression, and still not a reason to hold the merge. | No |

## Before merge

1. Commit exactly this tree. `git diff 46ba283 <commit>` must be this 53-file diff, and the tree must be `522d7489e467f589d4357f3aeb7e50a88428d138`.
2. Run Windows on that commit and put the log in `logs/`.
3. Do not merge before that commit is the one this verdict passed. N41 can ship as a follow-up and does not block the merge. N40 is withdrawn.

## Limitations

- No testnet transaction was submitted. The 180, 43/43, 72/72, and 31/31 figures are the logs, plus read-only confirmation of the eight demo hashes.
- The JCS fuzz covered the cases listed above, not every Unicode scalar. The two SDKs matched on every case that was run.
- The full unit suite under the address-binding mutation was stopped after `job-spec.test.ts` had already reported the vector failure. The source was restored and the tree hash checked again.

## Artifacts

- `/opt/cursor/artifacts/VERDICT-phase6.md` (this file)
- `/opt/cursor/artifacts/phase6-repro/jcs-fuzz.txt`, `edges.json`, `tx-lookups.json`
- `/opt/cursor/artifacts/phase6-repro/test-unit.txt`, `pytest.txt`
- `/opt/cursor/artifacts/phase6-repro/mut-hash.txt`, `mut-fund.txt`, `mut-edit.txt`, `mut-chain.txt`, `mut-share.txt`, `mut-bind.txt`, `mut-bind-full.txt`
