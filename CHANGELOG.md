# Changelog

## 0.6.0 (Phase 6 signed job spec, EDR-016) - unreleased

Still testnet only, and every service listens on 127.0.0.1 only.

### Added
- Job spec v1 (`src/job-spec.ts`, `xrpl_escrow/job_spec.py`): `specVersion: 1`, a revision and
  nonce, the title, client, provider, price and SLA, a list of `criteria` (each with an `id`, a
  plain-words `statement`, a `kind` of `objective` or `subjective`, and its `checks`) and a `rule`
  (`"all"` or `{ "atLeast": n }`). A criterion passes when all its checks pass. The spec hash is
  SHA-256 over the RFC 8785 canonical form (`jcs`, `specHash` / `spec_hash`); a value that could
  encode differently (a fraction, an unsafe integer, a lone surrogate) is refused.
- Agreement before lock. `makeJobSpec` / `make_job_spec`, `createSignedJob` / `create_signed_job`,
  `signSpec` / `sign_spec` (the signer passes the hash of the spec it read; the SDK works it out
  again and refuses to sign a different one). Client and provider sign the spec hash with their
  XRPL keys (`signSpecHash`, `verifySpecSignature`). Registry routes
  `POST /jobs/:id/spec/signatures`, `PUT /jobs/:id/spec` (the next revision; a signed spec is never
  edited in place, and the old revision is kept) and `GET /jobs/:id/spec/revisions`.
  `fundJob` / `fund_job` refuse to lock XRP until both signatures check.
- The `EscrowCreate` of a signed job carries one memo (`xrpl-escrow/job-spec`) with the spec hash,
  version and revision. Before verifying, every oracle reads the escrow's creating transaction from
  its `PreviousTxnID` in a validated ledger and signs nothing (`409`) when the memo doesn't match the
  registry's spec or a signature doesn't check (`src/spec-ledger.ts`).
- A `subjective` criterion needs at least one check, or the spec is refused with "This kit can't
  judge that statement". Verdicts say `judged: "checks"`.
- Checks `size-range` (bytes of the deliverable, min and max) and `contains-text` (literal,
  case-sensitive, at most 256 bytes, no regex).
- Signed verdicts carry `specHash`, `specVersion`, `specRevision` and `criteria` (each criterion's
  pass or fail); each check result names its criterion.
- Verdict log entries version 2 with the same spec fields. Phase 4 and 5 logs (version 1) still
  verify; a version 1 entry after a version 2 entry fails. `verifyVerdictLog` /
  `verify_verdict_log` with `job` also check the verdict's spec hash against the escrow memo
  (`specOnLedger` / `spec_on_ledger`).
- Shared jobs with a signed spec: every oracle must report the job's spec hash. The SDK never
  combines a share from a verdict on another spec and names the oracle; an oracle that refuses the
  job is reported as `refused`. `GET /splits` and `npm run splits` show the criteria the set split on.
- `npm run demo:phase6`, the Python demo `python -m xrpl_escrow.demo_phase6`,
  `test/job-spec.test.ts`, `test/signed-spec.test.ts`, `test/phase6-flow.test.ts`,
  `tests/test_job_spec.py`, and shared vectors `test/vectors/job-spec.json`
  (`make-job-spec-vectors.ts`).

### Changed
- Jobs with the Phase 1 to 5 `spec.checks` shape still run, marked `unsignedSpec` /
  `unsigned_spec` in the SDK result.
- The registry refuses an oracle verdict on a spec hash other than the job's.
- `test/vectors/verdict-log.json` is kept as Phase 4 and 5 version 1 vectors and must not be
  regenerated.

## 0.5.0 (Phase 5 shared verification, EDR-015) - 2026-11-21

Still testnet only, and every service listens on 127.0.0.1 only.

### Added
- Shared jobs, k of n oracles (default 2 of 3). `createSharedJob()` / `create_shared_job()`:
  the client makes the secret, splits it with Shamir's scheme over GF(256) (`src/shamir.ts`,
  `xrpl_escrow/shamir.py`), seals each share to one oracle (`src/share-box.ts`,
  `xrpl_escrow/share_box.py`: X25519, HKDF-SHA256, AES-256-GCM, bound to the job, the oracle and
  the share index) and registers the job, signed by the client, with its oracle set, threshold
  and condition. The secret is never stored or logged; the registry never sees a share.
- Each oracle has an X25519 share key (`ORACLE_SHARE_KEY`), shown on `/health` with a signature
  by its verdict key. New oracle route `POST /jobs/:jobId/share`, which takes only the client's
  share sealed to this oracle at its own index, while the job is a draft. On its own signed pass
  the oracle returns its share (`share`) instead of a fulfillment. Shared verdicts carry
  `shareIndex` and `threshold`.
- `deliverShared()` / `requestSharedVerification()` (Python: `deliver_shared()`,
  `request_shared_verification()`): asks every oracle of the set, checks each signed verdict
  against its pinned address and that oracle's own verdict log, and combines k shares into the
  fulfillment (`combineForCondition` / `combine_for_condition`, which never uses a share from
  outside the set). It reports which oracles passed, failed, were rejected or unreachable.
  `requireAnchored` / `require_anchored` uses only anchored verdicts.
- Registry: shared jobs, `POST /jobs/:id/verdicts` (a signed verdict from an oracle of the set;
  verified_pass after k passes, verified_fail once k passes can no longer happen),
  `GET /jobs/:id/verdicts`, and `GET /splits` with `npm run splits` (jobs where the set disagreed).
- `npm run setup` makes local oracles B and C (`.env.oracle-b`, `.env.oracle-c`,
  `data/oracle-b`, `data/oracle-c`, each with its own keys and faucet-funded anchor wallet);
  `npm run oracle:b` and `npm run oracle:c` start them on ports 8803 and 8804.
- `ORACLE_FAULT=fail` starts a dissenting oracle that signs fail on every job (demos and tests).
- `npm run demo:phase5`, the Python demo `python -m xrpl_escrow.demo_phase5`, `test/shared.test.ts`,
  `tests/test_shared_vectors.py`, `tests/test_shared_local.py`, and shared vectors
  `test/vectors/shamir.json` and `share-box.json` (`make-shared-vectors.ts`).

### Changed
- An oracle's service token can no longer set a shared job's condition or status.
- The Python SDK depends on `pycryptodome` directly (xrpl-py already needed it).
- Single-oracle jobs work as before.

### Fixed
- Gpno N37: the oracle now checks every entry of its log on start, not only the first for each job.
  A second verdict entry for a job makes it refuse to start, so it never anchors a log that says a job
  has two verdicts. `verifyVerdictLog` / `verify_verdict_log` fail on such a log for every reader, and
  with a verdict they compare every entry that names it (`findVerdict` / `find_verdict`). New:
  `duplicateJobProblems` / `duplicate_job_problems`.

## 0.4.0 (Phase 4 auditable verifier, EDR-014) - 2026-11-15

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
- Gpno's second Phase 4 review: the oracle refuses to start when a signed verdict in its private
  copy disagrees with the public entry it is linked to, and never serves one (N26); an
  incomplete read of the anchor account's history makes `verifyVerdictLog` /
  `verify_verdict_log` fail and the oracle refuse to start (N32; the lookback is now 10,000
  transactions); a signed verdict whose public entry failed to write is still the job's verdict
  and is logged on the next ask (N33); a 0.3.x `verified_pass` with nothing in the log answers 409
  like a `verified_fail` (N36).
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
