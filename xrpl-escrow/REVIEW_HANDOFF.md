# Review handoff: ESCROW-001 Phase 1 and Phase 2

**Reviewer:** Gpno, the single final reviewer for both phases (EDR-011 and EDR-012).
**Start with:** `docs/reviews/REVIEW.md`, which covers how to run everything and what to check.
**Verdict:** write it to `docs/reviews/VERDICT.md` as **PASS**, **PASS WITH FINDINGS** or **FAIL**.
The template and format are in that file.

## Project facts

- **Location:** `C:\dev\ai-settlement\`. It is a git repo of its own, separate from
  `PersonalAi`. The code is in `xrpl-escrow\` and the decision records are in `edr\`.
- **Network:** XRP Ledger testnet only. Every connection checks `network_id === 1` and aborts
  otherwise. Wallets are funded only by the testnet faucet.
- **Approvals:** Christopher accepted EDR-012 on 2026-10-20 at 07:31 UTC. EDR-011, the Phase 1
  record, is not in this repo; add it to `edr\` if you have it.
- **Reviewer names in the governance docs:** The copies of EDR-012 and `CLAUDE_PHASE2.md` still
  name Codex as reviewer, because they are kept as Christopher uploaded them. Christopher has
  since changed the reviewer to Gpno for both phases.
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

Run these from `xrpl-escrow\` in PowerShell, with Node 20 or newer.

| Command | Expected | Result on 2026-10-20 |
|---|---|---|
| `npm ci` | Installs cleanly | OK |
| `npm run typecheck` | 0 errors | 0 errors |
| `npm run test:unit` | 44/44, no network | 44/44 |
| `npm run setup` | 3 funded testnet wallets and `ORACLE_VAULT_KEY` written to `.env` | OK |
| `npm run demo` (Phase 1) | **18/18** checks | 18/18 (`runs/2026-10-20-testnet.txt`) |
| `npm run demo:phase2` (Phase 2) | **47/47** checks, log saved to `logs/<date>-phase2.txt` | 47/47 (`logs/2026-10-20-phase2.txt`) |
| `npm test` | **46/46** tests, about 6 minutes, both testnet flows | 46/46 in 327.6 s |

The 46 tests are: 7 condition test vectors, 9 registry, 15 oracle, 6 watcher, 7 SDK, and one testnet
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

1. **Registry writes from localhost are unauthenticated.** `PUT /jobs/:id/condition` and
   `POST /jobs/:id/events` accept any caller on 127.0.0.1, so any local process could change a
   job's status. That alone can't move money, because only the oracle's fulfillment unlocks an
   escrow and the ledger statuses come from the chain. A service token or signed oracle and
   watcher events is needed before anything leaves localhost.
2. **Ajv schema compile and ReDoS risk.** Ajv compiles the client's JSON Schema from the job spec
   into code. A hostile `pattern` could cause catastrophic regex backtracking. Deliverables are only
   passed through `JSON.parse`. Before outside developers submit specs, restrict the allowed schema
   keywords or use a safe regex engine.

Other notes:
- Replay protection for signed requests is kept in memory with a 2-minute window, so it resets
  when the oracle restarts.
- Verdicts are signed with the oracle's testnet wallet key.
- `max-latency` uses the registry's clock, not ledger close time.
- Deliverables are UTF-8 text up to 1 MB.
- `src/oracle/verdicts.jsonl` sits under `src/` because `CLAUDE_PHASE2.md` puts it there. It is
  gitignored.
- `demo:phase2` starts its own copies of the services, so stop any you started by hand first.

## Secrets

`.env` (seeds and `ORACLE_VAULT_KEY`), `data/` (the database and vault) and `node_modules/` are
gitignored and are not in the repo or the zip. Run `npm run setup` to create fresh testnet wallets.
