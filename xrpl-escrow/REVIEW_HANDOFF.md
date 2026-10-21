# Review handoff: ESCROW-001 Phase 1 and Phase 2

**Reviewer:** Gpno, the single final reviewer for both phases (EDR-011 and EDR-012).
**Start with:** `docs/reviews/REVIEW.md`, which covers how to run everything and what to check.
**Verdict:** written to `docs/reviews/VERDICT.md` as **PASS**, **PASS WITH FINDINGS** or **FAIL**.

> **Update 2026-10-20:** Gpno returned PASS WITH FINDINGS on `deb71ea`. The fixes and the status
> of each finding are in [`docs/reviews/FINDINGS_RESPONSE.md`](docs/reviews/FINDINGS_RESPONSE.md).
> The counts and gaps below describe the current working tree, after the fixes.

## Project facts

- **Location:** `C:\dev\ai-settlement\`. It is a git repo of its own, separate from
  `PersonalAi`. The code is in `xrpl-escrow\` and the decision records are in `edr\`.
- **Network:** XRP Ledger testnet only. Every connection checks `network_id === 1` and aborts
  otherwise. Wallets are funded only by the testnet faucet.
- **Approvals:** Christopher accepted EDR-012 on 2026-10-20 at 07:31 UTC, on a decision card in
  the project chat. EDR-011, the Phase 1 record, was written down from `CLAUDE.md` afterwards
  (`edr\EDR-011_ESCROW_PHASE1_TESTNET_DEMO.md`). Christopher accepted EDR-011 and EDR-012 by name, with Gpno as reviewer, at 17:04 UTC
  (`edr/ACCEPTANCES.md`).
- **Git history:** Christopher asked for `git init` and the baseline commit at 08:14 UTC. At
  16:41 UTC he chose to keep `main` as it is and waived the per-phase branches (Gpno finding 2).
- **Reviewer names in the governance docs:** EDR-012 now names Gpno as reviewer.
  `CLAUDE_PHASE2.md` still says Codex, because it is kept as Christopher uploaded it. Gpno is the
  reviewer for both phases.
- **Build environment:** Linux cloud container, Node 22.22.0, npm 10.9.4. Testnet traffic went
  through `wss://testnet.xrpl-labs.com`. The primary `s.altnet` server on port 51233 was blocked by
  the sandbox proxy, and the code falls back automatically.

## Scope

### Phase 1: escrow mechanism (`CLAUDE.md`, EDR-011)

A client locks XRP in a native escrow behind a PREIMAGE-SHA-256 condition. The oracle holds the
secret and releases the fulfillment only for matching work. The provider finishes the escrow, or
the client cancels it after `CancelAfter`.

| File | Role |
|---|---|
| `src/config.ts` | Testnet URLs with fallback, `network_id` guard, proxy support |
| `src/wallets.ts` | Faucet funding; seeds loaded from and saved to `.env` |
| `src/condition.ts` | `makeSecret`, `toCondition`, `toFulfillment` (hand-rolled DER, uppercase hex) |
| `src/escrow.ts` | `createEscrow`, `finishEscrow`, `cancelEscrow`, `getEscrow`; reads results from validated ledgers only |
| `src/oracle.ts`, `src/registry.ts` | In-process oracle and in-memory registry (Phase 1 stubs, kept as they were) |
| `src/demo.ts` | Phase 1 scenarios: happy path, bad delivery, wrong secret, plus finish after and cancel before the deadline |
| `test/condition.test.ts`, `test/flow.test.ts` | Known test vectors cross-checked with `five-bells-condition`; scenarios on testnet |
| `runs/2026-10-20-testnet.txt` | Phase 1 testnet run log with explorer links |

### Phase 2: oracle, registry, watcher, SDK (`CLAUDE_PHASE2.md`, EDR-012)

| File | Role |
|---|---|
| `src/registry/db.ts`, `src/registry/server.ts` | Job registry: SQLite (`data/jobs.db`) and HTTP API on 127.0.0.1:8801. Never stores the secret. Handles status transitions and the reputation stub. |
| `src/oracle/server.ts` | Oracle on 127.0.0.1:8802. Creates conditions, handles `POST /verify/:jobId`, signs verdicts, and appends to the JSONL verdict log. |
| `src/oracle/vault.ts` | Secrets sealed with AES-256-GCM under `ORACLE_VAULT_KEY` from `.env`, with the job id as associated data |
| `src/oracle/checks/` | `sha256-match`, `json-schema` (Ajv), `max-latency` |
| `src/watcher.ts` | Account and ledger subscription. Validated EscrowCreate, EscrowFinish and EscrowCancel set funded, paid and refunded. Flags jobs near the deadline and marks `expired_unclaimed`. |
| `src/sdk/index.ts` | `createJob`, `fundJob`, `deliver`, `claim`, `refund`, `verifyVerdict` |
| `src/auth.ts`, `src/http.ts`, `src/local-config.ts` | Signed requests and verdicts, a JSON server bound to 127.0.0.1, settings |
| `src/services.ts`, `src/setup.ts` | Start services as child processes; one-time wallet and vault key setup |
| `src/demo-phase2.ts` | The four EDR-012 scenarios, through the HTTP services |
| `test/registry`, `oracle`, `watcher`, `sdk` `.test.ts` | Unit tests that need no network |
| `test/phase2-flow.test.ts` | All Phase 2 scenarios on testnet |
| `logs/2026-10-20-phase2.txt` | Phase 2 testnet run log with explorer links |

