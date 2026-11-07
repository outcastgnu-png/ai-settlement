# EDR-014: ESCROW-001 Phase 4: Auditable Verifier (Public Verdict Log, Ledger-Transaction Check)

## Status

Accepted

Accepted by Christopher (owner) on 2026-11-07 at 18:14 UTC, on a decision card in the project
thread: "Accept, commit and open a PR", answering "Accept EDR-014 as drafted, with Christopher
owner, Claude implementer, Gpno reviewer?". Scope chosen beforehand on a decision card at 18:11
UTC: "Auditable verifier (as drafted)" (option 1 below). See `edr/ACCEPTANCES.md`.

Originally: "This record is Proposed. It does not govern until the owner accepts it by name,
with the reviewer named."

## Date

2026-11-07 (America/Chicago)

## Deciders

Christopher (owner). Implementer: Claude (builds end to end). Reviewer: Gpno (one final
review for Phase 4). Drafted by: Claude.

## Investigation

ESCROW-001, phase 4.

## Context

Phase 3 (EDR-013) shipped the developer preview: TypeScript and Python SDKs, quickstart,
licence, threat model and a trial kit. Gpno's final verdict was an unconditional PASS WITH
FINDINGS; N19 to N23 are fixed or documented (`xrpl-escrow/docs/reviews/FINDINGS_RESPONSE.md`).
v0.3.0 and v0.3.1 are released as testnet pre-releases.

### What the trial produced

The developer trial ran from 2026-10-23 to 2026-11-06. Its gate was five external developers
with a paid testnet job and a returned form (`docs/trial/README.md`). **One tester finished**
(MetaPhor, Python on Linux; `docs/trial/results/2026-11-03-MetaPhor.md`), so the gate is not
met. The recruiting posts on the LangChain and CrewAI forums were held or hidden by spam
filters; the XRPL Discord posts went through.

That tester builds AgentTrust, a peer project that uses the same mechanism (XRP
crypto-condition escrow released on a pass) with an AI review as the judge, live on mainnet
with per-check fees. Their answers are useful, but they are one data point and come from a
competitor, so this EDR treats them as input, not as demand.

What they said, by form question:

| Q | Answer | What it points to |
|---|---|---|
| 4, 7 | No blockers. v0.3.0 tag predated the trial-kit fixes; Python SDK return types undocumented; positional `create_job` | Fixed in v0.3.1 and 0.4.0 (unreleased) |
| 8 | Signed verdict is enough for deterministic checks; the remaining trust is the single oracle operator. For real funds: "a public verdict log or a second oracle" | Verdict log (this EDR); second oracle (later) |
| 9 | Would escrow a short research answer as JSON with sources, released if the structure is right and on time | Already covered by `json-schema` + `max-latency` |
| 10 | Missing: a quality check (is the answer right and on topic); an "XRPL tx exists and is validated" check would be cheap and useful | Ledger-transaction check (this EDR); quality/LLM judge (later) |
| 11 | Hosted for small teams, priced per check rather than monthly (AgentTrust charges $0.10 per AI check) | Input for the hosted-verifier EDR; per-check pricing needs the attorney review first |

### What the kit already has

The oracle already appends every signed verdict to a local JSONL file
(`src/oracle/server.ts`). Nobody outside the machine can read it, the entries are not
chained, and nothing stops the operator from rewriting it. So today a client or provider can
check one verdict's signature, but cannot check that the oracle hasn't quietly issued, hidden
or changed others.

## Options considered

1. **Auditable verifier (recommended).** Make the existing verdict log tamper-evident and
   readable, anchor it on testnet, and add a ledger-transaction check. Answers Q8 and half of
   Q10, stays local and testnet only, needs no hosting, no money and no legal review, and is
   a difference from an AI-judged competitor: every verdict is reproducible and auditable.
2. **Hosted verifier on testnet.** TLS, accounts, API keys, rate limits, a secrets store, a
   public endpoint. This is the subscription product's first step, but it means running and
   paying for a server, with one tester's input behind it, who asked for per-check pricing
   (a fee per job is the case the writeup says needs an attorney first).
3. **LLM-judge check.** Answers the quality half of Q10, but the competitor already sells
   exactly this, and the writeup ties it to a dispute and appeal path and logging. Option 1's
   log is a prerequisite for it anyway.
4. **Two or more oracles (k-of-n).** Split each job's secret with Shamir shares across
   independent oracles so no single operator can release funds. The strongest answer to Q8,
   but it needs other operators to exist. Recorded as a later EDR.

Mainnet stays out until the attorney review. RLUSD, disputes and multisig, and x402 stay out
of scope.

## Decision

