# Verdict: ESCROW-001 Phase 1 and Phase 2

**Reviewer:** Gpno
**Date:** 2026-10-20
**Commit reviewed:** deb71ea351fd40cfa61e6485e522d567df6d3327 (main; baseline ed122ab)
**Verdict:** PASS WITH FINDINGS

**Contingency:** This verdict is PASS WITH FINDINGS only if Christopher fixes or explicitly waives findings 1 and 2. Otherwise the verdict is **FAIL**, because `docs/reviews/REVIEW.md` defines FAIL as "a hard rule or an EDR requirement is not met," and findings 1 and 2 are unmet EDR requirements.

## Summary

The code meets every hard rule. It runs on testnet only: every connection goes through `connectTestnet()`/`assertTestnet` (network_id 1), and there is no mainnet URL anywhere. All services bind to 127.0.0.1 only. The registry never stores the secret, and the vault uses AES-256-GCM with a random IV, the auth tag and the job id as associated data. The fulfillment is released only on a pass, and only to a fresh, valid signature from the job's provider. Deliverables are only hashed or `JSON.parse`d, never executed. Typecheck is clean and 44/44 unit tests pass on Node 22. Governance has gaps: neither EDR has been accepted by name, EDR-011 is missing, and the required branches don't exist. The documented Node 20 support is broken. Two known gaps were reproduced and must be fixed before Phase 3: forged "ledger" events in the registry and ReDoS through Ajv.

## Findings

List the most severe first. Remove this section if the verdict is PASS.

