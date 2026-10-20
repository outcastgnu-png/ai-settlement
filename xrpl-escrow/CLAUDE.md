# Project: XRPL Verified-Delivery Escrow Demo (TypeScript, TESTNET ONLY)

## Goal
Prove the core mechanism: a client locks XRP in a native XRPL escrow behind a
PREIMAGE-SHA-256 crypto-condition. A verification oracle checks the delivered
work and releases the secret. The provider then finishes the escrow, or the
client gets refunded after the deadline.

## Hard rules
- **Testnet only.** Connect to `wss://s.altnet.rippletest.net:51233` (fallback
  `wss://testnet.xrpl-labs.com`). On connect, assert `network_id === 1`, or abort.
- Fund wallets only from the testnet faucet. Never load mainnet seeds.
- Keep seeds in `.env` (gitignored). Never log seeds or the secret.
- Trust results from validated ledgers only (`submitAndWait`, `validated: true`).

## Stack
- Node 20+, TypeScript strict, `xrpl` (xrpl.js), `five-bells-condition` (or a
  hand-rolled crypto-condition encoder), `dotenv`, `vitest`, `tsx`.
- Must work on Windows: npm scripts only, no bash-only scripts.

## Layout
```
src/config.ts     network URLs + network_id guard
src/wallets.ts    faucet funding, load/save .env
src/condition.ts  makeSecret(), toCondition(), toFulfillment() (uppercase hex)
src/escrow.ts     createEscrow(), finishEscrow(), cancelEscrow(), getEscrow()
src/oracle.ts     verify(deliverable, expectedHash) -> fulfillment | null
src/registry.ts   in-memory job store (stores the condition, never the secret)
src/demo.ts       runs the scenarios and prints a report
test/condition.test.ts  known test vectors
test/flow.test.ts       scenarios against testnet
```

## Flow
1. Fund the client, provider, and oracle wallets.
2. Define a job: price (e.g. 10 XRP), the expected SHA-256 hash of the deliverable, and the SLA.
3. Generate a 32-byte secret. Only the oracle holds it.
4. Client `EscrowCreate`: Destination = provider, Amount in drops, Condition,
   CancelAfter = now + ~120 s (ripple epoch = unix − 946684800). Save OfferSequence.
5. The provider delivers. The oracle hashes the deliverable and compares it.
6. On a pass, the oracle returns the fulfillment and the provider submits `EscrowFinish`
   (Owner, OfferSequence, Condition, Fulfillment). Let autofill set the higher
   fee that a conditional finish requires.
7. On a fail, wait until after CancelAfter, then `EscrowCancel` refunds the client.

## Scenarios that must pass
1. **Happy path:** finish succeeds and the provider gains the price.
2. **Bad delivery:** the oracle refuses, the escrow is cancelled after the deadline, and the client is refunded minus fees.
3. **Wrong secret:** finish fails with `tecCRYPTOCONDITION_ERROR` and the escrow stays open.

Also, finishing after CancelAfter must fail, and cancelling before it must fail.

## Gotchas
- `submitAndWait` throws on `tec*` results. Catch the error and read the validated tx by hash.
- XRP amounts are drop strings (1 XRP = 1,000,000 drops).
- An open escrow holds the client's owner reserve until it is finished or cancelled.
- Ledger close time lags real time. Wait for a validated ledger whose close_time is past
  CancelAfter before cancelling.

## Done when
- `npm run demo` prints every scenario with
  https://testnet.xrpl.org/transactions/<hash> links and balances before and after.
- `npm test` passes.
- The README explains the flow in plain words and how to run it on Windows.

## Out of scope
RLUSD, AI judge, disputes/multisig, x402 bridge, mainnet, hosted API
