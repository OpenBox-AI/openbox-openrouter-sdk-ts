# Security Policy

## Reporting a vulnerability

Report security issues privately to **security@openbox.ai**, or through GitHub's
[private vulnerability reporting](https://github.com/OpenBox-AI/openbox-openrouter-sdk-ts/security/advisories/new).
Please do not open a public issue for a vulnerability.

Include what you have: affected version, a description, and the smallest
reproduction you can manage. We aim to acknowledge within three working days and
to ship a fix or a mitigation plan within thirty days, faster where the severity
warrants it. We will keep you updated while it is open, and credit you in the
advisory unless you would rather we did not.

## Supported versions

The latest minor release receives security fixes.

## What this package handles

This SDK sits between an agent and OpenBox Core, so a few areas deserve extra
scrutiny in any report:

- **Credentials.** An API key and an Ed25519 signing seed are read from the
  environment and used to sign requests. They are never written to a governance
  event, a span, or a log line.
- **Captured payloads.** Prompts, tool arguments, tool results and HTTP bodies
  are sent to Core as governance evidence. Anything that widens what is
  captured — or leaks it somewhere other than Core — is a security issue.
- **Enforcement.** A verdict that fails to stop what it should stop is a
  security issue, not just a bug: a blocked tool that still runs, a halt that
  does not end the run, or an approval gate that resolves without a decision.
- **Fail-open behaviour.** `onApiError: 'fail_open'` lets a run continue when
  Core is unreachable. Authentication failures (401/403) always hard-fail
  regardless — if you find a path where a revoked key silently degrades to
  "run ungoverned", report it.
