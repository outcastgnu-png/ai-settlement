# c8e72fc Windows evidence (N37 fix, PR #11), run 2026-11-18 CT

Commit c8e72fc253e18641059a3c334d6ad538483b56c7 (tree 373baa5e879722159be2ebce30512ce2c58df7b4, parent abd8b52), the tree Gpno passed on 2026-11-18. Clean worktree C:\dev\ai-settlement-c8e72fc.
Windows 11 10.0.26300, Node 24.18.0, npm 11.16.0, Python 3.14.6. Testnet only.
Copied from the 21da0b3 run: .env (anchor raU1zQN3PxSGmYh9e14cBVSz3R7PKK9xvG) and xrpl-escrow/data/. Fresh .venv.

| Step | Result |
|---|---|
| npm ci | pass; npm audit reports 5 high-severity issues (picomatch ReDoS advisory GHSA-fc5q-39xc-vjpf, through vitest/vite, test tooling only; lockfile unchanged since 0.4.0) |
| typecheck | 0 errors |
| test:unit | 114/114 (9 files) |
| finality.test.ts x5 | 12/12 each run |
| npm test (testnet) | 119/119 (13 files), 545 s |
| npm run demo:phase4 | 28/28 |
| pytest | 39 passed, 1 skipped |
| pytest --testnet | 40/40 |
| Python demo --start-services | 16/16 |

EPERM/EACCES/EBUSY and "[fs]" lines in any log: 0. Seed scan: no seed-like strings and no SEED=/VAULT_KEY= assignments.
A second run of the same commit, started by a duplicate request, was also green with the same counts; this folder holds the first run.
