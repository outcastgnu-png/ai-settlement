# 21da0b3 Windows evidence (Phase 4 r4 fix, draft PR #9), run 2026-11-15 CT
Commit 21da0b34745f30ae703216765b7879ed2924cd7e (tree b7030cd12e6208b47c5d0c3ce457e45c21df6488), clean tree, separate worktree C:\dev\ai-settlement-f5ee6d2.
Windows 11 Pro 10.0.26300, Node 24.18.0, npm 11.16.0, Python 3.14.6. Testnet only.
Reused from the b5f36bf run in the same worktree: .env (anchor raU1zQN3PxSGmYh9e14cBVSz3R7PKK9xvG), xrpl-escrow/data/, xrpl-escrow-py/.venv.
| Step | Result |
|---|---|
| npm ci | pass, 0 vulnerabilities |
| typecheck | 0 errors |
| test:unit | 112/112 (9 files) |
| finality.test.ts x5 | 11/11 each run |
| npm test (testnet) | 117/117 (13 files), 535 s |
| npm run demo:phase4 | 28/28 |
| pytest | 38 passed, 1 skipped |
| pytest --testnet | 39/39 |
| Python demo --start-services | 16/16 |
"[fs]" lines across all logs: 0 (0 "replaced ... after N retries", 0 "gave up"). EPERM/EACCES/EBUSY in any log: 0.
No rename was refused on this run, so the retry path was not exercised; nothing failed.
No retries of whole suites. Seed scan: no seed-like strings and no SEED=/VAULT_KEY=/TOKEN= assignments in any log.
The demo wrote logs/2026-11-15-phase4-2.txt and -txs.json (untracked); moved here, then git status --porcelain: clean. Nothing committed.
