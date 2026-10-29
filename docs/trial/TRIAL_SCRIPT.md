# Trial script

## The message to send

> Hi! I'm building an open-source escrow for AI-agent jobs on the XRP Ledger: the
> client's XRP is locked on the ledger and only released when a verifier checks the
> delivered work. It runs on testnet only, with free test XRP, on your own machine.
> Would you spend about 45 minutes trying it and answering 12 short questions?
> Use the [v0.3.0 kit](https://github.com/outcastgnu-png/ai-settlement/releases/tag/v0.3.0);
> start with its `QUICKSTART.md`. Follow the
> [current trial script](https://github.com/outcastgnu-png/ai-settlement/blob/main/docs/trial/TRIAL_SCRIPT.md)
> and use the [current feedback form](https://github.com/outcastgnu-png/ai-settlement/blob/main/docs/trial/FEEDBACK_FORM.md),
> even if your downloaded release has older return instructions.
> Email your completed form to **[outcastgnu@gmail.com](mailto:outcastgnu@gmail.com)**
> with subject **AI Settlement developer trial feedback**. Paste the answers into
> the email or attach a Markdown/text file; no public post or pull request is needed.
> Include your kit version and a testnet explorer link for the paid job, or say
> where you got stuck. Partial or unsuccessful runs are useful feedback too.
> Never include `.env`, wallet seeds/private keys, secrets, fulfillments/preimages,
> service tokens, or unnecessary personal information. Check logs and screenshots
> before sending. Sanitized results will be recorded publicly under an agreed
> handle or alias, without your contact details.
> Report suspected vulnerabilities separately and privately via
> [`SECURITY.md`](https://github.com/outcastgnu-png/ai-settlement/blob/main/SECURITY.md),
> never in the feedback form, a forum reply, or a public issue.
> Everything stays on testnet with free test XRP; do not use real funds.

## What the tester does

1. **Set up (about 15 minutes).** Follow `QUICKSTART.md` steps 1 to 3: install,
   `npm ci`, `npm run setup`, start the three services.
   *Note the time it took and anything that went wrong.*
2. **Run the example (about 5 minutes).** Step 4a (TypeScript) or 4b (Python).
   Open one of the printed explorer links.
3. **Make it yours (about 20 minutes).** Change the example so that:
   - the job's check is something you would actually use (another hash, or a
     `json-schema` check on a JSON deliverable), and
   - one job fails and is refunded.
   Use the SDK in your language. Only the kit's own calls are needed.
   A job's `spec.checks` takes up to 8 of these:
   ```
   { "type": "sha256-match", "sha256": "<64 hex chars>" }
   { "type": "json-schema",  "schema": { "type": "object", "required": ["answer"] } }
   { "type": "max-latency",  "maxMs": 60000 }
   ```
   For `json-schema`, deliver the JSON as a string. Give the failing job
   `slaSeconds: 30` (the minimum), so its refund comes about a minute later
   instead of after the example's 5 minutes.
4. **Try to break it (optional).** Can you get a fulfillment without passing the
   check, or get paid without one? If you find something, report it as
   [`SECURITY.md`](../../SECURITY.md) describes, not in the form.
5. **Fill in [the current feedback form](https://github.com/outcastgnu-png/ai-settlement/blob/main/docs/trial/FEEDBACK_FORM.md)**
   and email it to **[outcastgnu@gmail.com](mailto:outcastgnu@gmail.com)** with
   subject **AI Settlement developer trial feedback**. Paste the answers into the
   email or attach a Markdown/text file. Include the kit version/tag or commit and
   a testnet explorer link showing the paid job; if blocked, report the failure
   and any missing evidence honestly. No public post or pull request is needed.
   Never send `.env`, wallet seeds/private keys, secrets, fulfillments/preimages,
   or service tokens, even by email. Redact logs/screenshots and unnecessary
   personal or company information. Testnet transaction links are public and can
   expose wallet addresses and activity; include only those needed for the trial.

## What the organizer does

- Before sending: check the quickstart still works from a fresh clone of the release on
  Windows, and send the invitation above with its explicit email destination and
  links to the current trial script and feedback form. The v0.3.0 snapshot has
  older return instructions; these links supplement it without changing the kit
  version testers run.
- Answer questions within a day, and note every question in the tester's results
  file. A question is a sign the docs need fixing.
- Before publishing results: agree a public handle or alias with the tester.
  Copy only sanitized answers and necessary testnet evidence into
  `results/<date>-<handle>.md` (start from
  [`results/TEMPLATE.md`](results/TEMPLATE.md)). Do not commit the original email,
  headers, signatures, contact details, unrelated personal/company information,
  secrets, or vulnerability details. Apply the same checks to logs/screenshots.
- Update the summary table in [`results/README.md`](results/README.md) from
  reported and verified evidence only. A recruitment reply, invitation acceptance,
  or returned form alone does not establish a paid job. Keep blocked/partial runs
  as feedback; do not mark them as satisfying the gate.
- Open public issues only for sanitized, non-security bugs. Handle suspected
  vulnerabilities separately through [`SECURITY.md`](../../SECURITY.md):
  [private security advisory](https://github.com/outcastgnu-png/ai-settlement/security/advisories/new)
  or a separate email to the maintainer.
- The acceptance gate is unchanged: **five testers with a job paid on testnet
  (from the example or their own code) and a returned form**, as defined in
  [`README.md`](README.md). Record the gate date only when supported by the
  individual results and their testnet evidence.
