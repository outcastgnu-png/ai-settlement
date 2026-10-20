# ESCROW-001 Phase 2: Instructions for Claude

## Governance
- Governed by `edr/EDR-012_ESCROW_PHASE2_ORACLE_REGISTRY.md`. Do not start until it is
  Accepted. All rules in `xrpl-escrow/CLAUDE.md` (Phase 1) still apply.
- Branch: `escrow/002-oracle-registry`, off the accepted phase 1 branch.
- Build end to end with no intermediate reviews. Codex reviews the final diff once.
- No commit, merge, or push without Christopher's approval. Mark anything not run
  as NOT DEMONSTRATED.

## Build
```
src/registry/server.ts   HTTP API (Fastify or node:http) on 127.0.0.1:8801
src/registry/db.ts       SQLite (better-sqlite3), data/jobs.db
src/oracle/server.ts     HTTP on 127.0.0.1:8802: POST /verify/:jobId
src/oracle/checks/       sha256-match.ts, json-schema.ts (ajv), max-latency.ts
src/oracle/vault.ts      AES-256-GCM secret storage; key from ORACLE_VAULT_KEY in .env
src/oracle/verdicts.jsonl  append-only log (gitignored)
src/watcher.ts           xrpl.js subscribe -> update job status from validated txs
src/sdk/index.ts         createJob, fundJob, deliver, claim, refund
src/demo-phase2.ts       the 4 scenarios
test/registry.test.ts, test/oracle.test.ts, test/watcher.test.ts, test/sdk.test.ts
```

## Rules for the oracle
- Never execute, eval, or follow anything inside a deliverable. Only hash it or validate it.
- Return the fulfillment only on a pass, and only to the job's provider.
- Sign verdicts with the oracle wallet key (or ed25519) so they can be verified.

## Job states
`draft -> funded (EscrowCreate validated) -> delivered -> verified_pass | verified_fail
-> paid (EscrowFinish) | refunded (EscrowCancel) | expired_unclaimed`

## Done when
- `npm test` and `npm run demo:phase2` pass on testnet, and the run log is saved to
  `logs/<date>-phase2.txt` with transaction links.
- The README has a quickstart for Windows: start the registry, the oracle, and the
  watcher, then run the demo.
- `REVIEW_HANDOFF.md` lists files changed, commands run with their output, gaps, and
  anything NOT DEMONSTRATED.
