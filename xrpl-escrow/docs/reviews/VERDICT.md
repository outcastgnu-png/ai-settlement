# Verdict: N41 follow-up (strict spec memo and revision check)

**Reviewer:** Gpno (sole final reviewer named in EDR-014; this review is the work for that review)
**For:** Christopher Terrell
**Date:** 2026-11-26, 1:15 AM CST (2026-11-26 07:15 UTC)
**Verdict:** PASS

No branch was created. Nothing was committed. No file in the repository checkout was modified. No new finding. N41 is resolved. N39 is already closed on main. Gpno independently rebuilt the tree (codeload tarball of `2db925c` plus `git apply` of the full diff, `git add -A`, `git write-tree`: `9e9eb3c7`), and confirmed on the GitHub API that `ac4a483` has tree `9e9eb3c7` and the single parent `2db925c`, and that tag `v0.6.0` points at `2db925c`.

## Inputs

| Item | Value |
|---|---|
| Base | `2db925c0bb8002ad51c248523495741497b23399`, tree `d244ee5b07ec3ff6e367dc88dfe2b6d909e7a6ca`. This is the `v0.6.0` tag and the merge of PR #17. |
| Passed Phase 6 code | `e7ed6ca` has tree `522d7489e467f589d4357f3aeb7e50a88428d138`, the tree the Phase 6 verdict passed. `2db925c` is that tree plus the evidence commit `2bb06f8`: `VERDICT.md`, the archived Phase 5 verdict, and `logs/windows-2026-11-23-e7ed6ca/`. No source file differs from `522d7489`. |
| Full diff | SHA-256 `6e9725553803e42d3927207fa2ee9eeffba2c58cecfbbb7b43679021e525988a`, 11 files. |
| Code diff | SHA-256 `7f1857347338465c36146bfe81331fdf3fe8511c2100439a9f7355487154fb05`, 10 files. Strict subset. The only file left out is `xrpl-escrow/test/vectors/job-spec.json`, and that patch is byte-identical in the full diff. |
| Apply | `git apply --check` and `git apply` both exited 0. No warnings. |
| Resulting tree | `9e9eb3c7ec394bef75e2f43270a1f9e0caab95a7`. **Matches the claim.** Same hash after the mutation checks, once the five source files were restored. |
| Commit | `ac4a483091fa900aac1ec90bbfee5b365f29b7b9` is the tip of `origin/claude/project-thread-o3gsg0`. One parent, `2db925c`. One commit ahead of that parent. Tree `9e9eb3c7`, the same tree this diff produces. |

## What was run

Node v22.23.4. Python 3.12 with `xrpl-py`, pytest, and pycryptodome installed for this run. No testnet transaction was submitted. The public testnet `tx` method was tried and is described below. No seed, share, fulfillment, preimage, or key was printed.

| Step | Result |
|---|---|
| `npx tsc --noEmit` | 0 errors |
| `npm run test:unit` | 12 files, **174/174** |
| `python -m pytest` (no `--testnet`) | **72 passed, 2 skipped** |
| Memo differential fuzz | 35 cases, 0 mismatches (`n41-repro/memo-fuzz.txt`) |
| Sources reverted to `2db925c`, tests and vectors kept | vitest on the two spec files: **3 failed, 30 passed**. pytest `test_job_spec.py`: **2 failed, 14 passed** |
| Seven guard mutations | each named test failed. Sources restored. Tree hash unchanged |
| `npm test`, `demo:phase6`, `pytest --testnet` | **Not run.** Not a finding. Merge gate below |

The three vitest failures on the old sources are the strict-memo test, "an oracle refuses a registry spec whose hash is not the one locked on the ledger" (that test now also asserts the wrong revision), and "one oracle is given a different spec" (that test now asserts the verdict-log revision). The two pytest failures are `test_spec_memos_with_another_format_or_non_canonical_json_are_refused` and `test_the_sdk_refuses_a_memo_with_the_verdicts_hash_but_another_revision`. That matches the claim of 3 and 2. The third vitest name is the shared-job test that holds the new assertion, not a separate test title.

**Mutations** (one guard removed, then restored):

| Guard removed | Test that failed |
|---|---|
| `memo.revision !== spec.revision` in `specAgainstMemo` | "an oracle refuses a registry spec whose hash is not the one locked on the ledger" |
| `memo.revision !== verdict.specRevision` in the TypeScript SDK | "one oracle is given a different spec: it refuses, the other two still release" |
| the same compare in `kit.py` | `test_the_sdk_refuses_a_memo_with_the_verdicts_hash_but_another_revision` |
| MemoFormat check in `parseSpecMemo` | the N41 strict-memo vitest |
| MemoFormat check in `parse_spec_memo` | the N41 strict-memo pytest |
| `jcs(memo) !== text` in `parseSpecMemo` | the N41 strict-memo vitest |
| `jcs(parsed) != text` in `parse_spec_memo` | the N41 strict-memo pytest |

## N41

Resolved. The three revision compares are in place, and the memo parsers in both languages require the format and the canonical bytes.

