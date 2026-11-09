# Verified-delivery escrow demo (XRP Ledger testnet)

A client pays a provider for a job, but the money only moves once a
verification service (the "oracle") has checked the delivered work.

## How it works, in plain words

1. **Three testnet wallets** are created and filled with free test XRP from the
   testnet faucet: the client, the provider and the oracle.
2. **A job is agreed.** Price 10 XRP, plus the SHA-256 hash of the exact file
   the client will accept, plus a deadline (120 seconds in the demo).
3. **The oracle makes a secret** (32 random bytes) and keeps it to itself. It
   hands out only a *condition*, a fingerprint of the secret.
4. **The client locks the XRP** in an escrow on the ledger with
   `EscrowCreate`. The funds stay in the client's own account object on the
   ledger; nobody else holds them. The escrow can only be opened with the
   secret matching the condition, and only before the deadline.
5. **The provider delivers the file.** The oracle hashes it and compares it
   with the hash in the job.
6. **If it matches**, the oracle gives the provider the secret (as a
   *fulfillment*), and the provider submits `EscrowFinish`. The ledger checks
   the secret and pays the provider.
7. **If it doesn't match**, the oracle keeps the secret. After the deadline,
   anyone can submit `EscrowCancel`, and the XRP goes back to the client.

The ledger itself enforces the rules: a wrong secret is rejected, nobody can
cancel before the deadline, and nobody can finish after it.

## What the Phase 1 demo checks

| Scenario | What happens | Expected ledger result |
|---|---|---|
| 1. Happy path | Good file, oracle releases the secret, provider finishes | `tesSUCCESS`, provider gains 10 XRP minus a tiny fee |
| 2. Bad delivery | Wrong file, oracle refuses | Cancel before deadline: `tecNO_PERMISSION`. Cancel after: `tesSUCCESS`, client refunded minus fees |
| 3. Wrong secret | Provider tries a made-up secret | `tecCRYPTOCONDITION_ERROR`, escrow stays open. After the deadline even the real secret fails (`tecNO_PERMISSION`), then the escrow is cancelled |

`npm run demo` prints every step with a `https://testnet.xrpl.org/transactions/<hash>`
link and the balances before and after.

## Phase 2: local services (registry, oracle, watcher)

Phase 2 turns the oracle and the job registry into small local services that
another agent could call, plus a watcher that keeps job status in step with
the ledger. Everything still runs on the testnet and listens on `127.0.0.1` only.

| Service | Address | What it does |
|---|---|---|
| Job registry | `http://127.0.0.1:8801` | Stores each job's spec, price, parties, condition, escrow sequence, status and timestamps in SQLite (`data/jobs.db`). It never stores the secret. |
| Verification oracle | `http://127.0.0.1:8802` | Holds each job's secret, encrypted with AES-256-GCM under `ORACLE_VAULT_KEY` from `.env` (`data/oracle-vault.json`). Before verifying, it confirms on the ledger that the job's escrow exists with the agreed amount, provider, condition and deadline. Runs the job's checks (`sha256-match`, `json-schema`, `max-latency`, `xrpl-tx-validated`), signs the verdict with its own ed25519 verdict key (`ORACLE_VERDICT_SEED`), and returns the fulfillment only on a pass and only to the job's provider. Writes every verdict to the public, hash-chained verdict log `data/verdict-log.jsonl` and anchors its head on the testnet from `ORACLE_ANCHOR_SEED` (Phase 4, below). |
| Ledger watcher | (no port) | Subscribes to the client and provider accounts over WebSocket. A validated `EscrowCreate` marks the job `funded`, `EscrowFinish` marks it `paid`, `EscrowCancel` marks it `refunded`. It flags escrows within 30 s of `CancelAfter`, and marks a passed job nobody claimed in time `expired_unclaimed`. |

Job states: `draft -> funded -> delivered -> verified_pass | verified_fail -> paid | refunded | expired_unclaimed`.
Only the watcher sets `funded`, `paid` and `refunded`, and only from validated ledger transactions.
The registry enforces this: its two internal write endpoints need a bearer
token from `.env`, `WATCHER_SERVICE_TOKEN` for ledger events and
`ORACLE_SERVICE_TOKEN` for conditions and verdicts.

