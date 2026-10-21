# Security

This kit is a **testnet-only developer preview**. Do not use it to move real
value. It has had two independent reviews (see `xrpl-escrow/docs/reviews/`),
but it is not audited for production use.

## Reporting a problem

Please report anything that could let someone get a fulfillment without passing
the checks, finish or cancel an escrow they shouldn't, forge a job status or a
verdict, read a secret, or make the oracle run deliverable content.

- Report privately to the maintainer, Christopher Terrell, at **outcastgnu@gmail.com** (until the
  public repository is up; then use its private security advisories).
- Don't open a public issue for it, and don't test against other people's services.
- Include the commit, what you did, what happened, and what you expected.

You'll get a reply within 7 days. Fixes are credited in `CHANGELOG.md` unless you'd
rather not be named.

## In scope

The TypeScript kit (`xrpl-escrow/`) and the Python SDK (`xrpl-escrow-py/`).
Known limits that are by design for this preview are listed in
[`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md); reports about them are still welcome
if you see a way to make them worse than described.
