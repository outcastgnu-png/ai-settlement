# Quickstart: your first verified-delivery escrow (testnet)

This takes about 15 minutes on a clean Windows machine, most of it installing
Node and Python. Everything runs on the XRP Ledger **testnet** with free test
XRP, and the services listen only on your own machine (127.0.0.1). No real
money is involved at any point.

## 1. Install the tools

- [Node.js 22.12 or newer](https://nodejs.org/) (the LTS installer is fine)
- [Python 3.11 or newer](https://www.python.org/downloads/), only for the Python SDK.
  On Windows, tick "Add python.exe to PATH" in the installer.
## 2. Get the code and set up the kit

Until the public repository is up, the kit comes as a zip file,
`ai-settlement-0.3.0.zip`. Unzip it so that you have a folder called
`ai-settlement` (for example `C:\dev\ai-settlement`). Then, in PowerShell:

```
cd C:\dev\ai-settlement\xrpl-escrow
npm ci
npm run setup
```

The commands are written for Windows PowerShell. On macOS or Linux they are the
same with `/` instead of `\` in paths, and `source .venv/bin/activate` in step 4b.
`npm ci` installs exactly the versions in `package-lock.json`.

`npm run setup` asks the testnet faucet for XRP for three wallets (client,
provider, oracle) and writes their seeds and the oracle's keys to `.env`. That
file is gitignored and only ever holds testnet keys.

## 3. Start the three services

Open three more PowerShell windows in `ai-settlement\xrpl-escrow` and start one
in each:

```
npm run registry
npm run oracle
npm run watcher
```

The registry stores jobs, the oracle holds each job's secret and checks the
work, and the watcher follows the ledger and updates each job's status.

## 4a. Run a job from TypeScript

In a fifth window, in `ai-settlement\xrpl-escrow`:

```
npx tsx examples/first-job.ts
```

## 4b. Or run a job from Python

```
cd ai-settlement\xrpl-escrow-py
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -e .[test]
python -m xrpl_escrow.demo
```

(If PowerShell refuses to run `Activate.ps1`, run
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.)

Both print every ledger transaction as a `https://testnet.xrpl.org/transactions/<hash>`
link, so you can open the escrow in the explorer and watch it get created and
finished.

## What just happened

1. The client registered a job: a price and the SHA-256 hash of the work it will accept.
2. The oracle made a 32-byte secret and gave out only its fingerprint (the *condition*).
3. The client locked the XRP in a native ledger escrow that only that secret can open,
   and only before a deadline. The funds never left the client's control.
4. The provider delivered the work. The oracle hashed it, signed a verdict, and on a
   match gave the provider the secret (the *fulfillment*).
5. The provider finished the escrow and was paid. On a mismatch, the client cancels
   after the deadline and gets the XRP back.

## Stuck?

| Problem | Fix |
|---|---|
| `EBADENGINE` on `npm ci` | Your Node is older than 22.12. Install the current LTS. |
| `could not reach any testnet server` | Check your network; behind a proxy set `HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1`. |
| `ORACLE_VERDICT_SEED is missing from .env` | Run `npm run setup` in `xrpl-escrow`. |
| `no oracle at http://127.0.0.1:8802` | Start the services (step 3), or run the Python demo with `--start-services`. |
| The faucet is slow or refuses | Wait a minute and rerun `npm run setup`; it only funds wallets below 30 XRP. |

More detail: [`xrpl-escrow/README.md`](xrpl-escrow/README.md) and
[`xrpl-escrow-py/README.md`](xrpl-escrow-py/README.md). What the kit does not
protect against: [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).
