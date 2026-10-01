# v2 assertion tamper fixtures

One file per expected-failure case, each carrying its expected `reason_code` from
[the contract §7](../../../docs/agent-identity-v2-contract.md#7-error-classification).

Every case here is **expressible in an assertion alone** — the verifier can reject it from the token,
the request, and the bearer API key, with no database or cache state. Regenerate with
`go run ./scripts/gen-identity-fixtures`.

## Coverage of proposal §20.5

### Covered by a fixture in this directory

| §20.5 case | Fixture |
|---|---|
| Missing assertion | `missing-assertion.json` |
| Malformed compact JWT | `malformed-jwt.json`, `malformed-jwt-truncated.json` |
| Wrong `typ` | `wrong-typ.json` |
| Disallowed `alg` | `alg-none.json`, `alg-symmetric.json` |
| Embedded caller JWK | `embedded-jwk.json`, `embedded-jku.json`, `embedded-x5u.json` |
| RSA below minimum size (§17.10) | `undersized-rsa-key.json` |
| Signature mismatch | `signature-by-other-key.json` |
| Unknown `kid` | `unknown-kid.json` |
| Wrong `iss` or `sub` | `wrong-iss.json`, `wrong-sub.json` |
| Wrong audience | `wrong-audience.json` |
| Wrong OpenBox deployment ID | `wrong-deployment-id.json` |
| Wrong signed OpenBox agent ID | `wrong-signed-agent-id.json` |
| Wrong signed OpenBox organization ID | `wrong-signed-organization-id.json` |
| Assertion paired with a different bearer API key | `paired-with-different-api-key.json` |
| Expired assertion | `expired.json` |
| Excessive lifetime | `excessive-lifetime.json` |
| Future `iat` | `future-iat.json` |
| Wrong HTTP method | `wrong-http-method.json` |
| Wrong path / v1 path | `wrong-path.json`, `v1-path.json`, `htu-with-host.json`, `htu-with-query.json` |
| Body tampering | `body-tampered.json` |
| Normal validation sent to the transition-proof route | `normal-assertion-on-transition-proof-route.json` |
| Transition proof sent to `GET /api/v2/auth/validate` | `transition-proof-on-validate-route.json` |
| Wrong transition challenge | `wrong-transition-challenge.json` |
| Wrong transition purpose | `wrong-transition-purpose.json` |
| Transition assertion signed by a different active credential | `transition-proof-signed-by-other-credential.json` |

Two cases not enumerated in §20.5 are included because the contract makes them rejections and a
missing claim must never take a default: `missing-exp.json` and `empty-jti.json`.

### Not fixture-expressible — verifier scaffolding tests

These depend on database rows, cache state, or concurrency, so they belong to the Phase 7 verifier
test suite rather than here. A fixture cannot express them because the *same bytes* are valid or
invalid depending on state the fixture does not own.

| §20.5 case | Owner |
|---|---|
| Active but non-selected `kid` | Phase 7 — credential-selection lookup |
| Inactive credential | Phase 7 — `status = 'active'` predicate |
| Stale projection (`last_synced_at` > 300s) | Phase 7 — freshness predicate |
| Inactive Okta identity / unlinked identity | Phase 7 — link + principal lifecycle predicates |
| API key belongs to a different OpenBox agent | Phase 7 — API-key resolution |
| Organization mismatch | Phase 7 — org predicates on all four tables |
| Replayed `jti` | Phase 7 — `ClaimOnce` |
| Two concurrent requests, same `jti` → exactly one winner | Phase 7 — `ClaimOnce` concurrency test |
| Replay-cache outage (fail closed) | Phase 7 — Redis unavailability |
| Credential datastore outage | Phase 7 — datastore unavailability |
| Unknown / expired / consumed / cross-agent transition intent | Phase 7 — Gate B |
| v1 call by an Okta-mode agent | Phase 8 — method enforcement |
| v2 call by an OpenBox-DID agent | Phase 8 — method enforcement |
| Source-authenticated v1 handoff by a `legacy_unsigned` agent | Phase 7 — handoff route |
| Cross-organization / missing / inactive / self handoff target | Phase 7 — handoff route |
| Candidate DID proof using the active alias or another transition's key | Phase 7 — v1 proof route |

Phase 7 must cite this table when it claims §20.5 coverage; a case dropped from both lists is a
coverage gap, not a simplification.
