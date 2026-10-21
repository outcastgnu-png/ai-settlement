# Contributing

Thanks for trying the kit. It is a testnet-only developer preview, so the most
useful contributions right now are bug reports, unclear docs, and notes on what
you needed that the kit doesn't do.

## Ground rules

- **Testnet only.** Never add a mainnet URL, a mainnet seed, or a way to turn the
  `network_id === 1` check off. Pull requests that do will be closed.
- **Never log a seed, a secret, a fulfillment, or a service token.**
- **Services bind to 127.0.0.1.** Exposing a service beyond the local machine needs
  a new design decision first; open an issue to discuss it.
- **Deliverables and job specs are data.** The oracle and the SDKs hash, parse and
  validate them, and must never run or follow anything inside them.
- **Trust validated ledgers only.**

## Running the tests

TypeScript (`xrpl-escrow/`, Node 22.12+):

```
npm install
npm run typecheck
npm run test:unit   # no network
npm test            # also the testnet flows, about 8 minutes; run `npm run setup` first
```

Python (`xrpl-escrow-py/`, Python 3.11+; needs `npm install` in `xrpl-escrow` for the
cross-language tests):

```
pip install -e .[test]
python -m pytest
python -m pytest --testnet
```

If you change how requests or verdicts are signed, regenerate the shared vectors
with `npx tsx test/vectors/make-sdk-vectors.ts` and make both test suites pass.

## Changes

- Keep a change small and focused, with a test that fails without it.
- Match the style of the code around it.
- Scripts must work on Windows: npm scripts or Python, no bash-only scripts.
- Add a line to `CHANGELOG.md`.

Security problems: please don't open a public issue. See [`SECURITY.md`](SECURITY.md).
