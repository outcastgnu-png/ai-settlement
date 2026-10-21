# xrpl-escrow (Python SDK)

A Python client for the verified-delivery escrow kit on the XRP Ledger
**testnet**. It has the same five calls as the TypeScript SDK and talks to the
same local services, which stay in TypeScript (`../xrpl-escrow`):

| Call | What it does |
|---|---|
| `create_job()` | Registers a draft job and has the oracle create its secret and condition |
| `fund_job()` | The client locks the price in an `EscrowCreate`; returns once the watcher marks the job `funded` |
| `deliver()` | The provider posts the work and asks the oracle for a signed verdict (and, on a pass, the fulfillment) |
| `claim()` | The provider submits `EscrowFinish` with the fulfillment; returns once the job is `paid` |
| `refund()` | After the deadline, submits `EscrowCancel`; returns once the job is `refunded` |

The SDK signs every request and transaction locally with the wallet that sends
it. It checks each verdict's signature against the pinned
`ORACLE_VERDICT_ADDRESS` from `.env`, never against what the oracle says about
itself. Deliverables and job specs are data: the SDK sends and hashes them and
never runs them.

## Run it on Windows

You need [Python 3.11 or newer](https://www.python.org/downloads/) and
[Node.js 22.12 or newer](https://nodejs.org/). In PowerShell:

```
cd xrpl-escrow
npm install
npm run setup
cd ..\xrpl-escrow-py
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -e .[test]
python -m xrpl_escrow.demo --start-services
```

On macOS or Linux, activate with `source .venv/bin/activate` instead.

`npm run setup` funds three testnet wallets from the faucet and writes their
seeds and the oracle's keys to `xrpl-escrow/.env` (gitignored, testnet only).
The Python demo reads that same file. `--start-services` starts the registry,
oracle and watcher for the run and stops them afterwards; leave it off if you
already started them with `npm run registry`, `npm run oracle` and
`npm run watcher`.

The demo runs two jobs and prints every transaction with a
`https://testnet.xrpl.org/transactions/<hash>` link and the balances before and
after. It takes about two minutes, mostly waiting for the refund deadline.

| Scenario | What happens |
|---|---|
| 1. Pass and claim | The work matches. The oracle signs a pass and releases the fulfillment, the provider finishes the escrow and is paid. |
| 2. Fail and refund | The work doesn't match. The oracle signs a fail and keeps the secret, the client can't get the fulfillment either, and after the deadline the client is refunded. |

A sample run is in [`logs/2026-10-21-python-demo.txt`](logs/2026-10-21-python-demo.txt).

## Use it from your own code

```python
from xrpl_escrow import EscrowKit, connect_testnet, load_or_fund_wallets, sha256_hex

xrpl = connect_testnet()                       # aborts unless network_id is 1 (testnet)
w = load_or_fund_wallets(xrpl, "../xrpl-escrow/.env")
kit = EscrowKit(xrpl=xrpl, env_file="../xrpl-escrow/.env")
work = "the deliverable"
job = kit.create_job(w["client"].address, w["provider"].address, "10000000", 300,
                     {"checks": [{"type": "sha256-match", "sha256": sha256_hex(work)}]})
kit.fund_job(job["id"], w["client"])                       # EscrowCreate
res = kit.deliver(job["id"], w["provider"], work)
if res.fulfillment and res.verdict_signature_valid:
    kit.claim(job["id"], w["provider"], res.fulfillment)   # EscrowFinish
else:
    kit.refund(job["id"], w["client"])                     # EscrowCancel after the deadline
xrpl.close()
```

Jobs come back as plain dicts with the registry's field names (`status`,
`condition`, `offerSequence`, `cancelAfter` and so on).

## Tests

```
python -m pytest              # no testnet needed (about 3 seconds)
python -m pytest --testnet    # also runs both demo scenarios on testnet (about 2 minutes)
```

- `tests/test_condition.py`: condition and fulfillment encoding, against the
  TypeScript kit's vectors.
- `tests/test_parity.py`: signed requests, replay keys, canonical JSON and verdict
  signatures, byte for byte the same as the TypeScript kit for ed25519 and
  secp256k1 keys. The vectors are in `../xrpl-escrow/test/vectors/sdk-parity.json`,
  made by `npx tsx test/vectors/make-sdk-vectors.ts`.
- `tests/test_kit_local.py`: the SDK against the real TypeScript registry and
  oracle with a stub ledger (`../xrpl-escrow/test/py-harness.ts`), including a
  Python-signed request that works once and whose lowercase copy is refused.
- `tests/test_demo_testnet.py`: both scenarios on testnet, with the services on
  spare ports and throwaway data.

Behind a proxy, set `HTTPS_PROXY`. The SDK never sends its calls to the local
services through a proxy.

## Code map

| File | Role |
|---|---|
| `src/xrpl_escrow/config.py` | Testnet URLs (with a fallback) and the `network_id` guard |
| `src/xrpl_escrow/condition.py` | `make_secret`, `to_condition`, `to_fulfillment` |
| `src/xrpl_escrow/auth.py` | Signed requests, replay key, canonical JSON, `verify_verdict` |
| `src/xrpl_escrow/escrow.py` | `create_escrow`, `finish_escrow`, `cancel_escrow`, `get_escrow`; results from validated ledgers only |
| `src/xrpl_escrow/env.py` | `.env` reading, faucet funding |
| `src/xrpl_escrow/kit.py` | `EscrowKit` |
| `src/xrpl_escrow/services.py` | Starts the TypeScript services as child processes |
| `src/xrpl_escrow/demo.py` | The two demo scenarios |
