# Verdict: ESCROW-001 Phase 5 (EDR-015, shared verification)

**Reviewer:** Gpno (sole final reviewer named in EDR-014; this review is the work for that review)
**For:** Christopher Terrell
**Date:** 2026-11-18, 2:27 AM CST (2026-11-18 08:27 UTC)
**Verdict:** PASS WITH FINDINGS

This review is of the uncommitted tree produced by applying `phase5-since-4ccc8ec.diff` to `4ccc8ec`. No branch was created. Nothing was committed. No file in the repository checkout was modified.

No single oracle, the registry, or a client calling the oracle routes can turn fewer than k honest passes into a fulfillment. The share route, the verify route, Shamir, the box, and the registry count do what EDR-015 asks. Two non-blocking findings: the N37 merge was not only the log and the verdict (N38), and the Python secret is not wiped and that limit is not in the threat model (N39).

## Inputs

| Item | Value |
|---|---|
| Base | `4ccc8ecbdec4ba88a0b8237eaa3e3db153f7fe0b`, tree `86e351db193d4920013f8bed74fff9730e2387a3`. Merge of PR #11, 2026-11-18 1:28 AM CST (07:28 UTC). |
| Full diff | SHA-256 `2b931ff49e7e9f151d8b00d908cfa37fbdc4fc3c59f7cc215eded044093c3013`, 49 files. |
| Code diff | SHA-256 `c6130f0d0f320763a83585125049711496de83054ded4f2ab96c0353fd2b258d`, 38 files. Strict subset: every code-diff path is in the full diff and those patches are byte-identical. The other 11 files are logs and `shamir.json` / `share-box.json`. |
| Apply | `git apply --check` and `git apply` both exited 0. One warning: trailing whitespace on diff line 217 (`E`). It did not reject the patch. |
| Resulting tree | `8f9db84877ab5625cbd2eff1eead900e0dc0ef15`, from `git add -A` and `git write-tree` in `/tmp/p5`. **Matches the claimed hash.** No commit. The same hash was returned after the mutation checks, once the four source files were restored. |
| `verdict-log.json` | Blob `188305073f18a987b58b6f61c087d3eecd222558` on both `4ccc8ec` and this tree. Existing verdict-log vectors are unchanged. |

## What was run, and what was only claimed

Node v22.23.4, npm 10.9.9, Python 3.12.3, pytest 9.2.0. No testnet connection, faucet, or demo was run. No seed, share, fulfillment, or preimage was printed.

| Step | Result | Status |
|---|---|---|
| `npx tsc --noEmit` | 0 errors | Reproduced |
| `npm run test:unit` | 10 files, **141/141** | Reproduced. Matches the claim (114 plus 27 in `test/shared.test.ts`) |
| `python -m pytest` (no `--testnet`) | **55 passed, 2 skipped** | Reproduced. Includes `test_shared_vectors.py` (12) and `test_verdict_log.py` (13) |
| Crypto and registry repro | `phase5-repro/crypto-output.txt` | Reproduced |
| Four mutation spot-checks | each new or adjacent test failed | Reproduced |
| `npm test` 147/147, `demo:phase5` 39/39, `pytest --testnet` 56/57 then a rerun, Python demo 24/24 | The logs in the diff say this | **Claimed only** |
| Windows on this tree | — | **Not run.** Blocks the merge, not this verdict, same split as N31 |

The `pytest --testnet` run1 log fails one check: "provider gains the price minus the finish fee +4.793262 XRP". The assertion is `4.99 < gained <= 5` (`demo_phase5.py` 114) on a 5 XRP job, so the fee must be under 0.01 XRP. 4.793262 XRP gained is a fee of 206,738 drops. That matches the brief. The rerun log of that test alone is in the diff and the brief says it passed. Leaving the bound is acceptable: it is a smoke check for a normal testnet fee, the product still paid the provider, and widening it would hide a real overcharge. It is not a Phase 5 defect.

## N37 merge (process)

**N38 — N37 was merged before the Windows log was confirmed**

**Status:** New
**Severity:** Process
**Blocks Phase 5:** No

**Where:** History on main, not this diff. `c8e72fc` (2026-11-18 12:37 AM CST / 06:37 UTC) has tree `373baa5e879722159be2ebce30512ce2c58df7b4`, the tree the N37 verdict passed. `3f24db2` (2026-11-18 1:26 AM CST / 07:26 UTC) adds the Windows run and the verdict. `4ccc8ec` merges it at 2026-11-18 1:28 AM CST (07:28 UTC), about two minutes later.

