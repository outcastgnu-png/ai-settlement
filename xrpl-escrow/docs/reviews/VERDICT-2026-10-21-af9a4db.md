# Verdict: ESCROW-001 second review (fixes for findings 3 to 7)

**Reviewer:** Gpno
**Date:** 2026-10-21
**Commit reviewed:** `af9a4db` (main; previous verdict on `deb71ea`; handoff docs on top in `e54e6d8`)
**Verdict:** PASS WITH FINDINGS

The first verdict, on `deb71ea`, is kept as [`VERDICT-2026-10-20-deb71ea.md`](VERDICT-2026-10-20-deb71ea.md).
Fill this file in. The brief for this review is the "Second review" section of [`REVIEW.md`](REVIEW.md).

## Summary

Findings 3, 4 and 7 are fixed. Finding 6 is fixed in its listed parts, except plain HTTP, which is documented. Finding 5 is only partly fixed. Every hard rule still holds: testnet only with the `network_id` guard, 127.0.0.1 only, no secret in the registry, and the fulfillment released only on a pass to a signed provider request after a ledger escrow check. Typecheck is clean, and 52/52 unit tests pass on Node 22. Node 20 now fails `npm ci` with a clear EBADENGINE message. Each new test fails when its fix is reverted (mutation-checked). Two new bypasses were found, and both must be fixed before Phase 3. First, the schema policy still allows an exponential-time schema made of nested `anyOf` with local `$ref`s and no regex (N1). Second, the replay guard can be bypassed by changing the hex case of the signature (N2). Findings 1 and 2 are recorded in the repo. Christopher closed them, and I don't reopen them. Three process items remain (N3–N5).

Findings 1 and 2, as recorded: `edr/EDR-011_ESCROW_PHASE1_TESTNET_DEMO.md` and `edr/EDR-012_ESCROW_PHASE2_ORACLE_REGISTRY.md` both read Status "Accepted". `edr/ACCEPTANCES.md` records "I accept EDR-011 and EDR-012, reviewer Gpno" at 2026-10-20 17:04 UTC. EDR-011 is present. `git branch -a` shows only `main`, and the per-phase branches are recorded as waived ("Keep history", 16:41 UTC) in EDR-011 and REVIEW_HANDOFF.md.

## Findings from the first review

| # | Status (fixed / not fixed / partly) | Evidence | Blocks Phase 3? |
|---|---|---|---|
| 3 | fixed | `package.json` `"node": ">=22.12"`, `.npmrc` `engine-strict=true`. On Node 20.19.2, `npm ci` exits 1 with `EBADENGINE … Required: {"node":">=22.12"}`. On Node 22.23.3 it installs, with 0 vulnerabilities. README and REVIEW.md say 22.12. | No |
| 4 | fixed | `checkBearer` (constant-time, SHA-256 digests) on `PUT /jobs/:id/condition` and `POST /jobs/:id/events`. Probed against a scratch registry: a ledger event with no token got 401, with the oracle's token 401, with a token one byte off 401; a condition with no token 401; an oracle-source event with the watcher's token 401; a missing source 400; only the correct watcher token was accepted. The oracle's `ledgerEscrowCheck` reads `ledger_entry` (validated) and compares destination, amount, condition and CancelAfter before releasing anything (409 otherwise). Reverting either fix fails a test. | No |
| 5 | partly | `src/schema-policy.ts` refuses `pattern` at the top level and under `$defs`, `definitions`, `items`, `allOf`, `if/then`, `propertyNames` and `dependencies`; refuses `patternProperties`, `uniqueItems`, `format` and non-local `$ref` (URL or relative); refuses a 17 KB schema and 33 nesting levels. A property *named* `pattern` is allowed. The cache is bounded at 256. **Bypass:** see N1. A 1.4 KB, policy-allowed schema takes exponential time. | Yes (N1) |
| 6 | fixed, with a new gap | `ReplayGuard` persists to `data/oracle-replay.json`: replaying the same request after a restart gives 401 "auth already used". Verdicts are signed with a separate ed25519 `ORACLE_VERDICT_SEED`. `verifyVerdict` requires the pinned address, and the SDK reads `ORACLE_VERDICT_ADDRESS` and no longer calls `/health`. `fundedAt` is the ledger close time and needs the watcher token. The verdict log moved to `data/verdicts.jsonl`. Plain HTTP on 127.0.0.1 is unchanged and documented. High-S secp256k1 signatures are rejected. **New gap:** N2. | Yes (N2) |
| 7 | fixed | `logs/2026-10-20-phase2-fixes-txs.json` holds 9 validated transactions, and their hashes are identical to the 9 unique hashes in `logs/2026-10-20-phase2-fixes.txt` (49 PASS lines, "49/49 checks passed"). `demo-phase2.ts` moves to a new `-N` base name rather than overwriting an existing log. | No |

## New findings

