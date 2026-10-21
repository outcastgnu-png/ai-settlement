# EDR acceptances

| EDR | Status | Accepted by | When (UTC) | Statement | Reviewer |
|---|---|---|---|---|---|
| EDR-011, ESCROW-001 Phase 1 testnet demo | Accepted | Christopher (owner) | 2026-10-20 17:04 | "I accept EDR-011 and EDR-012, reviewer Gpno" | Gpno |
| EDR-012, ESCROW-001 Phase 2 oracle and registry | Accepted | Christopher (owner) | 2026-10-20 17:04 | Same statement. He had also chosen "Accept and build" on a decision card at 07:31 | Gpno |
| EDR-013, ESCROW-001 Phase 3 developer preview | Accepted | Christopher (owner) | 2026-10-21 16:45 | "I accept EDR. As proposed, as Christopher is the owner, implementer is Claude, builds end-to-end. Reviewer, GPNO, one final review for phase three, drafted by Claude." Scope "Developer preview (as drafted)" chosen on a decision card at 16:39 | Gpno |

## Decisions on Gpno's second review (2026-10-21 05:40 UTC)

Christopher answered, in order: "approve, yes, restore, yes, keep the numbers".

| Item | Decision |
|---|---|
| N4: commit `e54e6d8` (handoff docs) made without explicit approval | Approved after the fact |
| Commit the fixes for N1, N2 and N6 | Yes |
| N3: four clauses dropped from EDR-011 | Restore them (done in `EDR-011_ESCROW_PHASE1_TESTNET_DEMO.md`) |
| N5: no approval in the owner's own hand | Christopher signs this file himself (below) |
| N7: EDR numbers continue PersonalAi's series | Keep the numbers |

## Owner signature

Everything above was written by the implementer from Christopher's messages. Christopher confirms
it by filling in and committing this line himself:

Signed: ______________________ (Christopher Terrell), date: ____________

Notes:
- No EDR-011 document existed before 2026-10-20. At Christopher's request (17:10 UTC) it was
  written down from `xrpl-escrow/CLAUDE.md` as `edr/EDR-011_ESCROW_PHASE1_TESTNET_DEMO.md`,
  with Status Accepted under the statement above.
- Gpno replaced Codex as the single final reviewer for both phases at 08:14 UTC. Gpno's verdict
  is in `xrpl-escrow/docs/reviews/VERDICT.md`.
- Christopher's statements were made in the project chat for ai_settlement_model.