**What `3f24db2` changes:** Not only `logs/` and `VERDICT.md`. It also changes `xrpl-escrow/docs/reviews/FINDINGS_RESPONSE.md` (4 lines) and adds `VERDICT-2026-11-15-phase4-r4-pass.md`. No file under `src/`. `VERDICT.md` in that commit is SHA-256 `954f249f2d17d5d387c45071a174671756cc9e680de749f6f82355c693f48054`, the same as the attached N37 PASS verdict.

**Windows log:** `logs/windows-2026-11-18-c8e72fc/` names commit `c8e72fc` and tree `373baa5e…`. Counts in the files: typecheck 0, unit 114/114, finality 12/12 five times, `npm test` 119/119, demo 28/28, pytest 39 passed and 1 skipped, pytest testnet 40, Python demo 16/16. Those are the N37-tree counts (unit 114 was reproduced here on that earlier review). A search of that directory found no seed assignment, fulfillment string, or preimage. The summary's only hit is the sentence that says the scan found no `SEED=` line. The run copied `.env` and `data/` from the earlier anchor `raU1zQN3…`, so it continued one log rather than starting a second chain on that wallet.

**Impact:** The merge happened before Gpno confirmed the Windows log. The log itself matches the passed tree and shows no failure. The extra files are the findings note and the archived r4 verdict, not code.

**Resolution:** None for Phase 5. Future evidence commits should say, in the request, that the findings file and the archive go with the verdict.

## Phase 5

These were checked in the source and, where noted, by the offline repro or the 141.

| Question | Result |
|---|---|
| Share route | Draft only for a new share (`server.ts` 240). Body index and the opened share's `x` must be this oracle's index, `findIndex` of its verdict address plus one (217–234). The same bytes already in the vault return `{stored: true}` (236–237). A different share is 409. The client signs the canonical box (221). |
| Verify route | A share is returned only when the stored verdict is pass (340). `ORACLE_FAULT=fail` forces `pass: false` before signing (307–312) and any other value is rejected at startup (362). There is no always-pass setting. `payloadHash` for a shared verify is this oracle's address (254), so the same signature does not verify at another oracle. The first logged verdict is still final (277–285). |
| Fewer than k | `combineForCondition` returns null below k (`sdk/index.ts` 135). Repro: one share is null; two of a 2-of-3 set rebuild a fulfillment. `combine` throws on one share, `x` 0, a repeated `x`, and a short hex string (`crypto-output.txt`). |
| Outside set / wrong position | Both throw. Repro confirmed. Dropping the outside-set throw makes "never uses a share from an oracle outside the set" fail. |
| Registry count | One pass of k=2 stays `delivered`. The second pass from another oracle moves to `verified_pass`. A second different verdict from the first oracle is 409. An address outside the set is 403. A verdict with the wrong `shareIndex` is 400. The oracle bearer token setting `verified_fail` on that shared job is 409 (`registry` in the repro). `fails > n - threshold` is `n - k + 1` (`registry/server.ts` 172–173). Passes and fails cannot both cross the line: that would need at least `n + 1` verdicts. |
| k=1, k=n, n≤7 | k below 2 is rejected in Shamir (`shamir.ts` 54) and in the registry (`server.ts` 60). k=n is allowed. `MAX_ORACLES` is 7 (39). n=255 is the field maximum and is not what the registry accepts. |
| Shamir | GF(256), reduction `0x11B`, generator 3, `x` is 1..n. `gfMul(0x53, 0xca)` is `0x01`. Any two of three shares rebuilt the 32-byte secret. Coefficients come from `randomBytes` unless a test passes a fixed source, and the buffer is zeroed after the split (79). |
| Share box | HKDF salt is ephemeral public \|\| oracle public, info and GCM AAD are `xrpl-escrow/share/v1\|jobId\|oracle\|index` (`share-box.ts` 39, 65–82, 99–104). Opening the same box for another job is rejected. The share-key statement is `{purpose, oracle, shareKey}` and `verifyShareKey` requires the verdict key to belong to the pinned address (127–130). An all-zero X25519 public key throws in Node (`Provider routines::failed during derivation`) before a box exists. |
| URLs | `^http://127\.0\.0\.1:[0-9]{1,5}$` (`registry/server.ts` 40, 54). `http://evil.example:8802` is 400. Duplicate address, anchor, or URL is rejected (57–58). |
| N36 | The 0.3.x 409 applies only when `!shared` (`server.ts` 289). The test "an oracle asked after the set has decided still verifies" is in the 141. |
| Unanchored default | `requireAnchored` defaults false. The provider then sets `allowUnanchored: true` and `requireAnchor: false` (`sdk/index.ts` 477). A verdict still needs a valid signature, a chain that checks, and every anchor the lookback actually returned to agree; an incomplete lookback still fails the log check (N32). `requireAnchored: true` sets the opposite flags. That is the choice recorded on 2026-11-18 1:34 AM CST (07:34 UTC), and it does not skip the anchors that are already on the ledger. |
| Setup of B and C | `setupOtherOracles` copies `ORACLE_SERVICE_TOKEN` only (`wallets.ts` 84–91). `ensureLocalSecrets` with `oracleOnly` does not write `WATCHER_SERVICE_TOKEN` (`local-config.ts` 53–64). Each file gets its own vault key, share key, and verdict seed when those lines are absent. |
| Secrets in logs and responses | The new Phase 5 logs have no `SEED=`, vault key, share key, or preimage assignment. The verify response returns a share only on that oracle's pass, and the registry never stores one (`FORBIDDEN_KEYS` includes secret, fulfillment, and preimage). |

