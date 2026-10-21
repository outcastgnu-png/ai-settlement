# ESCROW-001: earned status under PersonalAi's rules

Assessed 2026-10-21 against `PersonalAi\Agents.md` §9 (Earned-State Discipline), the earned-tier
ranking in `PersonalAi\earned-strengths-canvas\PROVENANCE.md`, and `PersonalAi\edr\EDR-010`.
PersonalAi was only read. No file there was changed.

## What PersonalAi says about where EDRs go

- EDR-010, decision 7: "Decision records live in `edr/` only. A Proposed EDR records a decision.
  Only an Accepted EDR, earned by evidence and owner approval, is architectural truth."
- `Agents.md` §1: tier 3 governance is "EDRs in `edr/` whose Status is Accepted".
- PersonalAi's `edr\` runs EDR-001 to EDR-010 (no 004 or 009). EDR-011 and EDR-012 continue that
  numbering, but neither file is in `PersonalAi\edr\`. Nothing in PersonalAi mentions ESCROW-001,
  escrow or ai-settlement.
- `edr\README.md` says the EDRs there record decisions for the XRP Intelligence Core.

So in PersonalAi's terms, EDR-011 and EDR-012 are not tier 3 governance for PersonalAi. They are
Accepted only where they sit, in `ai-settlement\edr\`.

## Earned tier (PROVENANCE.md ranking)

| Item | Tier | Evidence |
|---|---|---|
| Phase 1 and Phase 2 code at `deb71ea` | 1, committed with tests and evidence, **in the cloud copy only** | commits `ed122ab`, `deb71ea`; Phase 1 18/18; Phase 2 47/47 and 46/46 tests on testnet |
| Fixes for Gpno findings 3 to 7, EDR-011 file, ACCEPTANCES.md | 3, working tree only (held) | 52/52 unit, 49/49 demo, 54/54 tests on testnet; not committed, not re-reviewed |
| Anything at `C:\dev\ai-settlement\` | not verified | this session can't see `C:\dev\` |

A commit proves preservation, not truth or ratification.

## Earned (§9 vocabulary)

- **Proposed, then accepted:** EDR-011 and EDR-012, accepted by Christopher by name on
  2026-10-20 17:04 UTC, reviewer Gpno. EDR-011 was written down afterwards from
  `xrpl-escrow\CLAUDE.md`.
- **Evaluated:** Gpno reviewed `deb71ea`: PASS WITH FINDINGS (2 governance blockers, 5 fixes).
- **Supported (internal):** testnet runs with explorer links, Linux only.

## Unearned

- Gpno's evaluation of the fixes. Their only evidence is the implementer's own runs.
- Commit approval for the fixes and EDR-011.
- Preservation on Christopher's PC (`C:\dev\ai-settlement\` not confirmed).
- NOT DEMONSTRATED: Windows run, README quickstart, `expired_unclaimed` on testnet, watcher
  reconnect.
- Worker timeout for schema checks; TLS for anything beyond localhost.
- Recommended, promoted, published, externally replicated, authorized for outreach: none.
- Mainnet, real funds, hosted service: out of scope and not authorized.