| # | Severity (blocker / major / minor / nit) | File:line | Problem and a concrete failure scenario | Suggested fix | Blocks Phase 3? |
|---|---|---|---|---|---|
| 1 | blocker (governance) | `edr/EDR-012_ESCROW_PHASE2_ORACLE_REGISTRY.md` (Status); `edr/` | EDR-012 still reads "Proposed" and says it "does not govern until the owner accepts it by name." It depends on EDR-011 being Accepted with a Phase 1 verdict, but EDR-011 isn't in the repo (REVIEW.md: "not in the repo yet"). EDR-012 also still names Codex as reviewer. The build ran under records that don't govern. | Christopher adds EDR-011 to `edr/`, accepts EDR-011 and EDR-012 by name, and records Gpno as reviewer (or waives this explicitly). | Yes |
| 2 | blocker (governance) | git history (`main` only: `ed122ab`, `deb71ea`) | EDR-011 and CLAUDE_PHASE2.md require branches `escrow/001-testnet-demo` and `escrow/002-oracle-registry`. Only `main` exists, and both phases arrive as one baseline commit, so the Phase 1→2 diff was rebuilt after the fact. The repo is `C:\dev\ai-settlement\`, separate from PersonalAi. Claude committed, and no explicit approval for that is on record (CLAUDE.md: "Do not commit… without Christopher's explicit approval"). | Christopher confirms the separate repo is intended and that the commits were approved, or recreates the branches (or waives this explicitly). | Yes |
| 3 | major | `xrpl-escrow/package.json` (`engines`); `README.md`; `docs/reviews/REVIEW.md` | The docs say "Node 20 or newer." On Node 20.19.2, `npm ci` fails: better-sqlite3@13 needs node >=22, vitest@5 needs ^22.12, and the native build fails. A Windows user following the quickstart on Node 20 can't install. | Set `engines.node` to `>=22.12` and update README and REVIEW.md. | Yes |
| 4 | major | `xrpl-escrow/src/registry/server.ts` (`applyEvent`, `POST /jobs/:id/events`) | Any local process can post `{source:"ledger"}`. Reproduced: a forged `funded` was accepted (offerSequence 999999, createTx "FAKE") with no escrow on the ledger, then a forged `refunded` closed the job and reputation counted it. On a really funded job, a forged `refunded` makes it terminal. The watcher then ignores it, and `/deliverable` rejects new work, so the provider can't get a verdict and the client is refunded at CancelAfter. | Authenticate watcher and oracle events (shared service token or signed events), and have the oracle confirm the escrow on the ledger before releasing the fulfillment. | Yes |
| 5 | major | `xrpl-escrow/src/oracle/checks/json-schema.ts` (`new Ajv({ strict: true })`, `compiled` Map) | Client-supplied schemas are compiled with the native JS RegExp. Reproduced with pattern `^(a+)+$`: 55 / 83 / 672 ms at lengths 20 / 24 / 27, roughly doubling per character. Checks run synchronously in the single oracle process, so one hostile job freezes verification for every job and can push other providers past CancelAfter. The compiled-schema cache is unbounded. | Use `code: { regExp: re2 }` or ban `pattern`/`patternProperties`, cap schema size, bound the cache, and run checks in a worker with a timeout. | Yes |
| 6 | minor | `xrpl-escrow/src/auth.ts`; `src/oracle/server.ts`; `src/oracle/checks/max-latency.ts`; `src/sdk/index.ts` (`verifyVerdict`); `src/local-config.ts` (`VERDICT_LOG`) | Replay protection is an in-memory signature set, lost on restart. The verdict signing key is the oracle's wallet seed. The fulfillment travels over plain HTTP. `max-latency` uses the registry's `fundedAt`, which finding 4 can forge. `verifyVerdict`'s `oracleAddress` is optional, and the SDK takes it from the unauthenticated `/health`. `verdicts.jsonl` is under `src/`. | Persist replay state; use a separate verdict key; pin the oracle address in config; use ledger close time for latency; move the log to `data/` or `logs/`. | Partly (the auth and latency items) |
| 7 | nit | `xrpl-escrow/runs/2026-10-20-testnet.txt`, `logs/2026-10-20-phase2.txt` | The public testnet servers keep only recent history, so neither phase's tx hashes can be looked up now. The Phase 2 hashes were confirmed validated earlier on 2026-10-20 (9/9, results as logged). The Phase 1 accounts exist and show activity. The logs are now the only full record. | Save the tx JSON (or explorer snapshots) alongside the run logs in future runs. | No |

## What I ran

| Command | Expected | Result |
|---|---|---|
| `npm run typecheck` | 0 errors | 0 errors (Node 22.23.3) |
| `npm run test:unit` | 44/44 | 44/44 passed (5 files, 2.7 s) |
| `npm run demo` | 18/18 | Not run; log reviewed (18/18 in `runs/2026-10-20-testnet.txt`) |
| `npm run demo:phase2` | 47/47 | Not run; log reviewed (47/47; 9/9 tx hashes confirmed validated on testnet earlier on 2026-10-20) |
| `npm test` | 46/46 | 44/44 unit tests only; the 2 testnet flow tests were not run |

`npm ci` on Node 20.19.2 failed (finding 3). On Node 22.23.3 it passed, and `npm audit` found 0 vulnerabilities. Separate scripts in a scratch copy reproduced findings 4 and 5.

Operating system and Node version: Linux (shared review box), Node 22.23.3, npm from that Node 22 install (Node 20.19.2 / npm 11.21.0 failed `npm ci`).

Anything you could not run, and why: `npm run setup`, `npm run demo`, `npm run demo:phase2` and the two testnet flow tests in `npm test` were not run, by instruction (no `.env` secrets, no new testnet transactions). Windows was not available to the reviewer.

## NOT DEMONSTRATED items

For each item, say whether you confirmed it, it is still open, or it is not needed:
- Windows run: Still open. Not run. All 50 tracked files are LF, there is no `.gitattributes`, and the `src/services.ts` spawn uses no shell, so no blocker is visible. Node >=22.12 is required (finding 3).
- README quickstart: Still open. Not driven by hand. It fails as written on Node 20 (finding 3).
- `expired_unclaimed` on testnet: Still open. Covered by unit tests only; the logic in `src/watcher.ts` `eventsForLedger` reads correctly.
- Watcher reconnect: Still open. The resubscribe-on-`connected` code is present in `src/watcher.ts` but has never been exercised.
