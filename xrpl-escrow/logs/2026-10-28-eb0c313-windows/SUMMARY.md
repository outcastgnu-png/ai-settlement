# eb0c313 Windows evidence (run by Gpno, 2026-10-28 CT)
Commit eb0c313f9d0daa32713d9edfb95f8cf2db17baaa, clean tree, separate worktree C:\dev\ai-settlement-eb0c313.
Windows 11 Pro 10.0.26300, Node 24.18.0, npm 11.16.0, Python 3.14.6. Testnet only.
| Step | Result |
|---|---|
| npm ci | pass, 0 vulnerabilities |
| typecheck | 0 errors |
| test:unit | 62/62 |
| oracle.test.ts x3 | 28/28 each run, no flakes |
| npm run setup | testnet faucet, 3 wallets funded |
| npm test (testnet) | 66/66, 8 files, 433 s |
| pytest | 25 passed, 1 skipped |
| pytest --testnet | 26 passed |
No retries. No seed or secret in any log. Tree after run (git status --porcelain): clean
Environment: .venv and node_modules and .env created inside the worktree only (gitignored).
