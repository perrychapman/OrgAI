# Security

## Reporting a vulnerability

Do not open a public issue, pull request or discussion for a security problem.

Use GitHub private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**
(`https://github.com/perrychapman/OrgAI/security/advisories/new`). If that is unavailable, contact the maintainer
(@perrychapman) through the email on their GitHub profile.

Include what you found, the version (App settings > About), your OS, steps to reproduce (`ORGAI_MOCK=1` if it
reproduces there) and what an attacker gains. Redact keys, tokens and `secrets.json` content; never attach them.

## What counts

Anything that lets untrusted input (a repository's files, GitHub text, MCP server output, a pasted kit file) cross a
boundary OrgAI enforces: permission rules and modes, reference or allowed folders, the self-control gate, secret
storage, child process environment, the CLI socket, path checks or spawn enforcement. Priority `p0` covers security,
data loss and anything that blocks everyone.

## What to expect

This is a small project. You should get an acknowledgement, and a fix lands on `dev` and then `main` with the finding
credited if you wish. There is no bounty and no fixed response time. Only the latest release and `dev` are supported.

## Contributors and agents

A security finding discovered during other work is not filed as a public issue. Report it privately as above and
mention only that a private report exists. Security-relevant changes need a Reviewer pass, and Critical or High
findings block the change.
