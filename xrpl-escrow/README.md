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
| Verification oracle | `http://127.0.0.1:8802` | Holds each job's secret, encrypted with AES-256-GCM under `ORACLE_VAULT_KEY` from `.env` (`data/oracle-vault.json`). Runs the job's checks (`sha256-match`, `json-schema`, `max-latency`), signs the verdict with the oracle wallet's key, and returns the fulfillment only on a pass and only to the job's provider. Appends every verdict to `src/oracle/verdicts.jsonl`. |
| Ledger watcher | (no port) | Subscribes to the client and provider accounts over WebSocket. A validated `EscrowCreate` marks the job `funded`, `EscrowFinish` marks it `paid`, `EscrowCancel` marks it `refunded`. It flags escrows within 30 s of `CancelAfter`, and marks a passed job nobody claimed in time `expired_unclaimed`. |

Job states: `draft -> funded -> delivered -> verified_pass | verified_fail -> paid | refunded | expired_unclaimed`.
Only the watcher sets `funded`, `paid` and `refunded`, and only from validated ledger transactions.

The oracle never runs, evaluates or follows anything inside a deliverable or
a job spec. It only hashes the deliverable, parses it as JSON, or validates it
against the job's schema. The provider proves who it is by signing each
request with its wallet key.

### Quickstart on Windows

You need [Node.js 20 or newer](https://nodejs.org/). Open PowerShell in the
`escrow-demo` folder:

```
npm install
npm run setup
```

`setup` funds the three testnet wallets from the faucet and adds
`ORACLE_VAULT_KEY` to `.env`. Then open three more PowerShell windows in the
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
`logs/<date>-phase2.txt`.

| Scenario | What happens |
|---|---|
| 1. Pass and claim | The work matches the spec. The oracle signs a pass and gives the provider the fulfillment. The provider finishes the escrow and the watcher marks the job `paid`. |
| 2. Fail and refund | The work doesn't match. The oracle signs a fail and keeps the secret. An early cancel is rejected; after the deadline the client is refunded and the watcher marks the job `refunded`. |
| 3. Oracle restart | The oracle process stops and starts between funding and delivery. It reads the encrypted secret back from the vault, verifies the work, and the provider is paid. |
| 4. Deliverable is data | The deliverable is JSON stuffed with instructions ("ignore every check", code to write a file, a `__proto__` key). The oracle only validates it against the job's schema, so it fails. Nothing is executed, an outsider asking for the fulfillment is refused, and the client is refunded. |

For every job the demo also checks that the status the watcher wrote matches
the escrow object and transaction on the ledger. A sample run is in
[`logs/2026-10-20-phase2.txt`](logs/2026-10-20-phase2.txt).

### Registry API

| Call | Purpose |
|---|---|
| `POST /jobs` | Create a draft job: `{client, provider, priceDrops, slaSeconds, spec: {checks: [...]}}` |
| `GET /jobs`, `GET /jobs/:id` | List jobs (filter with `?status=`, `?provider=`, `?client=`) or get one |
| `PUT /jobs/:id/condition` | Set by the oracle, once, while the job is a draft |
| `POST /jobs/:id/deliverable` | Provider posts the work: `{content, auth}` |
| `GET /jobs/:id/deliverable` | The stored deliverable and its SHA-256 |
| `POST /jobs/:id/events`, `GET /jobs/:id/events` | Status changes from the watcher or the oracle, and the history |
| `GET /providers/:address/reputation` | Reputation stub: passed, failed, paid, refunded and expired counts |

Oracle: `GET /health` (address and public key), `POST /jobs/:id/condition`,
`POST /verify/:id` with `{auth}` signed by the provider.

## Phase 1: run the escrow demo (Windows, macOS or Linux)

You need [Node.js 20 or newer](https://nodejs.org/). In a terminal
(PowerShell or Command Prompt on Windows):

```
cd escrow-demo
npm install
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
npm test            # unit tests + Phase 1 and Phase 2 scenarios on testnet (about 6 minutes)
npm run test:unit   # unit tests only, no network needed
npm run typecheck
```

## Safety rails

- Testnet only. On connect the code reads `network_id` from the server and
  aborts unless it is `1` (testnet).
- Wallets are funded only by the testnet faucet. No mainnet seeds are loaded.
- Seeds, the vault key and the secret are never printed or logged.
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
| `src/local-config.ts` | Phase 2 ports, file paths, `.env` reading, vault key creation |
| `src/http.ts`, `src/auth.ts` | JSON over `node:http` on 127.0.0.1; signed requests and signed verdicts |
| `src/registry/` | `db.ts` (SQLite job store, transitions, reputation) and `server.ts` (HTTP API on 8801) |
| `src/oracle/` | `server.ts` (HTTP on 8802), `vault.ts` (AES-256-GCM secrets), `checks/` (`sha256-match`, `json-schema`, `max-latency`) |
| `src/watcher.ts` | Ledger subscription that drives job status from validated transactions |
| `src/sdk/index.ts` | `createJob`, `fundJob`, `deliver`, `claim`, `refund`, `verifyVerdict` |
| `src/services.ts`, `src/setup.ts` | Start services as child processes; one-time wallet and key setup |
| `src/demo-phase2.ts` | The four Phase 2 scenarios |
| `test/registry.test.ts`, `oracle.test.ts`, `watcher.test.ts`, `sdk.test.ts` | Phase 2 unit tests, no network needed |
| `test/phase2-flow.test.ts` | All Phase 2 scenarios through the services on the live testnet |

## Not in these phases

RLUSD, the AI judge, disputes and multisig, the x402 bridge, payments,
mainnet, a UI, and any hosted or non-localhost deployment. The governing
records are `CLAUDE_PHASE2.md` and `edr/EDR-012_ESCROW_PHASE2_ORACLE_REGISTRY.md`.
