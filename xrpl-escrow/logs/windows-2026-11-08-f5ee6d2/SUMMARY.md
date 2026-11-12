# f5ee6d2 Windows evidence (Phase 4, v0.4.0), run 2026-11-08 CT
Commit f5ee6d2de1a3672b1c89c947ee700a5306370e53 (tree 868c7cf6, identical to merged main 03e0d77), clean tree,
separate worktree C:\dev\ai-settlement-f5ee6d2. Windows 11 Pro 10.0.26300, Node 24.18.0, npm 11.16.0, Python 3.14.6. Testnet only.
| Step | Result |
|---|---|
| npm ci | pass, 0 vulnerabilities |
| typecheck | 0 errors |
| test:unit | 102/103 FAIL: finality.test.ts "keeps a fail after 1024 later verdicts", EPERM on rename vault.json.tmp -> vault.json |
| finality.test.ts reruns x3 | 1 fail (EPERM on replay.json), 2 pass |
| npm run setup | 4 wallets funded from faucet, incl. fresh anchor raU1zQN3PxSGmYh9e14cBVSz3R7PKK9xvG |
| npm test (testnet) | 107/108 FAIL: same finality test, same EPERM; 513 s |
| npm run demo:phase4 | 28/28 |
| pytest | 36 passed, 1 skipped |
| pytest --testnet | 37/37 |
| Python demo --start-services | 16/16 |
The one failure is Windows-only and intermittent (3 of 5 runs of the finality test): renameSync over a file another process briefly holds open.
No retries of whole suites. No seed or secret in any log (scanned). Tree after run: the demo wrote logs/2026-11-09-phase4-2.txt and -txs.json (untracked); moved here, then git status --porcelain: clean
Environment: .env, node_modules, .venv and data created inside the worktree only (gitignored).
