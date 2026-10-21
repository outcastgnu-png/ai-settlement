# Trial script

## The message to send

> Hi! I'm building an open-source escrow for AI-agent jobs on the XRP Ledger: the
> client's XRP is locked on the ledger and only released when a verifier checks the
> delivered work. It runs on testnet only, with free test XRP, on your own machine.
> Would you spend about 45 minutes trying it and answering 12 short questions?
> The kit is at https://github.com/outcastgnu-png/ai-settlement (release v0.3.0); start with `QUICKSTART.md`.
> Nothing you do can cost real money.

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
4. **Try to break it (optional).** Can you get a fulfillment without passing the
   check, or get paid without one? If you find something, report it as
   `SECURITY.md` describes, not in the form.
5. **Fill in [`FEEDBACK_FORM.md`](FEEDBACK_FORM.md)** and send it back.

## What the organizer does

- Before sending: check the quickstart still works from a fresh clone of the release on
  Windows, and send the repository link.
- Answer questions within a day, and note every question in the tester's results
  file. A question is a sign the docs need fixing.
- After each tester: copy their answers into `results/<date>-<handle>.md`, update
  the summary table in `results/README.md`, and open an issue for each real bug.