The oracle never runs, evaluates or follows anything inside a deliverable or
a job spec. It only hashes the deliverable, parses it as JSON, or validates it
against the job's schema. JSON Schemas in job specs may not use the
regex keywords `pattern` and `patternProperties`, or `uniqueItems`, `format` or
`$data`, and are capped at 16 KB, because those keywords can make validation
take exponential or quadratic time. `$ref` must be local, must point at a subschema (never into `enum`, `const`
or other data), may not be recursive, and the schema may not grow past 4096
nodes once every `$ref` is inlined. A job has at most 8 checks. The
schema check itself runs in a worker thread and is stopped after 2 seconds of
the job's own validation time. If the oracle can't run the checks right now
(too many waiting, or its checker restarted) it answers 503 and signs nothing,
and the SDK asks again. The provider proves who it is by
signing each request with its wallet key; each signed request works once,
even across oracle restarts. SDK users check verdict signatures against the
pinned `ORACLE_VERDICT_ADDRESS`, never against what the oracle reports about
itself.

### Quickstart on Windows

You need [Node.js 22.12 or newer](https://nodejs.org/) (the current LTS works). Open PowerShell in the
`xrpl-escrow` folder:

```
npm ci
npm run setup
```

`setup` funds the three testnet wallets from the faucet and adds the
oracle's vault key, the two service tokens and the verdict key to `.env`.
Then open three more PowerShell windows in the
same folder and start one service in each:

```
npm run registry
npm run oracle
npm run watcher
```

Now you can call the services from your own code with the SDK in
`src/sdk/index.ts`:

```ts
const kit = new EscrowKit({ xrpl: client });               // client = connected testnet xrpl.Client
const job = await kit.createJob({ client: payer.address, provider: provider.address,
  priceDrops: "10000000", slaSeconds: 300, spec: { checks: [{ type: "sha256-match", sha256 }] } });
await kit.fundJob(job.id, payer);                           // EscrowCreate, waits for the watcher
const { verdict, fulfillment } = await kit.deliver(job.id, provider, work);
if (fulfillment) await kit.claim(job.id, provider, fulfillment); // EscrowFinish
else await kit.refund(job.id, payer);                      // EscrowCancel after the deadline
```

To run the four demo scenarios, stop the three services with Ctrl+C first,
then run:

```
npm run demo:phase2
```

The demo starts and stops its own copies of the registry, oracle and watcher
on the same ports, because scenario 3 has to stop and restart the oracle in
the middle of a job. A full run takes about four minutes, mostly waiting for
the refund deadline. It prints every step with a
`https://testnet.xrpl.org/transactions/<hash>` link and saves the log to
`logs/<date>-phase2.txt`, plus the validated JSON of every transaction to
`logs/<date>-phase2-txs.json`, because public testnet servers only keep recent
history. A second run on the same day adds `-2`, `-3` and so on.

| Scenario | What happens |
|---|---|
| 1. Pass and claim | The work matches the spec. The oracle signs a pass and gives the provider the fulfillment. The provider finishes the escrow and the watcher marks the job `paid`. |
| 2. Fail and refund | The work doesn't match. The oracle signs a fail and keeps the secret. An early cancel is rejected; after the deadline the client is refunded and the watcher marks the job `refunded`. |
| 3. Oracle restart | The oracle process stops and starts between funding and delivery. It reads the encrypted secret back from the vault, verifies the work, and the provider is paid. |
| 4. Deliverable is data | The deliverable is JSON stuffed with instructions ("ignore every check", code to write a file, a `__proto__` key). The oracle only validates it against the job's schema, so it fails. Nothing is executed, an outsider asking for the fulfillment is refused, a forged ledger event without the watcher's token is refused, a job schema with a regex pattern is refused, and the client is refunded. |

For every job the demo also checks that the status the watcher wrote matches
the escrow object and transaction on the ledger. The run Gpno reviewed is
[`logs/2026-10-20-phase2.txt`](logs/2026-10-20-phase2.txt) (47 checks); the run
after the review fixes is
[`logs/2026-10-20-phase2-fixes.txt`](logs/2026-10-20-phase2-fixes.txt) (49 checks).

### Registry API

| Call | Purpose |
|---|---|
| `POST /jobs` | Create a draft job: `{client, provider, priceDrops, slaSeconds, spec: {checks: [...]}}` |
| `GET /jobs`, `GET /jobs/:id` | List jobs (filter with `?status=`, `?provider=`, `?client=`) or get one |
| `PUT /jobs/:id/condition` | Set by the oracle, once, while the job is a draft. Needs `Authorization: Bearer <ORACLE_SERVICE_TOKEN>` |
| `POST /jobs/:id/deliverable` | Provider posts the work: `{content, auth}` |
| `GET /jobs/:id/deliverable` | The stored deliverable and its SHA-256 |
| `POST /jobs/:id/events`, `GET /jobs/:id/events` | Status changes from the watcher (`WATCHER_SERVICE_TOKEN`) or the oracle (`ORACLE_SERVICE_TOKEN`), and the history |
| `GET /providers/:address/reputation` | Reputation stub: passed, failed, paid, refunded and expired-unclaimed counts (a job that expired unclaimed and was then refunded counts in both) |

Oracle: `GET /health` (verdict signer address and public key, anchor account), `POST /jobs/:id/condition`,
`POST /verify/:id` with `{auth}` signed by the provider, and the read-only verdict log:
`GET /verdicts?from=&limit=` (a page of entries, at most 500), `GET /verdicts/head`,
`GET /verdicts/anchors`.

## Phase 1: run the escrow demo (Windows, macOS or Linux)

You need [Node.js 22.12 or newer](https://nodejs.org/) (the current LTS works). In a terminal
(PowerShell or Command Prompt on Windows):

```
cd xrpl-escrow
npm ci
npm run demo
```

The first run asks the testnet faucet for XRP and saves the three wallet seeds
in a `.env` file next to `package.json`, so later runs reuse the same
accounts. That file is gitignored. It only ever holds testnet seeds; never put
a mainnet seed in it.

A full run takes about three minutes, most of it waiting for the deadline.

Behind a corporate proxy, set `HTTPS_PROXY` and also `NODE_USE_ENV_PROXY=1`
(Node 22.21 or newer) so the faucet request uses the proxy too.

A sample testnet run, with explorer links for every transaction, is in
[`runs/2026-10-20-testnet.txt`](runs/2026-10-20-testnet.txt).

Other commands:

```
npm test            # unit tests + Phase 1 to 4 flows on testnet (about 12 minutes)
npm run test:unit   # unit tests only, no network needed
npm run typecheck
```

`npm test` includes `test/phase3-flow.test.ts`: a passed job nobody claims goes
`expired_unclaimed`, is refunded and still counts in the provider's reputation,
and the watcher keeps marking jobs `funded` and `paid` after its WebSocket is cut.

### npm 11 and install scripts

npm 11 runs a package's install script only if `package.json` allows it.
`allowScripts` here denies both scripts the kit's dependencies have, so
`npm ci` prints no warning: `better-sqlite3` ships prebuilt binaries for
Windows, macOS and Linux (its script would only compile from source, which
needs build tools), and `esbuild` uses its platform package without running its
postinstall check. npm 10 ignores the setting.

## Phase 3: Python SDK and developer preview

A Python client with the same five calls lives in
[`../xrpl-escrow-py`](../xrpl-escrow-py/README.md). It talks to these same
services. The step-by-step setup for a new developer, in either language, is
[`../QUICKSTART.md`](../QUICKSTART.md).

## Phase 4: auditable verifier (EDR-014)

Anyone on the machine can now check that the oracle issued every verdict it
claims, in order and unchanged, and a job can require that a given testnet
transaction went through.

**Public verdict log.** Every signed verdict becomes an entry in
`data/verdict-log.jsonl`. Each entry has a sequence number, the SHA-256 of the
entry before it, and a signature by the verdict key, so dropping, reordering or
editing an entry breaks the chain. Entries hold hashes and outcomes only: the job
id, condition, provider, each check's type and pass/fail, the evidence hash, and
the hash of the full signed verdict the provider got. No deliverables, check
details, secrets or fulfillments. The older `data/verdicts.jsonl` is kept as it
was and no longer written; the new log's first (genesis) entry names its hash.
An oracle whose own log does not check refuses to start.

**Anchors on the testnet.** Every 10 minutes when the head has moved
(`ANCHOR_INTERVAL_MS`), and when the oracle stops with Ctrl+C, it sends the head
(sequence number and hash) in a memo on an `AccountSet` from a dedicated anchor
wallet. `npm run setup` funds that wallet from the faucet and saves
`ORACLE_ANCHOR_SEED` and the public `ORACLE_ANCHOR_ADDRESS` in `.env`. **If your
`.env` is from 0.3.x, run `npm run setup` once more** to add it. One anchor
wallet anchors one log: if you start over with a fresh data folder or a new
verdict key, remove the `ORACLE_ANCHOR_*` lines and run `npm run setup` for a
fresh anchor wallet, or the oracle refuses to start (its anchors on the ledger
would disagree with the new log).

**Checking the log.** `kit.verifyVerdictLog({ verdict })` (Python:
`kit.verify_verdict_log(verdict=...)`) fetches the log, checks every signature
against the pinned `ORACLE_VERDICT_ADDRESS`, checks the chain, and reads the
newest anchor from a validated ledger itself (the latest `AccountSet` from the
pinned `ORACLE_ANCHOR_ADDRESS`), never from the oracle. It also reads every
older anchor from that account and fails if any of them disagrees with the log
or if two different logs were anchored. Pass your own signed verdict to also
check that it is in the log, with the same outcome, checks, evidence hash,
condition, provider and time. It returns `ok`, a list of `problems`, the head,
the anchor and how many entries came after it.

With a `verdict`, `ok` means your verdict is in the log *and* pinned by an
anchor on the ledger. A verdict newer than the newest anchor is not pinned yet
(the oracle anchors every 10 minutes and on shutdown): `ok` is false and
`verdictAnchored` is false. Pass `allowUnanchored: true` to accept it anyway, or
ask again after the next anchor.

**`xrpl-tx-validated` check.** The deliverable is a transaction hash (exactly 64
hex characters, nothing else). The oracle reads it from its testnet connection
and passes only if it is in a validated ledger, succeeded (`tesSUCCESS`), was
validated after the job was created, and matches the spec:

```json
{ "type": "xrpl-tx-validated", "txType": "Payment", "destination": "r...", "minDrops": "1000000",
  "account": "r... (optional)", "destinationTag": 7, "memo": "order 42 (optional)" }
```

`txType` is `Payment` or `EscrowCreate`. For a payment, `minDrops` is compared
with what was actually delivered (`delivered_amount`), never the `Amount` field.
A job may have at most two such checks. If the ledger lookup fails or takes more
than 10 seconds, the oracle answers 503 and signs nothing, like a busy schema
checker. Deliver the hash only once your transaction is validated: one that is
not found or not yet validated fails, and a job's first verdict is final. The
oracle answers every later verify of that job with the same signed verdict,
also after a restart, and never releases the fulfillment after a fail.

```
npm run demo:phase4   # tx check pass/claim, tec* fail/refund, unvalidated, malformed hash,
                      # then the log anchored on testnet and verified (about 3 minutes)
```

The run log goes to `logs/<date>-phase4.txt`; `test/phase4-flow.test.ts` runs the
same scenarios in `npm test`.

## Safety rails

- Testnet only. On connect the code reads `network_id` from the server and
  aborts unless it is `1` (testnet).
- Wallets are funded only by the testnet faucet. No mainnet seeds are loaded.
- Seeds (the anchor wallet's too), the vault key, the service tokens, the verdict key and the secret are
  never printed or logged.
- Phase 2 services bind to 127.0.0.1 only.
- Results are read from validated ledgers only.

## Code map

| File | Role |
|---|---|
| `src/config.ts` | Testnet URLs (with a fallback) and the `network_id` guard |
| `src/wallets.ts` | Faucet funding, load and save seeds in `.env` |
| `src/condition.ts` | `makeSecret`, `toCondition`, `toFulfillment` (PREIMAGE-SHA-256, uppercase hex) |
| `src/escrow.ts` | `createEscrow`, `finishEscrow`, `cancelEscrow`, `getEscrow` |
| `src/oracle.ts` | `JobOracle`: holds one job's secret; `verify(deliverable, expectedHash)` returns the fulfillment or `null` |
| `src/registry.ts` | In-memory job store; keeps the condition, never the secret |
| `src/demo.ts` | Runs the scenarios and prints the report |
| `test/condition.test.ts` | Known test vectors, cross-checked against `five-bells-condition` |
| `test/flow.test.ts` | All Phase 1 scenarios against the live testnet |
| `src/local-config.ts` | Phase 2 ports, file paths, `.env` reading, creation of local secrets |
| `src/schema-policy.ts` | Which JSON Schemas a job spec may contain |
| `src/http.ts`, `src/auth.ts` | JSON over `node:http` on 127.0.0.1; signed requests, replay guard, service tokens, signed verdicts |
| `src/registry/` | `db.ts` (SQLite job store, transitions, reputation) and `server.ts` (HTTP API on 8801) |
| `src/oracle/` | `server.ts` (HTTP on 8802), `vault.ts` (AES-256-GCM secrets), `verdict-store.ts` (the chained log file and its testnet anchors), `checks/` (`sha256-match`, `json-schema`, `max-latency`, `xrpl-tx-validated`) |
| `src/verdict-log.ts` | Verdict log rules shared by the oracle and the SDK: entries, chain check, anchor memos |
| `src/watcher.ts` | Ledger subscription that drives job status from validated transactions |
| `src/sdk/index.ts` | `createJob`, `fundJob`, `deliver`, `claim`, `refund`, `verifyVerdict`, `verifyVerdictLog`, `latestAnchor` |
| `src/services.ts`, `src/setup.ts` | Start services as child processes; one-time wallet and key setup |
| `src/demo-phase2.ts` | The four Phase 2 scenarios |
| `src/demo-phase4.ts` | The Phase 4 scenarios: transaction check and verdict log |
| `test/registry.test.ts`, `oracle.test.ts`, `watcher.test.ts`, `sdk.test.ts` | Phase 2 unit tests, no network needed |
| `test/phase2-flow.test.ts` | All Phase 2 scenarios through the services on the live testnet |
| `test/phase3-flow.test.ts` | `expired_unclaimed` then refund, and watcher reconnect, on the live testnet |
| `test/verdict-log.test.ts`, `xrpl-tx.test.ts` | Phase 4 unit tests: tampered logs, anchors, the transaction check, no network needed |
| `test/phase4-flow.test.ts` | All Phase 4 scenarios through the services on the live testnet |
| `test/vectors/` | `make-sdk-vectors.ts` and `make-verdict-log-vectors.ts`, and the `sdk-parity.json` and `verdict-log.json` they write, which the Python SDK must match |
| `test/py-harness.ts` | Throwaway registry and oracle for the Python SDK's tests |

## Not in these phases

RLUSD, the AI judge, multiple oracles, disputes and multisig, the x402 bridge, payments,
mainnet, a UI, and any hosted or non-localhost deployment. The governing
records are `CLAUDE.md` (Phase 1), `CLAUDE_PHASE2.md`,
`../edr/EDR-012_ESCROW_PHASE2_ORACLE_REGISTRY.md`,
`../edr/EDR-013_ESCROW_PHASE3_DEVELOPER_PREVIEW.md` and
`../edr/EDR-014_ESCROW_PHASE4_AUDITABLE_VERIFIER.md`. What the kit does not
protect against is in [`../docs/THREAT_MODEL.md`](../docs/THREAT_MODEL.md).

## Review

Gpno is the single final reviewer for each phase (Phase 1 and 2 together, then
Phase 3, then Phase 4). The handoff is
[`REVIEW_HANDOFF.md`](REVIEW_HANDOFF.md), the review brief is
[`docs/reviews/REVIEW.md`](docs/reviews/REVIEW.md), and the verdict goes in
[`docs/reviews/VERDICT.md`](docs/reviews/VERDICT.md).
