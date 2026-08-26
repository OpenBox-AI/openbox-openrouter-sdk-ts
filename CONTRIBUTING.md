# Contributing

## Getting set up

```bash
npm install
npm test          # unit suite — no network, no keys
npm run typecheck
npm run build
```

The `demo-agent/` workspace runs the SDK against a real agent; it needs an
OpenRouter key and an OpenBox Core to talk to. Copy `demo-agent/.env.example`
to `demo-agent/.env` and fill it in. **Never commit that file.**

## Branches and pull requests

CI enforces both of these, so a PR that ignores them fails before any test runs:

- Branch: `<type>/<short-description>`, where type is one of `feat`, `fix`,
  `hotfix`, `chore`, `docs`, `refactor`, `test`, `ci`, `build`, `release`.
- PR title: conventional commits — `feat(tools): hold approval across retries`.

## What a change needs

- **A test that fails without it.** The suite drives a fake engine that replays
  the real hook order against a fake transport, so most behaviour can be
  covered without a server.
- **Type-check and build clean**, on Node 20 and 22.
- **Comments that explain why, not what.** Much of this code exists because of
  a specific failure — an engine that swallows a thrown halt, a driver whose
  pool dispatches differently. When you change such code, keep the reason
  attached to it.

## Testing enforcement for real

The unit suite cannot prove enforcement works end to end: that needs a running
OpenBox Core with OPA and a policy attached to the agent. If your change
touches verdict handling, approvals, or the span pipeline, exercise it against
a real Core and say so in the PR — which arm you used, and what Core recorded.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
