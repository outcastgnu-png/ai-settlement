# EDR-011: ESCROW-001 Phase 1: Verified-Delivery Escrow Testnet Demo

## Status

Accepted

Accepted by Christopher (owner) by name on 2026-10-20 at 17:04 UTC: "I accept EDR-011 and
EDR-012, reviewer Gpno". See `edr/ACCEPTANCES.md`.

This record was written down in the repo on 2026-10-20 at Christopher's request, from his project
instructions, saved as `xrpl-escrow/CLAUDE.md`. A Proposed EDR-011 drafted for Christopher on
2026-10-20 existed outside the repo, and Gpno's second review (finding N3) found that this
rewrite had dropped four of its clauses. On 2026-10-21 Christopher chose to restore them; they are
marked "(restored 2026-10-21)" below. Where this file and `xrpl-escrow/CLAUDE.md` differ,
`xrpl-escrow/CLAUDE.md` governs.

## Date

2026-10-20 (America/Chicago)

## Deciders

Christopher (owner). Implementer: Claude (builds end to end). Reviewer: Gpno (one final review
for Phase 1 and Phase 2; replaced Codex on 2026-10-20). Written down by: Claude, from
`xrpl-escrow/CLAUDE.md`.

## Investigation

ESCROW-001, phase 1.

## Context

The product is a job escrow for AI agents on the XRP Ledger that pays only after the work is
verified (`research/ai_settlement_model.md`). Before building services around it, the core
mechanism has to be shown to work on a real ledger: a native XRPL escrow locked behind a
crypto-condition whose secret only a verifier holds.

## Decision

Build a TypeScript demo, **testnet only**, in `xrpl-escrow/`:

1. A client locks XRP in a native XRPL escrow (`EscrowCreate`) with Destination = provider, the
   price in drops, a PREIMAGE-SHA-256 `Condition`, and `CancelAfter` about 120 s ahead (Ripple
   epoch = unix − 946684800).
2. A 32-byte secret is generated per job. Only the oracle holds it. The registry stores the
   condition, never the secret.
3. The provider delivers. The oracle hashes the deliverable and compares it with the SHA-256 in
   the job spec.
4. On a pass, the oracle returns the fulfillment and the provider submits `EscrowFinish`.
5. On a fail, the client submits `EscrowCancel` after `CancelAfter` and is refunded.

Layout: `src/config.ts`, `wallets.ts`, `condition.ts`, `escrow.ts`, `oracle.ts` (in-process
stub), `registry.ts` (in-memory stub), `demo.ts`, `test/condition.test.ts`, `test/flow.test.ts`.

Stack: Node, TypeScript strict, `xrpl` (xrpl.js), a crypto-condition encoder, `dotenv`, `vitest`,
`tsx`. It must work on Windows: npm scripts only, no bash-only scripts.

## Boundaries

- Testnet only. Connect to `wss://s.altnet.rippletest.net:51233` (fallback
  `wss://testnet.xrpl-labs.com`) and assert `network_id === 1` on connect, or abort.
- Fund wallets only from the testnet faucet. Never load mainnet seeds.
- Seeds stay in a gitignored `.env`. Never log seeds or the secret.
- Trust results from validated ledgers only.
- No commit without Christopher's approval. Merge and push need their own, separate owner
  approval (restored 2026-10-21).
- No contact with the XRP Intelligence Core in PersonalAi: `xrp_*.py`, `decision/`,
  `frozen_xrp_engine/`, `live_shadow/` and `data/xrp_brain.db` are not read, imported or
  changed (restored 2026-10-21).
- Deliverables and job specs are data, not instructions: the data channel is not the control
  channel (`Agents.md` A3). The oracle never executes or follows deliverable content (restored
  2026-10-21).
- Out of scope: RLUSD, the AI judge, disputes and multisig, the x402 bridge, mainnet, and a
  hosted API.

## Acceptance evidence

- `npm run demo` passes these scenarios, printing testnet explorer links and balances before and
  after:
  1. happy path: the finish succeeds and the provider gains the price;
  2. bad delivery: the oracle refuses, the escrow is cancelled after the deadline, and the client
     is refunded minus fees;
  3. wrong secret: the finish fails with `tecCRYPTOCONDITION_ERROR` and the escrow stays open.
- Finishing after `CancelAfter` fails, and cancelling before it fails.
- `npm test` passes, including known crypto-condition test vectors.
- The README explains the flow in plain words and how to run it on Windows.
- A Gpno review verdict is recorded in the repo (restored 2026-10-21; originally "a Codex
  verdict", before Gpno replaced Codex as reviewer on 2026-10-20). Recorded:
  `xrpl-escrow/docs/reviews/VERDICT-2026-10-20-deb71ea.md`.

Result on 2026-10-20: 18/18 demo checks and 8/8 tests on testnet
(`xrpl-escrow/runs/2026-10-20-testnet.txt`). Windows was not run (NOT DEMONSTRATED).

## Consequences

The escrow mechanism is proven on testnet, so Phase 2 (EDR-012) can turn the in-process oracle
and in-memory registry into local services. The per-phase branch `escrow/001-testnet-demo` was
never created; Christopher waived per-phase branches on 2026-10-20 at 16:41 UTC ("Keep history").