**Mutation results** (throwaway edits, then restored):

- Returning the share on a fail: "two pass and one fails" and "bad work fails at every oracle and no share is released" both fail.
- Accepting an outside-set share: "never uses a share from an oracle outside the set, or at another position" fails.
- Counting `threshold - 1` as a pass: "one passes and two fail: no fulfillment, the job is verified_fail" fails.
- Dropping both `setAAD` calls: "open what was sealed to this key…" and the share-box vector test fail.

### N39 — Python does not wipe the secret, and the threat model does not say so

**Status:** New
**Severity:** Low
**Blocks Phase 5:** No

**Where:** `xrpl-escrow-py/src/xrpl_escrow/kit.py` 338–341 (`del secret` only). `shamir.py` 72 leaves coefficient bytes. `xrpl-escrow/src/sdk/index.ts` 407 and 429–431 zero the buffers. `docs/THREAT_MODEL.md` has no sentence about Python memory. The k-of-n row describes collusion, one machine, the client knowing the secret, unanchored verdicts, and `ORACLE_FAULT`. It does not mention the wipe.

**Repro:** Read those lines. There is no runtime wipe to print. `bytes` cannot be overwritten in place; `del` drops the name only.

**Impact:** After `create_shared_job`, a copy of the secret can remain in that process until the allocator reuses the memory. This is the client's own process, on a testnet preview, and the client is already supposed to know the secret. It is not a way for one oracle to learn k shares.

**Resolution:** Add one sentence to the k-of-n row, and to the Python README, that Python does not wipe the secret or the shares. The TypeScript side already does.

## Earlier findings

| Finding | Status | Blocks this merge |
|---|---|---|
| N25–N30, N32, N33, N36 | Closed. The unit file and the verdict-log vectors that lock them passed, and `verdict-log.json` is the same blob as on `4ccc8ec`. | No |
| N31 | The Windows log for `c8e72fc` is now on main. It does not block Phase 5. A Windows run of the Phase 5 commit still blocks the merge, not this verdict. | Merge only |
| N34 | Satisfied so far: this tree is uncommitted and unmerged. | No |
| N35 | Closed. `v0.4.0` is `abd8b52`, not `b5f36bf`, `b8872321`, or `6cf7d44`. | No |
| N37 | Closed on main by `c8e72fc`, and the second-entry check is still in this tree (`verdict-store.ts` 76–79). | No |

## Before merge

1. Commit exactly this tree. `git diff 4ccc8ec <commit>` must be this 49-file diff, and the tree must be `8f9db84877ab5625cbd2eff1eead900e0dc0ef15`.
2. Run Windows on that commit and put the log in `logs/`.
3. Do not merge before that commit is the one this verdict passed. N39 can ship as a documentation follow-up; it does not block the merge. N38 needs no code change.

## Limitations

- No testnet, faucet, or demo was run. The 147, 39/39, 56/57, and 24/24 figures are the logs only.
- The all-zero X25519 point was rejected by Node's own derivation. The other seven low-order points, and Python's `key_agreement`, were not tried one by one. There is no explicit zero-check in `share-box.ts` beyond what the library throws.
- The cloud oracle's older log was not re-counted.

## Artifacts

- `/opt/cursor/artifacts/VERDICT-phase5.md` (this file)
- `/opt/cursor/artifacts/phase5-repro/crypto.ts` and `crypto-output.txt`
- `/opt/cursor/artifacts/phase5-repro/test-unit.txt` and `pytest.txt`
- `/opt/cursor/artifacts/phase5-repro/mut-share.txt`, `mut-outside.txt`, `mut-count.txt`, `mut-aad.txt`
