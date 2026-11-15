# b5f36bf Windows evidence (rename-retry fix, PR #8), run 2026-11-12 CT
Commit b5f36bf124e84fbcaa5f0c578278a57ecac917e0 (tree e1f8b8f9), clean tree, separate worktree C:\dev\ai-settlement-f5ee6d2.
Windows 11 Pro 10.0.26300, Node 24.18.0, npm 11.16.0, Python 3.14.6. Testnet only.
Reused from the 2026-11-08 f5ee6d2 run in the same worktree: .env (anchor raU1zQN3PxSGmYh9e14cBVSz3R7PKK9xvG), xrpl-escrow/data/, xrpl-escrow-py/.venv.
| Step | Result |
|---|---|
| npm ci | pass, 0 vulnerabilities |
| typecheck | 0 errors |
| test:unit | 107/107 (9 files) |
| finality.test.ts x5 | 7/7 each run |
| npm test (testnet) | 112/112 (13 files), 558 s |
| npm run demo:phase4 | 28/28 |
| pytest | 36 passed, 1 skipped |
| pytest --testnet | 37/37 |
| Python demo --start-services | 16/16 |
"[fs] replaced ... after N retries" lines across all logs: 0. "[fs] gave up" lines: 0. EPERM/EACCES/EBUSY in any log: 0.
So no rename was refused on this run: the retry path was not exercised here, and nothing failed.
No retries of whole suites. No seed or secret in any log (scanned). The demo wrote logs/2026-11-12-phase4.txt and -txs.json
(untracked); moved here, then git status --porcelain: clean. Nothing committed.
