# Feedback form

Email your completed form to **[outcastgnu@gmail.com](mailto:outcastgnu@gmail.com)**
with subject **AI Settlement developer trial feedback**. Paste the answers into
the email or attach a Markdown/text file. No public post or pull request is needed.
Short answers and partial or unsuccessful runs are welcome; say what you could
not complete rather than filling in a success you did not observe.

Use [this current form](https://github.com/outcastgnu-png/ai-settlement/blob/main/docs/trial/FEEDBACK_FORM.md)
even when running the v0.3.0 release, whose bundled return instructions are older.

**Before sending**

- Never include `.env`, wallet seeds/private keys, secrets, fulfillments/preimages,
  or service tokens, even by email. Redact them from logs and screenshots.
- Omit unnecessary personal/company information, contact details in the answers,
  and private deliverable contents. A general description of what you build is enough.
- Testnet explorer links are public and can expose wallet addresses and activity.
  Include only trial transaction links needed to support your answers; no mainnet
  wallet information is requested.
- Do not include suspected vulnerabilities in this form, forum replies, or public
  issues. Report them separately and privately through
  [`SECURITY.md`](../../SECURITY.md), using a
  [private security advisory](https://github.com/outcastgnu-png/ai-settlement/security/advisories/new)
  or a separate email to the maintainer.

The organizer will record sanitized answers and necessary testnet evidence in the
public [results folder](results/README.md), using only a handle or alias agreed
with you. Your email address and other contact details will not be copied there.

- Kit version/tag or commit tested:
- Public handle or alias you agree may appear in results (optional; if blank, the
  organizer will agree an anonymous label with you before publication):

**About you**
1. What do you build? (agents, XRPL apps, something else)
2. Language you used for the trial (TypeScript / Python) and your OS:

**Getting started**
3. How long did steps 1 to 3 of the quickstart take you, in minutes?
4. Where did you get stuck, if anywhere? What error did you see?

**Using it**
5. Did you get a job paid on testnet? (yes / no) A refunded one? (yes / no)
6. Paste a testnet explorer link showing the paid job (EscrowFinish transaction).
   If no job was paid, say so and include any relevant testnet link or redacted error.
   A refund link, if available, can support your answer to question 5:
7. Which part of the SDK was confusing or missing something?
8. Was the oracle's verdict (pass or fail, signed) enough for you to trust the result? Why?

**Would you use it**
9. What job would you actually put through an escrow like this?
10. What check would that job need that the kit doesn't have? (`sha256-match`,
    `json-schema` and `max-latency` exist today)
11. Would you rather run the verifier yourself, or pay for a hosted one? Roughly what
    would a hosted one be worth to you per month?
12. Anything else?
