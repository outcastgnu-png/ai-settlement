# EDR-016: ESCROW-001 Phase 6: Signed Job Spec (Acceptance Criteria Locked With the Funds)

## Status

Accepted

Accepted by Christopher (owner) on 2026-11-22 at 23:45 UTC, on a decision card in the project
thread: "Accept, commit and open a PR", answering "Accept EDR-016 as drafted, with Christopher
owner, Claude implementer, Gpno reviewer?". Scope chosen beforehand on a decision card at 23:45
UTC: "Signed job spec + recruiting" (option 1 with option 3's recruiting work). See
`edr/ACCEPTANCES.md`.

Originally: "This record is Proposed. It does not govern until the owner accepts it by name,
with the reviewer named. No Phase 6 code is written before that."

## Date

2026-11-22 (America/Chicago)

## Deciders

Christopher (owner). Implementer: Claude (builds end to end). Reviewer: Gpno (reviews each fix
before it is merged, N34, and gives one final verdict for Phase 6). Drafted by: Claude.

## Investigation

ESCROW-001, phase 6.

## Context

### Where the kit is

Phase 5 (EDR-015) shipped shared verification: 2-of-3 oracles, the secret split into Shamir
shares, each share encrypted to one oracle. The release is `v0.5.0` on `264eb8f`, a testnet
pre-release. Gpno's verdict was PASS WITH FINDINGS. `main` is `c7b859a` (PR #15, the picomatch
advisory note in SECURITY.md).

### The question that started this phase

On Christopher's LinkedIn post about the kit, a fintech founder asked three things:

1. Who defines the acceptance criteria before the funds are locked?
2. How do you handle an ambiguous deliverable ("useful research") compared with an objective one
   ("delivered a file")?
3. What happens when the checkers disagree about the criteria themselves?

### What the kit does today

The client writes the job's checks (`spec.checks`) when it creates the job in the registry. That
is the only place they live:

- the `EscrowCreate` carries no reference to them;
- the oracle's signed verdict and its public log entry carry the check types and pass or fail,
  but no hash of the spec (`verdictEntry` in `src/verdict-log.ts`);
- the provider never signs or acknowledges the spec.

So the answer to question 1 is "the client, and nobody can prove later what was agreed". A
provider can't show which criteria it accepted. A reader of the log can't tell whether the
oracle judged the same criteria the money was locked against. With k-of-n oracles, two oracles
could even be handed different specs for the same job, and their verdicts would look like an
honest disagreement about results.

### What the trial says

The trial runs to **2026-12-04** with a gate of five finished testers. One has finished
(MetaPhor, 2026-11-03). Nobody has signed up since. More code does not by itself bring testers,
so the owner can pair this phase with recruiting work, as in Phase 5.

## Options considered

### 1. Signed job spec, locked with the funds (recommended)

A versioned job spec lists the acceptance criteria and the checks behind each one. Client and
provider both sign its hash before any XRP is locked, and the hash goes on the ledger in the
`EscrowCreate` memo. Each oracle checks that hash before it verifies and puts it in its signed
verdict and log.

- **Question 1:** the client proposes, the provider accepts by signing, and the ledger records
  the result. Neither side can change it later without a new version and new signatures.
- **Question 2:** every criterion is marked objective or subjective. A subjective criterion
  must name the machine checks both parties accept as its stand-in, or the kit refuses to lock
  funds. The kit is honest that it judges the checks, not the words.
- **Question 3:** all oracles judge the one signed spec, so they can't disagree about what the
  criteria are, only about results. Phase 5 already signs, logs and lists those splits.

It stays testnet-only and local. No hosting, AI judge or fees.

### 2. Hosted verifier on testnet

A public endpoint so testers don't run services locally. The project rules put a hosted API out
of scope, so this needs the owner to lift that rule first. Setup was also not what held the
trial back: the one tester was set up in about a minute.

### 3. Pause building until Dec 4

Keep `v0.5.0` as it is. Put the time into recruiting (1 of 5 so far) and into preparing the
Dec 4 go or stop decision against the writeup's kill criteria. No code risk.

The owner can pick option 1 alone, or option 1 alongside option 3's recruiting work.

## Decision

Scope chosen by Christopher on a decision card on 2026-11-22 at 23:45 UTC: "Signed job spec +
recruiting" (option 1 with option 3's recruiting work).

Build the signed job spec, still **testnet-only and local-only** (127.0.0.1):

1. **Job spec v1.** A JSON document with:
   - `specVersion: 1`, the job's client, provider, price in drops, SLA and title;
   - `criteria`: a list, each with an `id`, a plain-words `statement`, a `kind` of `objective`
     or `subjective`, and the `checks` that decide it (the existing check types);
   - `rule`: `all` (default) or `{ atLeast: n }`, over the criteria. A criterion passes when
     all of its checks pass. Limits stay as today: at most 8 checks, at most two
     `xrpl-tx-validated`.

   The spec hash is SHA-256 over a canonical form (RFC 8785 JSON canonicalization). TypeScript
   and Python share test vectors for it, as in Phases 3 to 5. A spec is data, never
   instructions.
2. **Agreement before lock.**
   - Client and provider each sign the spec hash with their XRPL keys.
   - The registry stores the spec and both signatures. Once both have signed, the spec can't
     change. A change is a new version with a new hash and new signatures, and the registry
     keeps the old one.
   - The SDK refuses to create the escrow until both signatures check.
