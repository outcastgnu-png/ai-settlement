# Review brief for Gpno: ESCROW-001 Phase 1 and Phase 2

> **Second review (2026-10-21), commit `af9a4db`.** Christopher asked you to review the fixes for
> findings 3 to 7 of your first verdict. Read the "Second review" section at the end of this file
> first. The rest of this brief is the first review's brief, unchanged.

You are the **single final reviewer** for Phase 1 (EDR-011) and Phase 2 (EDR-012). Review only.
Don't change any file except `docs/reviews/VERDICT.md`.

## What governs this work

| Document | Path from the repo root `C:\dev\ai-settlement\` |
|---|---|
| Phase 1 rules (testnet only, the `network_id` guard, seeds, validated ledgers) | `xrpl-escrow\CLAUDE.md` |
| EDR-011, the Phase 1 decision, written down from `CLAUDE.md` and accepted by name on 2026-10-20 | `edr\EDR-011_ESCROW_PHASE1_TESTNET_DEMO.md` |
| Phase 2 build instructions | `xrpl-escrow\CLAUDE_PHASE2.md` |
| EDR-012, the Phase 2 decision, accepted by name on 2026-10-20 | `edr\EDR-012_ESCROW_PHASE2_ORACLE_REGISTRY.md` |
| Implementer's handoff: scope, expected results, NOT DEMONSTRATED, known gaps | `xrpl-escrow\REVIEW_HANDOFF.md` |
| Run logs with testnet explorer links | `xrpl-escrow\runs\2026-10-20-testnet.txt` (Phase 1) and `xrpl-escrow\logs\2026-10-20-phase2.txt` (Phase 2) |

`CLAUDE_PHASE2.md` still says Codex. Christopher has since made Gpno the reviewer for both
phases, and EDR-012 records this. Christopher accepted both EDRs by name on 2026-10-20 (see
`edr/ACCEPTANCES.md`).

## What to review

Review the whole of `xrpl-escrow\`. To see only the Phase 2 changes, read `docs\reviews\phase2.diff`
(27 files, +2395 / -13).

Suggested order:
1. **Phase 1:** `src/config.ts`, `condition.ts`, `escrow.ts`, `wallets.ts`, `demo.ts`.
2. **Phase 2:** `src/registry/`, `src/auth.ts`, `src/oracle/vault.ts`, `src/oracle/checks/`,
   `src/oracle/server.ts`, `src/watcher.ts`, `src/sdk/index.ts`, `src/demo-phase2.ts`.
3. **Then the tests.**

## How to run it

Run these in PowerShell from `xrpl-escrow\`, with Node 22.12 or newer:

```
npm ci
npm run typecheck        # expect 0 errors
npm run test:unit        # expect 52/52, no network
npm run setup            # funds 3 testnet wallets from the faucet and writes .env (testnet only)
npm run demo             # Phase 1: expect 18/18 checks
npm run demo:phase2      # Phase 2: expect 49/49 checks; the log goes to logs\<date>-phase2.txt
npm test                 # expect 54/54, including both testnet flows (about 6 minutes)
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

The first review's verdict is in `VERDICT-2026-10-20-deb71ea.md`, and the response to each
finding is in `FINDINGS_RESPONSE.md`. The remaining gaps and the NOT DEMONSTRATED items are listed
in `REVIEW_HANDOFF.md`.

## Verdict

Fill in `docs\reviews\VERDICT.md` with one of these verdicts:
- **PASS:** no findings that need a change.
- **PASS WITH FINDINGS:** acceptable, with findings to fix. Each finding says whether it blocks
  Phase 3.
- **FAIL:** a hard rule or an EDR requirement is not met.

## Second review: the fixes in `af9a4db`

Christopher decided on 2026-10-21 that you review the fixes and that the Windows check is run
separately by Claude Code, so Windows results are not expected from you this time.

### What governs it

- Findings 1 and 2 were closed by Christopher: EDR-011 and EDR-012 accepted by name at 17:04 UTC
  (`edr/ACCEPTANCES.md`), EDR-011 written down from `CLAUDE.md`
  (`edr/EDR-011_ESCROW_PHASE1_TESTNET_DEMO.md`), per-phase branches waived ("Keep history"), and
  the commit of `af9a4db` approved ("Yes proceed", 05:07 UTC). Record if you disagree; don't
  re-open them otherwise.
- The implementer's account of each fix is `FINDINGS_RESPONSE.md`. Check it against the code; don't
  take it as evidence.

### What to read

`git diff deb71ea af9a4db` in the repo, or `docs\reviews\fixes.diff` (same diff without the
lockfile, the logs and `phase2.diff`). 32 files, +794 / -188.

### What to verify, per finding

| # | Claim | Where to look | How to break it |
|---|---|---|---|
| 3 | Node below 22.12 fails at `npm ci` with a clear message | `package.json` `engines`, `.npmrc` | Run `npm ci` on Node 20 if you have it |
| 4 | Registry writes need a service token; the oracle checks the escrow on the ledger before verifying | `src/auth.ts` `checkBearer`; `src/registry/server.ts` `registryRoutes`; `src/oracle/server.ts` `ledgerEscrowCheck` and the 409 path | Post a `ledger` event with no token, with the oracle's token, or with a token differing in one byte. Try to get a fulfillment out of the oracle for a job whose escrow is missing or has a different amount, destination, condition or `CancelAfter` |
| 5 | Slow schema keywords refused by both services; cache bounded | `src/schema-policy.ts`; `src/oracle/checks/json-schema.ts`; `parseNewJob` in the registry | Your `^(a+)+$` case; hide `pattern` under `$defs`, `items`, `allOf`, `if`; `$ref` to a URL; a 17 KB schema; 33 nesting levels; find any Ajv keyword still super-linear |
| 6 | Replay set persisted; separate verdict key; `verifyVerdict` requires a pinned address; `fundedAt` from ledger close time; verdict log under `data/` | `src/auth.ts` `ReplayGuard`; `src/local-config.ts`; `src/sdk/index.ts`; `src/watcher.ts` `toLedgerTx` | Replay a signed verify request across an oracle restart. Check the SDK never reads the address from `/health`. Plain HTTP on 127.0.0.1 is unchanged and documented as such |
| 7 | Transactions saved to `logs/<base>-txs.json`; logs never overwritten | `src/demo-phase2.ts` | Compare `logs/2026-10-20-phase2-fixes-txs.json` with the hashes in `logs/2026-10-20-phase2-fixes.txt` |

Also check that the tests added for each fix actually fail without the fix, and look for anything
the fixes broke: the SDK flow, the watcher, the Phase 1 demo (unchanged code, but same tree).

### Expected results

```
npm ci
npm run typecheck        # 0 errors
npm run test:unit        # 52/52, no network
npm run setup            # testnet faucet; writes .env with seeds, vault key, service tokens, verdict key
npm run demo             # 18/18
npm run demo:phase2      # 49/49; log to logs\<date>-phase2.txt, txs to logs\<date>-phase2-txs.json
npm test                 # 54/54, about 6 minutes
```

### Verdict

Write it in `docs\reviews\VERDICT.md` (a blank template is there; the first verdict is kept as
`VERDICT-2026-10-20-deb71ea.md`). Same format: PASS, PASS WITH FINDINGS or FAIL, each finding
saying whether it blocks Phase 3. Say for each of findings 3 to 7 whether it is fixed.
