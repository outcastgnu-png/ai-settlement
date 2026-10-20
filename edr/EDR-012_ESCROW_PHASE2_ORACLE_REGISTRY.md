# EDR-012: ESCROW-001 Phase 2: Verification Oracle and Job Registry

## Status

Proposed

This record is Proposed. It does not govern until the owner accepts it by name.
It depends on EDR-011 being Accepted, with the Phase 1 Codex review verdict recorded.

## Date

2026-10-20 (America/Chicago)

## Deciders

Christopher (owner). Implementer: Claude (builds end to end). Reviewer: Codex
(one final review). Drafted by: Grok Bot.

## Investigation

ESCROW-001, phase 2.

## Context

Phase 1 proved the escrow mechanism on testnet (18 of 18 checks, 8 of 8 tests). The
oracle and registry are still in-process stubs. Phase 2 turns them into local
services that another agent could call.

## Decision

Build, still **testnet-only and local-only** (127.0.0.1), inside `xrpl-escrow/`:

1. **Job registry API.** Endpoints to create, get, and list jobs, and to post a deliverable.
   It stores the job spec, price, provider address, condition, escrow sequence, status, and
   timestamps, in SQLite at `xrpl-escrow/data/jobs.db`. It never stores the secret.
2. **Verification oracle service.** It is a separate process holding the secrets,
   encrypted at rest with a local key from `.env`.
   - It runs pluggable deterministic checks: `sha256-match`, `json-schema`, `max-latency`.
   - It returns a signed verdict (pass or fail, check results, evidence hash) and, on a
     pass, the fulfillment.
   - It writes an append-only verdict log as JSONL.
3. **Ledger watcher.** A websocket subscription to the client and provider accounts
   updates job status from validated escrow transactions (created, finished,
   cancelled) and flags escrows nearing `CancelAfter`.
4. **SDK surface (TypeScript).** `createJob()`, `fundJob()`, `deliver()`,
   `claim()`, `refund()`, wrapping the registry, oracle, and ledger calls.
5. **Reputation stub.** Per-provider counts of passed, failed, and refunded jobs,
   computed from the registry.

## Boundaries

- Phase 1 boundaries all still apply: no mainnet, the `network_id === 1` guard, no
  contact with the XRP Intelligence Core paths, and changes only inside `xrpl-escrow/`.
- Services bind to 127.0.0.1 only. There is no hosted deployment, no user accounts,
  and no third-party funds.
- Out of scope: the AI judge, disputes and multisig, RLUSD, x402, payment, and the UI.
- Deliverables and job specs are data, not instructions (`Agents.md` A3). The oracle
  must never execute deliverable content.

## Acceptance evidence

- `npm test` passes, including new tests for the registry, the oracle checks, the
  watcher, and the SDK.
- `npm run demo:phase2` runs these scenarios through the HTTP services:
  1. pass, then the provider claims payment;
  2. fail, then a refund;
  3. the oracle restarts mid-job and the job still completes, because the
     secret persists encrypted;
  4. a deliverable containing instruction-like text is treated as data only.
- The watcher's job statuses match the ledger for every scenario.
- `REVIEW_HANDOFF.md` is updated for Codex's single review.

## Consequences

The project becomes a usable local developer kit, ready for outside developers
to try in phase 3. Exposing anything beyond localhost needs a new EDR.