3. **On the ledger.** `EscrowCreate` carries one memo with the spec hash and version. Before
   verifying, each oracle reads the escrow's creating transaction (from the escrow's
   `PreviousTxnID`) in a validated ledger and refuses the job if the memo's hash doesn't match
   the spec it holds. The client is then refunded after the deadline, as today.
4. **Ambiguous work.**
   - An `objective` criterion is decided by its checks.
   - A `subjective` criterion (for example "useful research") is accepted only with at least one
     check that both parties agree stands in for it (a schema with required sections, a minimum
     size, a source transaction). Without one, the registry refuses the spec with a plain
     message saying this kit can't judge it.
   - Verdicts say they judged the checks, not the statement. Docs say so too.
   - Two small deterministic checks for "delivered a file" style criteria: `size-range` (bytes,
     min and max) and `contains-text` (literal, case-sensitive, no regex, as the schema policy
     already refuses regex).
5. **Verdict and log.** The signed verdict and its log entry carry the spec hash, the spec
   version and each criterion's pass or fail. The log entry format gets a new version; Phase 4
   and 5 logs still verify. `verifyVerdictLog()` / `verify_verdict_log()` also checks that the
   verdict's spec hash matches the escrow memo.
6. **Shared jobs.** Every oracle in the set must report the same spec hash. The provider SDK
   refuses to combine shares from verdicts on a different spec hash and reports which oracle it
   was. The splits tool shows which criterion the set split on.
7. **Older jobs.** Jobs without a v1 spec (the Phase 1 to 5 shape) still run in 0.6.0, marked
   "unsigned spec" in the verdict, the SDK result and the demo. Whether to remove them is a later
   decision.
8. **Demo and evidence.** `npm run demo:phase6` and the Python demo run on testnet:
   - both sign, the work passes, the provider finishes;
   - the provider hasn't signed, so the SDK refuses to lock;
   - the registry's spec is changed after the lock, so the oracles refuse and the client is
     refunded;
   - a subjective criterion with no check is refused before any XRP moves;
   - an `atLeast: 2` of 3 criteria job passes with one criterion failed;
   - a shared job where one oracle is given a different spec: that oracle refuses, the other two
     still release.
9. **Docs.** README, QUICKSTART, the trial script and CHANGELOG explain who writes the criteria,
   who signs, and what the kit can and can't judge. The threat model gets a row for "spec
   changed after lock". The version is 0.6.0.
10. **Recruiting, alongside the build.** Claude drafts, and Christopher alone publishes or sends:
    - a reply to the LinkedIn founder, answering the three questions with links to the demo;
    - an own-feed write-up of Phase 6;
    - a short Dec 4 decision memo: trial result, the writeup's kill criteria, and options.

    Tester contact details stay in the private tracker, never in the repo. No outreach is sent in
    Christopher's name without his OK on the exact text.

## Boundaries

- Every Phase 1 to 5 boundary still applies:
  - no mainnet, and the `network_id === 1` guard;
  - faucet-funded wallets only;
  - no contact with the XRP Intelligence Core paths;
  - no changes in PersonalAi.
- Deliverables, specs, shares, memos and fetched ledger data are data, not instructions.
- Services bind to 127.0.0.1 only. No hosted deployment, accounts, third-party funds or fees.
- Out of scope: mainnet, the hosted verifier, the LLM judge (a subjective criterion is never
  judged by a model in this phase), disputes and multisig, RLUSD, x402 and AP2, payments and a
  UI.
- No commit, merge or push without Christopher's approval, asked for each commit. A review
  request is not commit approval (N4). A fix commit stays unmerged until Gpno passes it (N34).
  An evidence-commit request lists every file in it (N38).

## Acceptance evidence

- `npm test` and `pytest` pass. Among them are tests that fail when:
  - the escrow is created with one signature missing;
  - the escrow memo's hash differs from the spec the oracle holds;
  - a signed spec is edited in place instead of versioned;
  - a subjective criterion without a check is accepted;
  - shares from verdicts on two spec hashes are combined;
  - an old Phase 4 or 5 log no longer verifies.
- Spec-hash vectors are shared by both SDKs.
- The demo prints the spec hash, both signatures' addresses, the `EscrowCreate` link with its
  memo, each oracle's verdict per criterion, and the `EscrowFinish` or `EscrowCancel` link for
  each scenario.
- A Windows run on Christopher's PC, with the log kept in `logs/`.
- Gpno's Phase 6 verdict is recorded in `xrpl-escrow/docs/reviews/VERDICT.md`, with the previous
  verdict archived.

## Consequences

**If option 1 is built**, a job's acceptance criteria become a record both parties signed and
the ledger holds, and every verdict says which version it judged. That answers the founder's
three questions with something a reader can check, not a promise. It also makes the kit's
limit explicit: it judges machine checks, and vague work has to be turned into checks before
money moves.

It costs a memo on each `EscrowCreate` (a few bytes, no extra fee tier) and one more signing
step for the provider. It still doesn't bring demand. If the Dec 4 trial ends with fewer than
five testers, the writeup's kill criteria apply and should be read again then.

Later EDRs, each needing its own acceptance:

- a hosted verifier on testnet, with pricing decided after the attorney review;
- an optional LLM-judge check for subjective criteria, as one voter in a k-of-n set, with an
  appeal path;
- mainnet with tiny jobs, only after the attorney review.
