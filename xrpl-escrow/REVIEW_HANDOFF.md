# Review handoff: ESCROW-001 Phase 2 (oracle, registry, watcher, SDK)

For Codex's single final review. Governing records: `edr/EDR-012_ESCROW_PHASE2_ORACLE_REGISTRY.md`
and `CLAUDE_PHASE2.md` (copies of the files Christopher uploaded).

- **Acceptance:** Christopher accepted EDR-012 on 2026-10-20 at 07:31 UTC ("Accept and build" on the
  project's decision card). The saved EDR copy is unedited, so its Status line still reads Proposed.
- **Directory:** the docs say `xrpl-escrow/`; this project's Phase 1 lives in `escrow-demo/`, so
  Phase 2 is built there. Nothing outside `escrow-demo/` was changed.
- **Branch:** there is no git repository yet, so the `escrow/002-oracle-registry` branch step was
  skipped. Nothing has been committed, pushed or merged.
- **Environment:** Linux cloud container, Node 22.22.0, npm 10.9.4. Testnet via
  `wss://testnet.xrpl-labs.com` (the `s.altnet` port 51233 is reset by the sandbox proxy; the code
  falls back automatically). The `network_id === 1` guard runs on every connection.

## Review package

- **Start here:** `docs/reviews/phase2/CODEX_REVIEW.md` (scope, how to run, what to check, where to
  write the verdict).
- **The diff:** `docs/reviews/phase2/phase2.diff`, Phase 1 to Phase 2, 28 files, +2537 / -13.
  With no git history, the Phase 1 side was rebuilt from the Phase 1 files as they stood before
  Phase 2 started. `package-lock.json` and the copied governance docs and run log are left out of
  the diff; dependency changes show in `package.json`.
- **Phase 1 rules:** `CLAUDE.md` (the Phase 1 project instructions, which `CLAUDE_PHASE2.md` says
  still apply).
- In the proposed repo layout `edr/` sits at the repo root, next to `xrpl-escrow/`, which matches the
  paths in `CLAUDE_PHASE2.md` and EDR-012.

## Files changed

Phase 1 sources (`src/condition.ts`, `config.ts`, `escrow.ts`, `oracle.ts`, `registry.ts`,
`wallets.ts`, `demo.ts`) are unchanged.

| File | Change |
|---|---|
| `package.json`, `package-lock.json` | Added `better-sqlite3`, `ajv`, `ripple-keypairs` (already a transitive dep of `xrpl`), `@types/better-sqlite3`; scripts `demo:phase2`, `registry`, `oracle`, `watcher`, `setup`; `test:unit` now covers all unit tests |
| `.gitignore` | Adds `data/` and `src/oracle/verdicts.jsonl` |
| `vitest.config.ts` | New. Test files run one at a time (the two testnet flows share wallets) |
| `README.md` | Phase 2 section: services, Windows quickstart, SDK example, scenarios, API, code map |
| `src/local-config.ts` | New. Ports 8801/8802, file paths, `.env` reading, `ensureVaultKey()` |
| `src/http.ts` | New. JSON router on `node:http`, `listenLocal()` hard-wired to 127.0.0.1, 1 MB body cap, proxy-free local client |
| `src/auth.ts` | New. Signed provider requests (wallet key, 2-minute freshness, replay set) and signed verdicts (canonical JSON) |
| `src/registry/db.ts` | New. SQLite store: jobs, deliverables, events; status transitions; reputation stub |
| `src/registry/server.ts` | New. Registry HTTP API; rejects any `secret`/`fulfillment`/`preimage` key; ledger may close a job from any open state, recorded as an override |
| `src/oracle/vault.ts` | New. AES-256-GCM, 12-byte IV, job id as associated data, atomic file write |
| `src/oracle/checks/*.ts` | New. `sha256-match`, `json-schema` (ajv), `max-latency`; all must pass, an empty list fails |
| `src/oracle/server.ts` | New. Condition creation, `POST /verify/:jobId`, signed verdicts, JSONL verdict log |
| `src/watcher.ts` | New. Account + ledger subscription, `account_tx` backfill, resubscribe on reconnect, near-deadline flag, `expired_unclaimed` |
| `src/sdk/index.ts` | New. `EscrowKit` (`createJob`, `fundJob`, `deliver`, `claim`, `refund`, `waitForStatus`, `reputation`), `verifyVerdict`, `escrowRef` |
| `src/services.ts`, `src/setup.ts` | New. Start services as child processes (`node --import tsx`, no shell); one-time wallet + vault key setup |
| `src/demo-phase2.ts` | New. The four EDR-012 scenarios, 47 checks, log saved to `logs/<date>-phase2.txt` |
| `test/registry.test.ts`, `oracle.test.ts`, `watcher.test.ts`, `sdk.test.ts`, `helpers.ts` | New unit tests (no network) |
| `test/phase2-flow.test.ts` | New. Runs `runPhase2` on testnet on ports 18801/18802 with throwaway data files |
| `edr/EDR-012_...md`, `CLAUDE_PHASE2.md` | Copies of the governing docs |
| `logs/2026-10-20-phase2.txt` | Testnet run log with explorer links |
| `CLAUDE.md` | Phase 1 rules (the project instructions), saved so the Phase 2 doc's reference resolves |
| `docs/reviews/phase2/` | `CODEX_REVIEW.md` (review brief) and `phase2.diff` |

## Commands run and their output

```
$ npm run typecheck        (tsc, strict)
(no output: 0 errors)

$ npm run setup            (NODE_USE_ENV_PROXY=1 for the faucet behind the sandbox proxy)
  client   rJBVcc4ykAk3c1jfr6AqZULiVgTkSx25TD  100.000000 XRP
  provider rJAdLowmNJq9MJKCKsW45e5PTBjiiTBUjr  100.000000 XRP
  oracle   rGi9db59t8rpYSfCZCtaBJgDJ88RvfdjmC  100.000000 XRP
Wallet seeds and ORACLE_VAULT_KEY are in .env (testnet only, gitignored).

$ npm run demo:phase2      (2026-10-20 07:40 UTC, full log in logs/2026-10-20-phase2.txt)
...
47/47 checks passed.

$ npm test                 (2026-10-20 07:45 UTC)
 Test Files  7 passed (7)
      Tests  46 passed (46)
   Duration  327.61s

$ npm run registry / npm run oracle / npm run watcher   (smoke test, each in the background)
GET 127.0.0.1:8801/health -> {"ok":true,"service":"registry"}
GET 127.0.0.1:8802/health -> {"ok":true,"service":"oracle","oracle":"rGi9db59t8rpYSfCZCtaBJgDJ88RvfdjmC",...}
[watcher] connected to wss://testnet.xrpl-labs.com (testnet), watching jobs in http://127.0.0.1:8801
```

The 46 tests are: 7 condition vectors (Phase 1), 9 registry, 15 oracle, 6 watcher, 7 SDK,
the Phase 1 testnet flow, and the Phase 2 testnet flow.

## Acceptance evidence, mapped to EDR-012

| EDR-012 item | Evidence |
|---|---|
| `npm test` passes with new registry, oracle-check, watcher and SDK tests | 46/46 above |
| Scenario 1: pass, then claim | Run log, scenario 1: EscrowCreate, signed pass verdict, EscrowFinish `tesSUCCESS`, watcher `paid` |
| Scenario 2: fail, then refund | Scenario 2: signed fail, no fulfillment, early cancel `tecNO_PERMISSION`, later cancel `tesSUCCESS`, watcher `refunded` |
| Scenario 3: oracle restart mid-job | Scenario 3: oracle process stopped (health unreachable), restarted, same address, secret read from the vault, EscrowFinish `tesSUCCESS` |
| Scenario 4: instruction-like deliverable is data | Scenario 4: schema decides (fail), stored byte for byte, marker file not created, outsider gets 403, verdict log holds only the evidence hash |
| Watcher statuses match the ledger in every scenario | Each job has `watcher status matches the ledger` checks for `funded` and then `paid`/`refunded`: registry status, set by a ledger-sourced event, recorded tx hash equals the submitted one, escrow object present/gone |
| Registry never stores the secret | Scenario 1 scans `jobs.db` and its WAL for the secret and fulfillment; registry rejects secret-like keys; no such column |
| Secret encrypted at rest | Scenario 1 checks the vault file does not contain the secret; vault unit tests (wrong key, moved entry, plaintext absent) |
| Signed verdicts | `verifyVerdict` checks the signature and that the key derives to the oracle address; tampered verdicts fail in tests |
| Reputation stub | `GET /providers/:address/reputation`; demo checks +2 passed, +2 failed, +2 paid, +2 refunded |

## NOT DEMONSTRATED

- **Windows.** Everything ran on Linux. The code uses npm scripts and `node --import tsx` with no
  shell scripts, and `better-sqlite3` ships Windows prebuilds, but no Windows run was done.
- **The README quickstart end to end.** Each service was started with its npm script and answered
  (above), and the demo starts the same scripts as child processes, but nobody drove a job through
  hand-started services with the SDK snippet.
- **`expired_unclaimed` on testnet.** Covered by unit tests only (`watcher.test.ts`, `registry.test.ts`).
- **Watcher reconnect.** The resubscribe-on-reconnect path never fired during the runs.
- **Codex review of Phase 1 / EDR-011.** EDR-012 says it depends on EDR-011 being Accepted with the
  Phase 1 Codex verdict recorded. Neither record is in this project folder.

## Gaps and risks for the review

1. **Internal registry writes are unauthenticated.** `PUT /jobs/:id/condition` and
   `POST /jobs/:id/events` trust any caller on 127.0.0.1. Any local process could mark a job
   `verified_pass`. This doesn't release money (only the oracle's fulfillment unlocks the escrow,
   and the ledger-sourced statuses are re-derived from the chain), but a shared service token or
   signed oracle/watcher events are needed before anything leaves localhost.