Build option 1, still **testnet-only and local-only** (127.0.0.1):

1. **Hash-chained verdict log.**
   - Each entry holds the signed verdict, a sequence number and the SHA-256 of the previous
     entry, so dropping, reordering or editing an entry breaks the chain.
   - Entries hold hashes only: the job id, condition, provider, check results and the
     evidence hash, never deliverable content, specs' private data, secrets or fulfillments.
   - The oracle serves the log read-only (`GET /verdicts`, paged, and `GET /verdicts/head`).
   - Existing unchained log files are kept as they are; the chain starts fresh with a
     genesis entry that names the old file's hash.
2. **Testnet anchoring.** On a schedule and on shutdown, the oracle publishes the current
   chain head (sequence number and hash) in a `Memo` on a small testnet transaction from a
   dedicated faucet-funded anchor wallet. Anyone can then compare a log copy against the
   ledger. The `network_id === 1` guard applies; the anchor wallet's seed lives in `.env`.
3. **Log verification in both SDKs.** `verifyVerdictLog()` / `verify_verdict_log()` fetch
   the log, check every signature against the pinned `ORACLE_VERDICT_ADDRESS`, check the
   chain, and check the latest anchor on a validated ledger. A client or provider can also
   check that their own job's verdict is in the log. Parity vectors shared by both SDKs, as
   in Phase 3.
4. **`xrpl-tx-validated` check.** The job spec names what must be true of a testnet
   transaction (type, destination, minimum amount, and optional memo or destination tag);
   the deliverable gives its hash. The oracle reads the transaction from a validated ledger
   only and passes when it succeeded (`tesSUCCESS`) and every field matches. The hash is
   parsed strictly (64 hex characters); nothing else in the deliverable is read. Lookups are
   capped per job and time out like the other checks.
5. **Carry-overs.**
   - Release 0.4.0 with the keyword-only Python `create_job()` already on main.
   - Push the Windows-run evidence for `eb0c313` (local commit `e80f884` on Christopher's
     PC, rebased onto current main), with his OK.
   - Update `docs/THREAT_MODEL.md`: the "one oracle, one key" row now says what the log and
     anchors do and don't protect (an oracle can still sign a wrong verdict; it just can't
     hide it).
6. **Trial continues.** The five-tester gate stays open. Invitations point at the 0.4.0
   release. The owner set the new end date on 2026-11-07: **2026-12-04**.

## Boundaries

- Phase 1 to 3 boundaries all still apply: no mainnet, the `network_id === 1` guard,
  faucet-funded wallets only, no contact with the XRP Intelligence Core paths, and no
  changes in PersonalAi.
- Deliverables, specs and fetched ledger data are data, not instructions (`Agents.md` A3).
- Services bind to 127.0.0.1 only. No hosted deployment, accounts, third-party funds or
  fees.
- Out of scope: mainnet, the hosted verifier, the LLM judge, multiple oracles, disputes and
  multisig, RLUSD, x402 and AP2, payments and a UI.
- No commit, merge or push without Christopher's approval, asked for each commit. A review
  request is not commit approval (Gpno N4).

## Acceptance evidence

- `npm test` and `pytest` pass, including tests that fail when an entry is edited, removed
  or reordered, when a signature is wrong, and when the anchor on the ledger doesn't match.
- The `xrpl-tx-validated` check has passing and failing testnet runs, including a
  transaction that exists but failed (`tec*`), one on an unvalidated ledger, and a malformed
  hash.
- `npm run demo` and the Python demo print the log head, its anchor's
  `https://testnet.xrpl.org/transactions/<hash>` link, and a successful log verification.
- A Windows run on Christopher's PC with the log kept in `logs/`.
- Threat model and changelog updated; Gpno's Phase 4 verdict recorded in
  `xrpl-escrow/docs/reviews/VERDICT.md`, with the previous one archived.

## Consequences

The verifier becomes auditable: anyone can check that the oracle issued every verdict it
claims, in order, unchanged. That is the base the hosted verifier, the LLM judge and
multiple oracles all need, and it costs nothing to run.

It does not add demand. With one finished tester, the writeup's phase 3 gate (paying teams
or a grant) is still far off, and its kill criteria (no paying team after phase 3, or
Ripple/t54 shipping an equivalent) now also have to be read against AgentTrust being live.

Later EDRs, each needing its own acceptance:
- a hosted verifier on testnet (TLS, authentication, rate limits, key management), with
  pricing decided after the attorney review;
- an optional LLM-judge check with an appeal path, logged through this EDR's verdict log;
- multiple oracles (k-of-n secret shares);
- mainnet with tiny jobs, only after the attorney review.
