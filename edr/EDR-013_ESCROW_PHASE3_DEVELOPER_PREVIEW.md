# EDR-013: ESCROW-001 Phase 3: Developer Preview (Python SDK, Release Packaging, Carry-overs)

## Status

Accepted

Accepted by Christopher (owner) by name on 2026-10-21 at 16:45 UTC: "I accept EDR. As
proposed, as Christopher is the owner, implementer is Claude, builds end-to-end. Reviewer,
GPNO, one final review for phase three, drafted by Claude." Scope chosen beforehand on a
decision card at 16:39 UTC: "Developer preview (as drafted)". See `edr/ACCEPTANCES.md`.

Originally: "This record is Proposed. It does not govern until the owner accepts it by name,
with the reviewer named." The open-source licence (Decision item 3) was chosen by the owner on
2026-10-21 at 20:47 UTC: Apache-2.0.

## Date

2026-10-21 (America/Chicago)

## Deciders

Christopher (owner). Implementer: Claude (builds end to end). Reviewer: Gpno (one final
review for Phase 3). Drafted by: Claude.

## Investigation

ESCROW-001, phase 3.

## Context

Phase 2 made the escrow a local developer kit: a registry, an oracle holding the secrets,
a ledger watcher and a TypeScript SDK, all on testnet and bound to 127.0.0.1. Its
Consequences section says the kit is "ready for outside developers to try in phase 3" and
that "exposing anything beyond localhost needs a new EDR".

The writeup's phased plan (`research/ai_settlement_model.md` section 7) puts a mainnet beta
and a hosted SaaS oracle in phase 3. That conflicts with two standing rules: the project is
testnet only, and the writeup itself says to get a crypto-specialized attorney's review
before handling third-party value or charging fees. The plan's phase 2 gate, "5 external
devs try it", has not been met, and the kit is not yet public. The owner also set the
language order as TypeScript first, Python second.

This EDR therefore takes the step the writeup's gate actually needs: make the kit usable by
outside developers, in both languages, while still on testnet and localhost. Hosting,
mainnet and the LLM judge are left to later EDRs.

## Decision

Build, still **testnet-only and local-only** (127.0.0.1):

1. **Phase 2 carry-overs.**
   - Reputation counts `expired_unclaimed` even after the job moves on to `refunded`
     (today the count reads the current status only, so it is always 0). Record the
     outcome when the job first reaches it, and add a test.
   - Resolve or document the npm 11 install-script warnings for `better-sqlite3` and
     `esbuild` (for example an `allowScripts`-style allowlist or a README note).
   - Exercise the two remaining NOT DEMONSTRATED items on testnet in a scripted run:
     `expired_unclaimed` and watcher reconnect (both passed on Windows on 2026-10-21; add
     them to `npm test` so they stay covered).
2. **Python SDK (`xrpl-escrow-py/`).** A client library with the same surface as the
   TypeScript SDK: `create_job()`, `fund_job()`, `deliver()`, `claim()`, `refund()`. It uses
   `xrpl-py` and talks to the same registry and oracle over HTTP. It does not port the
   services; they stay in TypeScript.
   - The same `network_id == 1` guard, seeds in a gitignored `.env`, validated results only.
   - Byte-for-byte parity with the TypeScript kit on the condition and fulfillment test
     vectors and on the signed-request format (the N2 canonical replay key included).
   - Verifies oracle verdicts against the pinned `ORACLE_VERDICT_ADDRESS`.
   - `pytest` suite, plus a `demo` that runs pass/claim and fail/refund against the local
     services on testnet. Works on Windows (no bash-only scripts).
3. **Release packaging for outside developers.**
   - One quickstart that brings up the registry, oracle and watcher with npm scripts and
     runs a first job from either SDK in under 15 minutes on a clean Windows machine.
   - An owner-chosen open-source licence (the package is ISC and `private: true` today),
     `CONTRIBUTING.md`, `SECURITY.md` (how to report a flaw), and a threat-model page that
     lists what the kit does not protect against (plain HTTP on 127.0.0.1, a single oracle
     key, no disputes).
   - A versioned release (`0.3.0`) with a changelog. Publishing to GitHub or a package
     registry is a separate owner approval, given per push.
4. **Developer trial kit.** A short feedback form and a written script for the "5 external
   devs" gate: what a tester runs, what they report, and where results are recorded
   (`docs/trial/`). Running the trial itself starts only after the owner approves the
   public release.

## Boundaries

- Phase 1 and 2 boundaries all still apply: no mainnet, the `network_id === 1` guard,
  faucet-funded wallets only, no contact with the XRP Intelligence Core paths
  (`xrp_*.py`, `decision/`, `frozen_xrp_engine/`, `live_shadow/`, `data/xrp_brain.db`), and
  no changes in PersonalAi.
- Deliverables and job specs are data, not instructions (`Agents.md` A3). The oracle must
  never execute deliverable content, and the Python SDK must not either.
- Services bind to 127.0.0.1 only. No hosted deployment, no user accounts, no third-party
  funds, no fees.
- Out of scope: mainnet, the hosted verifier and dashboard, the LLM judge, disputes and
  multisig, RLUSD, x402 and AP2 interop, payments, and a UI.
- No commit, merge or push without Christopher's approval, asked for each commit. A
  review request is not commit approval (Gpno N4).

## Acceptance evidence

- `npm test` passes, including the new reputation test and the `expired_unclaimed` and
  watcher-reconnect testnet flows.
- `pytest` passes in `xrpl-escrow-py/`, including the shared test vectors and a
  signed-request parity test against the TypeScript implementation.
- The Python demo prints pass/claim and fail/refund with
  `https://testnet.xrpl.org/transactions/<hash>` links and balances before and after, and
  the watcher's job statuses match the ledger.
- The quickstart is run end to end on Windows from a clean clone, by Claude Code on the
  owner's PC, with the log kept in `logs/`.
- The licence, `CONTRIBUTING.md`, `SECURITY.md`, threat model and changelog are present.
- Gpno's Phase 3 verdict is recorded in `xrpl-escrow/docs/reviews/VERDICT.md`, with the
  previous one archived.

## Consequences

The kit becomes something an outside developer can clone, run and judge in TypeScript or
Python, which is what the writeup's "5 external devs" gate and a grant application need.
Still nothing is exposed beyond localhost and no value is handled.

Later EDRs, each needing its own acceptance:
- a hosted verifier on testnet (TLS, authentication, rate limits, key management), which
  is the first step toward the subscription product;
- mainnet with tiny jobs, only after the attorney review the writeup calls for;
- an optional LLM-judge check, with the disputes, appeal path and logging that the
  writeup's legal section says it needs.