| # | Severity | Where | What | Fix | Blocks Phase 3? |
|---|---|---|---|---|---|
| N1 | major | `src/schema-policy.ts`; `src/oracle/checks/json-schema.ts` | Exponential validation without any regex. `$defs` s0 = `{type:"string"}`, sK = `{anyOf:[{$ref:"#/$defs/s(K-1)"},{$ref:"#/$defs/s(K-1)"}]}`, root `$ref` to sN. The policy allows it (1.4 KB at N=22), and the registry would accept it too. Validating the deliverable `1` took 80 / 175 / 566 / 3884 ms at N = 16 / 18 / 20 / 22, so N≈30 would block the single-threaded oracle for minutes, and N≈40 for far longer. This defeats the goal of finding 5. | Run checks in a worker with a hard timeout (the gap already noted in FINDINGS_RESPONSE.md). Also limit `$ref` count and fan-out, or reject `$ref` cycles and reuse, and cap the total size of the combinator tree. | Yes |
| N2 | major | `src/auth.ts` `checkRequest` / `ReplayGuard.use` | The replay key is the raw signature string, but `verify` accepts the same signature in lowercase (and in any mixed case). A captured signed `verify` request replayed with `signature.toLowerCase()` was ACCEPTED (ed25519 and secp256k1 both tested). Any of the 2^k case variants works within the 2-minute window, and each replay returns the fulfillment. On 127.0.0.1 an attacker would first have to see the request. | Normalize the signature (uppercase, and canonical DER) before the replay check, or key replay on `sha256(publicKey | action | jobId | timestamp | payloadHash)`. Add a test. | Yes |
| N3 | medium (process) | `edr/EDR-011_ESCROW_PHASE1_TESTNET_DEMO.md`; `edr/ACCEPTANCES.md` | ACCEPTANCES.md says "No EDR-011 document existed before 2026-10-20" and that EDR-011 was written down at 17:10 UTC, six minutes *after* the 17:04 acceptance. A Proposed EDR-011 drafted for Christopher on 2026-10-20 did exist outside the repo. The repo version was rebuilt from `CLAUDE.md` and differs from it. It drops these: the boundary forbidding contact with the XRP Intelligence Core (`xrp_*.py`, `decision/`, `frozen_xrp_engine/`, `live_shadow/`, `data/xrp_brain.db`); the `Agents.md` A3 "data channel is not control channel" boundary; "a Gpno review verdict is recorded"; and "merge and push need separate owner approval". The accepted text is therefore ambiguous. | Christopher confirms which EDR-011 text he accepted. Either restore the dropped clauses or record that dropping them is intended. | No (governance) |
| N4 | medium (process) | commit `e54e6d8` | Claude committed `e54e6d8` citing "Handoff requested by Christopher 2026-10-21 05:12 UTC ('Gpno reviews the fixes')". That is a review request, not commit approval. The approval quoted for `af9a4db`, "Yes proceed" (05:07 UTC), came before this commit and covered the fixes. CLAUDE.md and EDR-011: "No commit, merge or push without Christopher's approval." | Christopher approves `e54e6d8` after the fact or has it reverted. Claude asks for explicit commit approval for each commit. | No |
| N5 | minor (process) | `edr/ACCEPTANCES.md`, `REVIEW_HANDOFF.md`, `FINDINGS_RESPONSE.md` | Every approval and waiver ("Keep history" 16:41 UTC, the git-init approval at 08:14 UTC, the 17:04 acceptance, "Yes proceed" 05:07 UTC) exists only as text written by the implementer, in commits by the implementer. Nothing in the repo is signed or authored by the owner. | Christopher commits ACCEPTANCES.md himself, or signs it off. | No |
| N6 | nit | `xrpl-escrow/.gitignore`; root `.gitignore` | `node_modules` is listed twice. The explicit `verdicts.jsonl` ignore lines were removed. That's fine, since `data/` now covers the log, but an old `src/oracle/verdicts.jsonl` from earlier runs would no longer be ignored. | Remove the duplicate line, and keep or delete the old path. | No |
| N7 | info | `docs/ESCROW-001_EARNED_STATUS.md` | EDR-011 and EDR-012 continue PersonalAi's EDR numbering but live only in `ai-settlement/edr/`. The document itself notes that they aren't tier-3 governance in PersonalAi. Numbers may collide later. | Use a separate prefix (for example AS-EDR-) or reserve the numbers in PersonalAi. | No |

## What I ran

Linux (shared review box). Node 22.23.3 for the build and tests; Node 20.19.2 for the engine check. All runs used a scratch copy of the repo, with no `.env`, no secrets and no testnet transactions.

| Command | Expected | Result |
|---|---|---|
| `npm ci` (Node 20.19.2) | fails clearly | exit 1, `EBADENGINE`, "Required: {"node":">=22.12"}" |
| `npm ci` (Node 22.23.3) | installs | OK, 0 vulnerabilities |
| `npm run typecheck` | 0 errors | 0 errors |
| `npm run test:unit` | 52/52 | **52/52 passed** (5 files, 2.9 s) |
| `npm run demo` | 18/18 | not run (needs testnet and `.env`); Phase 1 code is unchanged since `deb71ea` |
| `npm run demo:phase2` | 49/49 | not run; log reviewed: 49/49, and 9/9 tx hashes in the log match the txs JSON (all validated) |
| `npm test` | 54/54 | not run in full; 52/52 unit tests, and the 2 testnet flows were skipped (optional, need secrets) |

Probes (scratch scripts):
- Token probe: no token, wrong token, one byte off, cross-service token.
- Schema-policy probe: 18 cases plus the anyOf/`$ref` bomb (N1).
- Replay probe: across a restart, high-S, hex-case (N2).
- Mutation check: each fix (bearer, escrow check, schema policy, replay persistence, pinned verdict address, ledger `fundedAt`, bounded cache) was reverted in turn. At least one unit test failed every time.

Anything you could not run, and why: the testnet demos and flow tests, because they would need faucet funding and `.env` secrets (optional and out of scope for this review). Windows was not expected from me; Claude Code runs it separately.

## NOT DEMONSTRATED items
- Windows run: Still open. Christopher assigned it to a separate Claude Code run.
- README quickstart: Still open. Not driven by hand.
- `expired_unclaimed` on testnet: Still open. Unit tests only.
- Watcher reconnect: Still open. Code present, never exercised.
