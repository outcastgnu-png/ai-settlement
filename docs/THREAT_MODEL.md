# Threat model (Phase 3 developer preview, with the Phase 4 auditable verifier)

What the kit protects, and what it does not, as of version 0.4.0 (Phase 4, EDR-014). Everything
runs on the XRP Ledger testnet, and the registry and oracle listen on
127.0.0.1 only.

## Who is involved

| Party | Wants | Holds |
|---|---|---|
| Client | to pay only for work that passes the job's checks | its wallet key; the escrowed XRP stays in its own ledger escrow |
| Provider | to get paid for work that passes | its wallet key |
| Oracle | to release the secret only on a pass | every job's secret (encrypted), its verdict key, its anchor wallet |
| Anyone auditing | to see every verdict the oracle issued, in order and unchanged | a copy of the public verdict log; the ledger holds the anchors |
| Registry and watcher | to keep job status in step with the ledger | job specs, deliverables, statuses; never a secret |

## What is protected

- **Funds never leave the ledger's control.** The XRP sits in a native escrow
  that only the job's condition can open, and only before `CancelAfter`. Nobody,
  including the oracle, can redirect it: `EscrowFinish` always pays the escrow's
  destination, whoever submits it. After the deadline anyone can cancel, and the
  XRP returns to the client.
- **Only a pass releases the secret,** and only to a request signed by the job's
  provider. The oracle first checks on a validated ledger that the escrow exists
  with the agreed provider, amount, condition and deadline.
- **Signed requests work once,** even across oracle restarts, and the replay key
  doesn't depend on how the signature is written (Gpno N2).
- **Verdicts are signed** with a dedicated ed25519 key; both SDKs check them
  against the pinned `ORACLE_VERDICT_ADDRESS`.
- **Verdicts can't be hidden, reordered or changed after the fact** (Phase 4). Every
  signed verdict goes into a hash-chained public log; each entry is signed by the
  verdict key and names the hash of the one before. The oracle puts the head of
  the log on the testnet in a memo from its anchor account, on a timer and on
  shutdown. `verifyVerdictLog()` / `verify_verdict_log()` check the signatures and
  the chain, and read the newest anchor from a validated ledger themselves (never
  from the oracle), so a copy of the log that dropped, edited or reordered an
  anchored entry fails. A party holding its own signed verdict can check it is in
  the log. Entries hold hashes and outcomes only: no deliverables, no check details
  (a schema error can quote the deliverable), no secrets or fulfillments.
- **A transaction check trusts validated ledgers only** (Phase 4). `xrpl-tx-validated`
  reads the transaction from the oracle's own testnet connection and passes only on
  `tesSUCCESS` in a validated ledger. It counts what a payment actually delivered
  (`delivered_amount`), so a partial payment can't overstate the amount, and refuses
  a transaction validated before the job was created. The deliverable must be exactly
  a 64-character hash; nothing else in it is read.
- **Only the watcher and the oracle can change job status,** each with its own
  bearer token. `funded`, `paid` and `refunded` come only from validated ledger
  transactions.
- **Secrets are encrypted at rest** (AES-256-GCM) and never logged; the registry
  never stores one.
- **Deliverables and specs are data.** The oracle only hashes, parses and
  validates them.
- **Job schemas are limited before anything runs.** The registry and the oracle
  refuse `pattern`, `patternProperties`, `uniqueItems`, `format` and `$data`
  wherever Ajv would read them as schema, including anything reached through a
  `$ref`. A `$ref` must be local and must point at a subschema, never into
  `enum`, `const`, `default` or other data. Before 0.3.0 a `$ref` into `enum`
  could carry a regex past this check (Gpno N8); that is fixed and tested.
  Schemas are also capped in size, depth, `$ref` count and expanded size
  (Gpno N1), and a job has at most 8 checks.
- **A slow schema can't hang the oracle.** Validation runs in a worker thread and
  is stopped after 2 seconds of the job's own time, which gives a fail verdict.
  Time spent starting the worker or waiting in line doesn't count against a job.
- **Testnet only.** Every connection checks `network_id === 1` or aborts.

## What is not protected (known limits of this preview)