| Check | Where |
|---|---|
| Registry spec versus the memo the oracle read | `spec-ledger.ts` 87: `memo.specHash !== hash \|\| memo.revision !== spec.revision` |
| Verdict versus the memo, TypeScript | `sdk/index.ts` 380–385: hash, then `read.memo.revision !== verdict.specRevision` |
| Verdict versus the memo, Python | `kit.py` 270–274: hash, then `read["memo"]["revision"] != verdict.get("specRevision")` |
| MemoFormat and canonical MemoData, TypeScript | `job-spec.ts` 295–310. Format must be hex of `application/json`. After the field checks, `jcs(memo)` must equal the decoded MemoData |
| Same rules, Python | `job_spec.py` 299–318 |

`specMemos` / `spec_memos` already write that format and that canonical JSON (`job-spec.ts` 274, `job_spec.py` 277–278). Every memo in `job-spec.json` and every `specMemos()` of a vector spec parses back in both languages. Uppercase, lowercase, and mixed-case hex of the same memo all parse. Rippled's hex is uppercase; the parsers accept either case because they decode the hex before comparing the text (`[0-9A-Fa-f]` in both, and `Buffer.from` / `bytes.fromhex`).

The seven `strictBadMemos` are refused by both parsers, and the problem text contains the vector's `problem` word (`format` or `canonical`): missing format, `text/plain`, format that is not hex, a duplicate `revision` key, a duplicate `specHash` key, spaces, and keys out of order. The four older `badMemos` are refused by both. A second spec memo is refused. A memo of another type sitting beside one spec memo is ignored, and the spec memo is still accepted.

Extra cases both languages judge the same way: revision `2^53` refused, `Number.MAX_SAFE_INTEGER` accepted when the JSON is canonical, a `\u0030` escape inside the hash refused, a raw U+2028 inside the hash refused, and a `\u00e9` escape inside the hash refused. No case was accepted by one parser and refused by the other.

## Vectors

`git diff --numstat 2db925c ac4a483 -- xrpl-escrow/test/vectors/job-spec.json` is `95 0`. No line was removed. The only new key is `strictBadMemos` (those seven). Every other key (`note`, `parties`, `oracle`, `jcs`, `refusedJcs`, `specs`, `problems`, `signatures`, `memos`, `rules`, `log`) is equal to the `2db925c` file. Three of the four `badMemos` gained `MemoFormat`. The fourth already had it. Their `MemoType` and `MemoData` are unchanged. The claim said MemoFormat was added to all four. It was added to the three that lacked it. This is a wording slip in the brief, not a finding.

## Other memo types

Keep accepting other memo types beside the spec memo. **Not blocking.**

A memo counts only when its type decodes to `xrpl-escrow/job-spec`. A second memo of that type is refused. Any other type is skipped before the format and the JSON are read, so it cannot change the hash or the revision the oracle and the SDK check. A wallet that adds its own memo would otherwise make a valid job unverifiable. Tightening this to "the transaction may contain only the spec memo" would not close a hole in the hash or the revision check.

## N39

Closed on main, in the tree this follow-up is based on. `docs/THREAT_MODEL.md` line 76, in the k-of-n row, says the TypeScript SDK zeroes the secret, the shares, and the coefficients, and that the Python SDK cannot because `bytes` cannot be overwritten. It cites N39. This diff does not touch that file. The sentence is already in `522d7489` and in `2db925c`.

## Ledger memos

`https://s.altnet.rippletest.net:51234` reports `complete_ledgers` `7-6144`. The Phase 6 demo hashes, which were on ledgers around 22536760, return `txnNotFound`. The testnet has been reset, so those transactions cannot be read live.

The demo's saved rippled responses are still in `xrpl-escrow/logs/2026-11-23-phase6-txs.json` (uppercase hex, `MemoFormat` present, four `EscrowCreate`s). The new parser accepts all four as saved, and accepts them again with that hex lowercased. That is the same byte string the ledger returned when the demo ran. It is not a live read.

## Before merge

Do not merge `ac4a483` until a Windows run of that commit is in `logs/`. `npm test`, `npm run demo:phase6`, and `pytest --testnet` were not run for this change (the author's cloud proxy returned 502, and this review did not run them). That is a merge gate, not a defect in the memo code. The public testnet no longer has the old Phase 6 transactions, so a new Windows or Linux testnet run has to create its own.

## Artifacts

These are on the review agent's VM, not in the repository.


- `/opt/cursor/artifacts/VERDICT-n41.md` (this file)
- `/opt/cursor/artifacts/n41-repro/test-unit.txt`, `pytest.txt`, `memo-fuzz.txt`
- `/opt/cursor/artifacts/n41-repro/before-vitest.txt`, `before-pytest.txt`
- `/opt/cursor/artifacts/n41-repro/mut-rev-oracle.txt`, `mut-rev-sdk.txt`, `mut-rev-py.txt`, `mut-fmt-ts.txt`, `mut-fmt-py.txt`, `mut-canon-ts.txt`, `mut-canon-py.txt`
