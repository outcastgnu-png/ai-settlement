# Changelog

## 0.4.0 (Phase 4 auditable verifier, EDR-014; unreleased)

Still testnet only, and every service listens on 127.0.0.1 only.

### Added
- Public, hash-chained verdict log (`data/verdict-log.jsonl`). Each entry is signed by the
  oracle's verdict key and names the hash of the one before; entries hold hashes and
  outcomes only, never deliverables, check details, secrets or fulfillments. Read-only
  routes on the oracle: `GET /verdicts`, `GET /verdicts/head`, `GET /verdicts/anchors`.
- Testnet anchors: on a timer (`ANCHOR_INTERVAL_MS`, default 10 minutes) and on shutdown
  the oracle puts the log head in a memo on an `AccountSet` from a dedicated anchor wallet
  (`ORACLE_ANCHOR_SEED`, `ORACLE_ANCHOR_ADDRESS`, created by `npm run setup`).
- `verifyVerdictLog()` (TypeScript) and `verify_verdict_log()` (Python): check every
  signature against the pinned oracle address, the chain, and the newest anchor read from
  a validated ledger; optionally that your own verdict is in the log. Both SDKs give the
  same answers on `xrpl-escrow/test/vectors/verdict-log.json`. With a verdict, `ok` also
  needs the entry's public fields to match it and an anchor to cover it (`allowUnanchored`
  / `allow_unanchored` to accept the tail); every older anchor from the account is checked.
- `xrpl-tx-validated` check: the deliverable is a testnet transaction hash; it passes when
  the transaction is validated with `tesSUCCESS`, after the job was created, and matches
  the spec's type, destination, minimum delivered amount and optional sender, tag or memo.
- `npm run demo:phase4` and `test/phase4-flow.test.ts`; the Python demo now also checks
  the verdict log.

### Changed
- The oracle no longer appends to `data/verdicts.jsonl`; the file is kept as it was and
  its hash is in the new log's genesis entry. Asking the oracle again about a verified job
  returns the same signed verdict, so the log gets one entry per job and deliverable.
- A job's first signed verdict is final: the oracle loads it from the log (and a private
  signed copy) on start, answers later verifies with it, and never returns a fulfillment
  after a fail (Gpno N25). It refuses to start when the anchor account's anchors on the
  ledger disagree with its log (N29): one anchor wallet anchors one log.
- `.env` from 0.3.x: run `npm run setup` again to add the anchor wallet; the oracle won't
  start without it.
- Python SDK: `create_job()` takes keyword arguments only (`client`, `provider`,
  `price_drops`, `sla_seconds`, `spec`), like the fields of the TypeScript `createJob()`.
  A positional call now raises `TypeError` instead of quietly mixing up the price and the
  SLA. Breaking for code that called it positionally; the README example already uses names.

### Fixed
- Windows: saving the oracle's vault and replay files no longer fails now and then with `EPERM`
  when another process briefly has the file open; the rename over the old file is retried
  for about a second (seen in the Phase 4 Windows run).

## 0.3.1 (trial docs) - 2026-11-04

Docs and packaging only; no code changes. Still testnet only.

### Fixed
- Python SDK README: say what each call returns. `fund_job`, `claim` and `refund` return a
  `TxOutcome` (`.tx`, `.job`), not a dict, and `deliver` returns a `DeliverResult`, whose fields
  are now listed. The example passes `create_job`'s arguments by name. Reported by the first
  trial tester (MetaPhor).
- Give developer trial invitations, scripts and forms an explicit feedback email,
  current-form links for v0.3.0 users, and redaction/private-security-reporting
  instructions. Preserve the five-tester paid-job-plus-returned-form gate.

## 0.3.0 (Phase 3 developer preview, EDR-013) - 2026-10-21

Still testnet only, and every service listens on 127.0.0.1 only.

### Added
- Apache-2.0 licence (`LICENSE`, `NOTICE`). The security contact in `SECURITY.md`.
- Python SDK in `xrpl-escrow-py/`: `create_job`, `fund_job`, `deliver`, `claim`, `refund`,
  with the `network_id` guard, results from validated ledgers only, and verdicts checked
  against the pinned `ORACLE_VERDICT_ADDRESS`. Its signed requests, replay keys, canonical
  JSON and verdict signatures match the TypeScript kit byte for byte
  (`xrpl-escrow/test/vectors/sdk-parity.json`). The demo runs pass/claim and fail/refund on testnet.
- `test/phase3-flow.test.ts` in `npm test`: `expired_unclaimed` then refund, and watcher
  reconnect after a dropped WebSocket, on testnet. Both were only run by hand before.
- `QUICKSTART.md` and `xrpl-escrow/examples/first-job.ts`: a first job for a new developer.
- `CONTRIBUTING.md`, `SECURITY.md`, `docs/THREAT_MODEL.md`, and the developer trial kit in `docs/trial/`.

### Fixed
- Gpno N8: a `$ref` into `enum`, `const`, `default` or other data could carry a banned keyword
  (a catastrophic regex) past the schema policy, and Ajv would then run it (15.6 s for one
  check here). A `$ref` must now point at a subschema, and whatever it reaches is checked like
  the rest of the schema.
- Gpno N9: a slow schema, a worker restart, or a queue behind someone else's jobs could turn
  into a signed fail verdict for an honest job. Now only the job's own validation time counts
  against its 2 s timeout; a busy or restarting checker answers 503 with no verdict and the
  SDKs retry; at most 8 checks wait; a job has at most 8 checks; and a verified job's results are
  remembered, so asking again doesn't re-run them.
- Reputation now counts a job as `expiredUnclaimed` even after it is refunded. It used to
  count only jobs whose current status was `expired_unclaimed`, so the count was always 0.

### Changed
- Python SDK, from Gpno's Phase 3 review: `canonical_json` refuses values JavaScript would
  encode differently (floats, NaN, integers past 2^53, lone surrogates) and sorts keys by UTF-16
  code unit (N13, N14); `claim()` refuses a fulfillment that doesn't open the job's condition,
  and the docs say it does not check the verdict (N15); `submit_validated` raises a tem/tef/tel
  rejection at once instead of reporting it as expired (N16).
- `QUICKSTART.md` gets the code from the `v0.3.0` release at https://github.com/outcastgnu-png/ai-settlement, uses
  `npm ci`, and notes the macOS and Linux spellings (N17).
- Wallets are topped up from the faucet below 60 XRP (was 30), in both SDKs. Paid jobs drain
  the client for good, and below about 45 XRP the Phase 2 demo could not lock its third
  escrow (seen in `npm test` on 2026-10-21).
- `package.json` `allowScripts` denies the install scripts of `better-sqlite3` and `esbuild`,
  so npm 11 no longer warns. Both work without them (prebuilt binaries).
- Version 0.3.0 (was 1.0.0, a placeholder).

## Phase 2 (EDR-012), 2026-10-20 and 2026-10-21

Local registry, verification oracle, ledger watcher and TypeScript SDK; fixes for Gpno's
two reviews. See `xrpl-escrow/docs/reviews/`.

## Phase 1 (EDR-011), 2026-10-20

Testnet escrow demo: EscrowCreate with a PREIMAGE-SHA-256 condition, oracle, EscrowFinish
or EscrowCancel.
