# Codex review brief: ESCROW-001 Phase 2

You are doing the **single final review** of Phase 2 (verification oracle, job registry, ledger
watcher, SDK), as `CLAUDE_PHASE2.md` describes. Review only. Don't change any files except the
verdict file named at the end.

## What governs this work

| Document | Where (proposed repo layout) |
|---|---|
| EDR-012, the Phase 2 decision (accepted by Christopher on 2026-10-20 at 07:31 UTC) | `edr/EDR-012_ESCROW_PHASE2_ORACLE_REGISTRY.md` |
| Phase 2 build instructions | `xrpl-escrow/CLAUDE_PHASE2.md` |
| Phase 1 rules, which still apply | `xrpl-escrow/CLAUDE.md` |
| Implementer's handoff: files changed, commands and output, gaps, NOT DEMONSTRATED | `xrpl-escrow/REVIEW_HANDOFF.md` |
| Testnet run log with explorer links | `xrpl-escrow/logs/2026-10-20-phase2.txt` |

## What to review

`phase2.diff` (next to this file) is the whole change: 28 files, +2537 / -13. There is no git history
yet, so the Phase 1 side was rebuilt from the Phase 1 files as they stood before Phase 2. Phase 1
source and tests (`src/condition.ts`, `config.ts`, `escrow.ts`, `oracle.ts`, `registry.ts`,
`wallets.ts`, `demo.ts`, `test/condition.test.ts`, `test/flow.test.ts`) are unchanged.
`package-lock.json` is left out; the dependency changes are in `package.json`.

Suggested reading order: `src/registry/db.ts`, `src/registry/server.ts`, `src/auth.ts`,
`src/oracle/vault.ts`, `src/oracle/checks/`, `src/oracle/server.ts`, `src/watcher.ts`,
`src/sdk/index.ts`, `src/demo-phase2.ts`, then the tests.

## How to run it

From `xrpl-escrow/`, with Node 20 or newer:

```
npm ci
npm run typecheck        # tsc, strict
npm run test:unit        # 44 unit tests, no network
npm run setup            # funds 3 testnet wallets from the faucet, writes .env (testnet only)
npm run demo:phase2      # 4 scenarios, 47 checks, about 4 minutes
npm test                 # all 46 tests including both testnet flows, about 6 minutes
```

Behind a proxy, set `HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1`.

## What to check

1. **Phase 1 hard rules.** Testnet only, with the `network_id === 1` guard on every connection,
   including the watcher. Faucet-only funding. No seed, vault key or secret is ever logged or
   printed. Results come only from validated ledgers.
2. **Boundaries in EDR-012.** Services bind to 127.0.0.1 only (`src/http.ts` `listenLocal`). No
   hosted deployment, user accounts or third-party funds. Nothing changed outside `xrpl-escrow/`.
3. **Oracle rules.** It never executes, evaluates or follows deliverable content, and only hashes,
   parses or validates it. It returns the fulfillment only on a pass, and only to a request signed
   by the job's provider. Verdicts are signed and can be verified (`verifyVerdict`).
4. **Secrets.** The registry never stores the secret or the fulfillment. Check the vault's use of
   AES-256-GCM: random 12-byte IV, auth tag, job id as associated data, key only from `.env`.
5. **State machine.** The transitions in `src/registry/db.ts` and `applyEvent` in
   `src/registry/server.ts`. Only ledger-sourced events set `funded`, `paid` or `refunded`; the
   ledger may close a job from any open state, and that is recorded as an override.
6. **Watcher correctness.** EscrowCreate is matched on condition, client, provider and amount.
   Finish and cancel are matched on owner and offer sequence. Check `account_tx` backfill, duplicate
   events, resubscribe on reconnect, the near-deadline flag, and `expired_unclaimed`.
7. **Auth.** The request signature scheme in `src/auth.ts`: the message format, the 2-minute
   window, replay handling, and the public key to address binding.
8. **SDK.** Error handling in `fundJob`, `deliver`, `claim` and `refund`, including `tec*` results,
   timeouts, and calls with the wrong wallet.
9. **Windows.** npm scripts only, no shell-specific code, and the child-process spawn in
   `src/services.ts`.
10. **Tests.** Do the tests actually prove the EDR-012 acceptance evidence? Note anything asserted
    only by the demo.

The known gaps are listed in `REVIEW_HANDOFF.md` under "Gaps and risks" and "NOT DEMONSTRATED".
Repeat one only if you disagree with how serious it is, or if it blocks Phase 3.

## Verdict

Write `xrpl-escrow/docs/reviews/phase2/CODEX_VERDICT.md` with:

- **Verdict:** Approve, Approve with required changes, or Reject.
- **Findings,** most severe first, each with: severity (blocker, major, minor, nit), `file:line`,
  what is wrong, a concrete failure scenario, and the fix you suggest.
- **Phase 3 readiness:** which findings must be fixed before outside developers try the kit.
- **What you ran,** with output, and anything you could not run.