| Limit | What it means | Planned answer |
|---|---|---|
| Plain HTTP on 127.0.0.1 | Any process on the same machine can watch the traffic, including a fulfillment the oracle returns. A leaked fulfillment lets someone finish early, but the XRP still goes to the provider. | TLS and authentication come with a hosted verifier (a later EDR). |
| One oracle, one key | You trust the oracle operator. A wrong or malicious oracle can fail good work (the client is then refunded) or pass bad work (the provider is paid). Whoever holds `ORACLE_VAULT_KEY` and the vault file can read every secret. Since Phase 4 the verdict log and its anchors make that oracle *accountable*, not *correct*: it can still sign a wrong verdict, it just can't hide it, take it back, or show it differently later without the log or the ledger anchor giving it away. A job's first signed verdict is final: the oracle reloads it from the log on start and answers every later verify with it, and never releases a fulfillment after a fail (Gpno N25). A log entry whose public outcome, checks, evidence hash, condition, provider or time differs from the signed verdict it names is not that verdict's entry, and the SDK check fails it (Gpno N26). | Key management; multiple oracles (k-of-n) and a dispute module are later EDRs. |
| What the verdict log does not prove | The log only covers what the oracle signed. (1) Entries after the newest anchor are checked for signature and chain but not yet pinned on the ledger; the operator could still rewrite that tail before the next anchor (every 10 minutes by default, and on shutdown). When a caller passes its own verdict and that verdict is in the tail, `ok` is false and `verdictAnchored` is false unless the caller sets `allowUnanchored` (Gpno N30). (2) An operator who serves *different* tails to different readers between anchors is caught only when the readers compare copies or the next anchor lands. (3) An oracle that never logs a verdict it signed is caught only when someone holding that verdict checks for it (`verdict` option). (4) An operator can start a whole new chain under the same key or the same anchor account; the anchors on the ledger then disagree with it. The SDK check reads every anchor the account posted (up to 400 account transactions back, failing closed past that) and fails when any anchor disagrees with the log or two different geneses are anchored, and the oracle refuses to start on a log the account's anchors disagree with (Gpno N29). One anchor account anchors one log: a second demo with a fresh data folder but the same `ORACLE_ANCHOR_SEED` publishes a second chain, so it needs a fresh anchor wallet (`npm run setup` after removing the `ORACLE_ANCHOR_*` lines). (5) The log names job ids, providers, conditions and outcomes publicly to anyone on the machine. | Compare log copies across readers; multiple oracles. |
| Ledger reads for `xrpl-tx-validated` | The oracle trusts the testnet server it is connected to for the transaction. A server that lies could pass or fail the check. The deliverable can only point at a transaction, so the provider chooses which one. A transaction not found or still unvalidated when verified fails for good, since a job's first verdict is final (Gpno N25); a failed lookup (timeout, disconnect) signs nothing and answers 503. | Read from more than one server; providers should deliver the hash only once their transaction is validated. |
| Keys in `.env` | Wallet seeds (the anchor wallet's too), the vault key, the service tokens and the verdict seed sit in one plaintext file. | Fine for testnet; a hosted setup needs a secrets store. |
| Open local reads and job creation | Anyone on the machine can list jobs, read deliverables and create draft jobs. There are no rate limits. | Accounts and rate limits come with hosting. |
| Deliverables in plaintext | The registry's SQLite file holds every deliverable as sent. | Store hashes only, or encrypt, if a use case needs it. |
| Only deterministic checks | `sha256-match` needs the client to know the exact output in advance; `json-schema` checks structure, not quality; `max-latency` checks timing; `xrpl-tx-validated` checks that a transaction happened, not why. Nothing judges whether work is *good*. | An optional LLM-judge check is a later EDR, with an appeal path. |
| No disputes | A verdict is final. A provider who thinks a fail was wrong has no appeal inside the kit. | Dispute module (writeup phase 4). |
| Reputation is a stub | Counts per provider address. One party can play both client and provider, or use many addresses. | Don't rely on it for decisions. |
| Watcher downtime | While the watcher is down, job status lags the ledger. The ledger stays the source of truth, and the oracle checks the escrow on the ledger before it releases anything. | The watcher backfills from `account_tx` when it subscribes. |
| Oracle availability (denial of service) | One schema worker serves every job, one check at a time, each for up to 2 seconds. Someone who funds escrows for their own jobs, or asks to verify the same job over and over, can keep it busy. Honest jobs are not failed: past 8 waiting checks the oracle answers 503 with no verdict, and a verified job's results are remembered and never re-run. But one job can hold the worker for up to 16 seconds (8 checks of 2 seconds), plus a restart after each timeout, and the SDKs give up after about 6 seconds (4 attempts). So someone with 8 or more funded jobs can make an honest `deliver()` end in a 503 error. The work stays delivered and no fail verdict is signed; the provider's code has to call `requestVerification` / `request_verification` again before the deadline. If the deadline passes while the oracle is busy, the client is refunded (Gpno N9, N21). | Per-provider rate limits, more workers, and a queue that survives restarts come with hosting. |
| Clock skew | Signed requests are accepted within 2 minutes of the signer's clock. `xrpl-tx-validated` compares the ledger's close time with the job's creation time on the registry's clock, with 10 seconds of slack; a registry clock that runs behind widens that window. | Keep the machine's clock synced (NTP). |

## Out of scope for this preview

Mainnet, real value, RLUSD, x402 and AP2, a hosted service, user accounts, and
any legal or compliance review. A service that decides when money is released
may raise money-transmission questions; get a crypto-specialized attorney's
review before handling third-party value or charging per transaction.
