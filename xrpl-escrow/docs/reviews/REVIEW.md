# Review brief for Gpno: ESCROW-001 Phase 1 and Phase 2

You are the **single final reviewer** for Phase 1 (EDR-011) and Phase 2 (EDR-012). Review only.
Don't change any file except `docs/reviews/VERDICT.md`.

## What governs this work

| Document | Path from the repo root `C:\dev\ai-settlement\` |
|---|---|
| Phase 1 rules (testnet only, the `network_id` guard, seeds, validated ledgers) | `xrpl-escrow\CLAUDE.md` |
| EDR-011, the Phase 1 decision | `edr\` (not in the repo yet) |
| Phase 2 build instructions | `xrpl-escrow\CLAUDE_PHASE2.md` |
| EDR-012, the Phase 2 decision, accepted on 2026-10-20 | `edr\EDR-012_ESCROW_PHASE2_ORACLE_REGISTRY.md` |
| Implementer's handoff: scope, expected results, NOT DEMONSTRATED, known gaps | `xrpl-escrow\REVIEW_HANDOFF.md` |
| Run logs with testnet explorer links | `xrpl-escrow\runs\2026-10-20-testnet.txt` (Phase 1) and `xrpl-escrow\logs\2026-10-20-phase2.txt` (Phase 2) |

The EDR-012 and `CLAUDE_PHASE2.md` copies still say Codex. Christopher has since made Gpno the
reviewer for both phases.

## What to review

Review the whole of `xrpl-escrow\`. To see only the Phase 2 changes, read `docs\reviews\phase2.diff`
(27 files, +2395 / -13).

Suggested order:
1. **Phase 1:** `src/config.ts`, `condition.ts`, `escrow.ts`, `wallets.ts`, `demo.ts`.
2. **Phase 2:** `src/registry/`, `src/auth.ts`, `src/oracle/vault.ts`, `src/oracle/checks/`,
   `src/oracle/server.ts`, `src/watcher.ts`, `src/sdk/index.ts`, `src/demo-phase2.ts`.
3. **Then the tests.**

## How to run it

Run these in PowerShell from `xrpl-escrow\`, with Node 20 or newer:

```
npm ci
npm run typecheck        # expect 0 errors
npm run test:unit        # expect 44/44, no network
npm run setup            # funds 3 testnet wallets from the faucet and writes .env (testnet only)
npm run demo             # Phase 1: expect 18/18 checks
npm run demo:phase2      # Phase 2: expect 47/47 checks; the log goes to logs\<date>-phase2.txt
npm test                 # expect 46/46, including both testnet flows (about 6 minutes)
```

Windows has never been run, so your Windows results are new evidence. Record them either way.

## What to check

1. **Phase 1 hard rules:**
   - The code connects to testnet only, and the `network_id === 1` guard runs on every connection,
     including the watcher's.
   - Wallets are funded only from the faucet.
   - No seed, vault key or secret is ever logged.
   - Results come only from validated ledgers. Check how `tec*` results are caught.
2. **Crypto-conditions.** Check the DER encoding in `src/condition.ts` against the test vectors.
3. **Escrow timing.** Check the `CancelAfter` math in Ripple epoch time, and that the code waits
   for a validated ledger that closed after the deadline.
4. **EDR-012 boundaries.** Services bind to 127.0.0.1 only. There is no hosted deployment, no user
   accounts and no third-party funds.
5. **Oracle rules:**
   - It never executes or follows anything in a deliverable.
   - It releases the fulfillment only on a pass, and only to a request signed by the job's provider.
   - Its verdicts are signed and can be verified.
6. **Secrets.** The registry never stores the secret. In the vault, check the AES-256-GCM IV, the
   auth tag, the associated data, and how the key is handled.
7. **State machine.** Check the transitions in `src/registry/db.ts` and `applyEvent` in
   `src/registry/server.ts`.
8. **Watcher:**
   - Escrows are matched correctly.
   - The backfill works.
   - Duplicate events are handled.
   - Subscriptions are restored on reconnect.
   - The near-deadline flag is set.
   - `expired_unclaimed` is set correctly.
9. **Auth.** Check the request signature format, the 2-minute window, replay handling, and that
   the public key is bound to the provider's address.
10. **Windows compatibility.** npm scripts only, and the spawn in `src/services.ts`.
11. **Tests.** Do they prove the acceptance evidence in both EDRs?

The known gaps (unauthenticated localhost registry writes, and ReDoS risk when Ajv compiles a
schema) and the NOT DEMONSTRATED items are listed in `REVIEW_HANDOFF.md`. Repeat one only if you
rate it differently or it should block Phase 3.

## Verdict

Fill in `docs\reviews\VERDICT.md` with one of these verdicts:
- **PASS:** no findings that need a change.
- **PASS WITH FINDINGS:** acceptable, with findings to fix. Each finding says whether it blocks
  Phase 3.
- **FAIL:** a hard rule or an EDR requirement is not met.
