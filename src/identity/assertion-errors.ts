/**
 * v2 (`okta_ai_agent`) assertion rejection guidance, keyed on Core's v2
 * reason codes. Ported from `openbox-sdk-ts` `src/errors/assertion.ts`.
 */

import { OpenBoxAssertionError } from '../errors';

// Contract §7's reason-code table → actionable SDK guidance. `verifier_unavailable`
// is a 500/503 (infrastructure), never itself a 401/403 auth rejection, but is
// included for completeness if a caller ever maps it through this function.
const ASSERTION_REASON_MESSAGES: Record<string, string> = {
  assertion_missing:
    'No assertion was sent (assertion_missing). Configure an okta_ai_agent identity ' +
    'so X-OpenBox-Agent-Assertion is attached to every v2 request.',
  assertion_malformed: 'The assertion is not a well-formed compact JWT (assertion_malformed).',
  assertion_typ_mismatch:
    "The assertion's 'typ' header is not 'openbox-agent-proof+jwt' (assertion_typ_mismatch).",
  assertion_alg_rejected:
    "The assertion's algorithm is not allowlisted (assertion_alg_rejected). Only RS256 is accepted.",
  assertion_embedded_key_rejected:
    'The assertion embeds a caller-supplied jwk/jku/x5u header (assertion_embedded_key_rejected), ' +
    'which Core rejects before any signature work.',
  assertion_key_too_small:
    'The signing RSA key is below the 2048-bit minimum (assertion_key_too_small).',
  assertion_signature_invalid:
    'Assertion signature rejected (assertion_signature_invalid). Usually a body-hash mismatch ' +
    '(send the exact hashed bytes, never re-serialize) or a wrong/rotated private key.',
  method_endpoint_mismatch:
    "This agent's verification method does not match the endpoint version called " +
    '(method_endpoint_mismatch). An okta_ai_agent identity must call /api/v2/* routes only.',
  binding_invalid:
    "The assertion's bound claims (org/agent/method/path/body) do not match the request " +
    '(binding_invalid). Check the configured deploymentId/organizationId/openboxAgentId/audience.',
  transition_proof_invalid:
    'Transition proof rejected (transition_proof_invalid) — unknown, expired, or consumed ' +
    'transition intent, or a candidate/kid mismatch.',
  proof_expired:
    'Assertion or transition proof expired or outside the allowed clock skew (proof_expired).',
  proof_replayed:
    "This assertion's jti was already used (proof_replayed). Each request must carry a fresh jti.",
  identity_ineligible:
    'The linked Okta identity or credential is inactive or its projection is stale ' +
    '(identity_ineligible). Re-sync or re-link the Okta AI Agent.',
  verifier_unavailable:
    "OpenBox Core's v2 verifier is temporarily unavailable (verifier_unavailable).",
};

/** An actionable `OpenBoxAssertionError` for Core's reason code; unknown codes get a generic message. */
export function mapAssertionError(
  status: number,
  reasonCode: string | null,
): OpenBoxAssertionError {
  const message =
    (reasonCode && ASSERTION_REASON_MESSAGES[reasonCode]) ||
    `Okta agent assertion rejected by OpenBox Core (HTTP ${status}${reasonCode ? ` ${reasonCode}` : ''}).`;
  return new OpenBoxAssertionError(message, status, reasonCode);
}