2. **Ajv compiles the client's JSON Schema into code.** The schema comes from the job spec (the
   client), not the deliverable, and deliverables are only `JSON.parse`d. Ajv's docs say schemas
   should be trusted; a hostile `pattern` could cause ReDoS. Before outside developers submit specs
   (Phase 3), restrict schema keywords or use a safe regex engine.
3. **Replay protection is in memory.** Used request signatures are forgotten when the oracle
   restarts; the 2-minute timestamp window limits this. The fulfillment goes only to whoever presents
   a valid provider signature, over plain HTTP on 127.0.0.1.
4. **The oracle's verdict key is its testnet wallet key** (`ORACLE_SEED`). Fine on testnet; a
   separate signing key would be cleaner later.
5. **`max-latency` uses the registry's clock** (when the watcher reported funding), not ledger close
   time.
6. **Deliverables are UTF-8 text in SQLite, up to the 1 MB request cap.** Binary deliverables would
   need base64 or a content store.
7. **`src/oracle/verdicts.jsonl`** sits under `src/` because `CLAUDE_PHASE2.md` puts it there. It is
   gitignored; a `data/` or `logs/` location would be more usual. The path is configurable with
   `VERDICT_LOG`.
8. **The demo runs its own copies of the services** on 8801/8802 (it must restart the oracle for
   scenario 3), so services started by hand must be stopped first. The README says so.
9. **New testnet wallets.** Phase 1's `.env` was not kept in the shared folder, so `setup` funded
   fresh faucet wallets. `.env` (seeds and vault key) is not copied to the shared folder.