`docs/reviews/phase2.diff` shows only what Phase 2 changed. It has 27 files, +2395 / -13, and
leaves out `package-lock.json`, the docs (including this file) and the logs. The Phase 1 side of that diff was rebuilt from
the files as they stood before Phase 2 began. In git, both phases are in the baseline commit.

## Test commands and expected results

Run these from `xrpl-escrow\` in PowerShell, with Node 22.12 or newer.

| Command | Expected | Result on 2026-10-20 |
|---|---|---|
| `npm ci` | Installs cleanly | OK |
| `npm run typecheck` | 0 errors | 0 errors |
| `npm run test:unit` | 52/52, no network | 52/52 (44/44 at `deb71ea`) |
| `npm run setup` | 3 funded testnet wallets, plus the vault key, the two service tokens and the verdict key in `.env` | OK |
| `npm run demo` (Phase 1) | **18/18** checks | 18/18 (`runs/2026-10-20-testnet.txt`) |
| `npm run demo:phase2` (Phase 2) | **49/49** checks, log saved to `logs/<date>-phase2.txt` | 49/49 (`logs/2026-10-20-phase2-fixes.txt`); 47/47 at `deb71ea` (`logs/2026-10-20-phase2.txt`) |
| `npm test` | **54/54** tests, about 6 minutes, both testnet flows | 54/54 in 364.9 s (46/46 at `deb71ea`) |

The 54 tests are: 7 condition test vectors, 11 registry, 20 oracle, 6 watcher, 8 SDK, and one testnet
flow for each phase. Behind a proxy, also set `HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1`.

### How the run results map to the acceptance evidence

| Requirement | Evidence |
|---|---|
| P1: happy path, bad delivery, wrong secret (`tecCRYPTOCONDITION_ERROR`); finish after the deadline and cancel before it both fail | Phase 1 run log, 18 checks |
| P2: pass, then claim | Scenario 1: signed pass, then EscrowFinish `tesSUCCESS`; the watcher sets `paid` |
| P2: fail, then refund | Scenario 2: signed fail with no fulfillment; early cancel gets `tecNO_PERMISSION`; later cancel `tesSUCCESS`; the watcher sets `refunded` |
| P2: oracle restart mid-job | Scenario 3: the oracle stops and restarts with the same address, reads the secret back from the vault, and the job is paid |
| P2: deliverable treated as data | Scenario 4: the schema decides (fail), nothing executes, an outsider gets 403, and the log holds only the hash |
| P2: watcher statuses match the ledger | For every job: the registry status came from a ledger event, the stored tx hash equals the submitted one, and the escrow object is present or gone as expected |
| P2: secret never in the registry, encrypted at rest | Scenario 1 scans `jobs.db` and its WAL file; vault unit tests |

## NOT DEMONSTRATED

- **Windows run.** Everything ran on Linux. The code uses npm scripts and `node --import tsx`, with
  no shell scripts, and `better-sqlite3` ships Windows prebuilds, but it has not been run on
  Windows.
- **The README quickstart.** Each service started from its npm script and answered its health
  check, but nobody drove a job by hand through services started that way.
- **`expired_unclaimed` on testnet.** Only unit tests cover it (`watcher.test.ts`,
  `registry.test.ts`).
- **Watcher reconnect.** The resubscribe-on-reconnect path never ran during the testnet runs.

## Known gaps

Both known gaps from `deb71ea` are fixed. Details are in `docs/reviews/FINDINGS_RESPONSE.md`.

1. **Registry writes from localhost** now need `ORACLE_SERVICE_TOKEN` or `WATCHER_SERVICE_TOKEN`.
   The oracle also confirms on the ledger that the job's escrow exists with the agreed terms before
   it verifies anything.
2. **Ajv and ReDoS:** job schemas may not use `pattern`, `patternProperties`, `uniqueItems`,
   `format` or `$data`. Schemas are capped at 16 KB and 32 levels of nesting, and the
   compiled-schema cache is bounded. Checks still run in the oracle's own process, with no worker
   timeout.

Other notes:
- Request replay protection is saved in `data/oracle-replay.json`, so it survives restarts.
- Verdicts are signed with a separate ed25519 key. SDK users pin its address
  (`ORACLE_VERDICT_ADDRESS`).
- `max-latency` measures from the close time of the ledger that validated the EscrowCreate.
- The fulfillment still travels over plain HTTP on 127.0.0.1.
- Deliverables are UTF-8 text up to 1 MB.
- The verdict log is `data/verdicts.jsonl`, not the `src/oracle/` path in `CLAUDE_PHASE2.md`.
- `demo:phase2` starts its own copies of the services, so stop any you started by hand first.

## Secrets

`.env` (seeds, `ORACLE_VAULT_KEY`, the service tokens and the verdict key), `data/` (the database,
vault, replay file and verdict log) and `node_modules/` are
gitignored and are not in the repo or the zip. Run `npm run setup` to create fresh testnet wallets.
