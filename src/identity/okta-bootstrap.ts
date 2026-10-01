/**
 * Identity bootstrap: fetch the non-secret metadata needed to construct a v2
 * assertion from `GET /api/v2/auth/bootstrap`, and prove the local private key
 * belongs to the credential Core actually selected.
 *
 * Why this exists: signing a v2 assertion requires seven values (agent id,
 * organization id, deployment id, audience, external Okta agent id, credential
 * `kid`, algorithm) that Core already owns. Requiring an operator to copy them
 * into the runtime invites drift — a stale `kid` after rotation, an audience
 * pointing at the wrong deployment, an agent id copied from the wrong agent.
 * Core is the authority that validates them, so Core supplies them.
 *
 * Fetching them does NOT make them trusted. Core independently re-derives and
 * re-compares every value when the signed assertion arrives; bootstrap only
 * removes the copying step.
 *
 * Ported from `openbox-sdk-ts` `src/config/bootstrap.ts`.
 */

import {
  OpenBoxIdentityBootstrapError,
  OpenBoxIdentityConfigError as OpenBoxConfigError,
} from '../errors';
import { jwkThumbprintSha256, thumbprintsMatch } from './jwk-thumbprint';
import { loadRsaPkcs8PrivateKey } from './okta';
import { anySignal, timeoutSignal } from './signals';

/** Same value as `OPENBOX_INTERNAL_REQUEST` in transport.ts (not imported, to keep this module a leaf). */
const INTERNAL_REQUEST_MARKER = '__openboxInternalRequest';

/** `GET /api/v2/auth/bootstrap`. */
export const AUTH_BOOTSTRAP_PATH_V2 = '/api/v2/auth/bootstrap';

/**
 * The only bootstrap wire version this SDK understands. An unknown version
 * fails closed with upgrade guidance rather than being interpreted optimistically.
 */
export const SUPPORTED_BOOTSTRAP_VERSION = 1;

/**
 * Provider-neutral, non-secret active-authority metadata (IAM v3 addition to
 * the still-version-1 document). Core resolves the active assignment, provider
 * generation, selected identity, and credential before returning it; the SDK
 * cannot prove the snapshot is still current — Core re-resolves authority when
 * verifying each governed request.
 */
export interface IdentityBootstrapAuthority {
  readonly assignmentId: string;
  readonly providerGenerationId: string;
  readonly generationNumber: number;
  readonly activationVersion: string;
  readonly identityId: string;
  readonly credentialId: string;
  /** Opaque projection version — not a UUID. */
  readonly projectionVersion: string;
}

/** The okta_ai_agent half of the bootstrap document. */
export interface IdentityBootstrapOkta {
  readonly externalAgentId: string;
  readonly credentialKid: string;
  readonly algorithm: string;
  readonly publicJwkThumbprint: string;
}

/** A validated bootstrap document. Contains no secret material. */
export interface IdentityBootstrapDocument {
  readonly bootstrapVersion: number;
  readonly identityMethod: string;
  readonly openboxAgentId: string;
  readonly organizationId: string;
  readonly deploymentId: string;
  readonly assertionAudience: string;
  /** Required: a document without it fails closed, even though the version is still 1. */
  readonly authority: IdentityBootstrapAuthority;
  readonly okta: IdentityBootstrapOkta;
}

/** Machine reason code from Core's error body, mirroring the client's helper. */
function reasonCodeOf(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const dict = parsed as Record<string, unknown>;
    const code = dict['reason_code'] ?? dict['reason'];
    return typeof code === 'string' ? code : null;
  } catch {
    return null;
  }
}

function requireString(source: Record<string, unknown>, key: string, path: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value === '') {
    throw new OpenBoxConfigError(
      `Identity bootstrap response is invalid: '${path}' must be a non-empty string.`,
    );
  }
  return value;
}

// Core's authority identifiers are uuid.UUID values; projection version and
// organization id are opaque strings and are not held to a UUID shape.
const AUTHORITY_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireAuthorityUuid(source: Record<string, unknown>, key: string): string {
  const value = requireString(source, key, `authority.${key}`);
  if (!AUTHORITY_UUID_PATTERN.test(value)) {
    throw new OpenBoxConfigError(
      `Identity bootstrap response is invalid: 'authority.${key}' must be a UUID.`,
    );
  }
  return value;
}

/**
 * Parse the required `authority` object. Older Core deployments that predate
 * it are incompatible with this SDK — upgrade Core, or configure the complete
 * explicit Okta identity (which needs no bootstrap).
 */
function parseAuthority(raw: unknown): IdentityBootstrapAuthority {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new OpenBoxConfigError(
      "Identity bootstrap response is invalid: 'authority' must be an object. This Core deployment " +
        'predates IAM-aware bootstrap; upgrade Core, or supply the complete explicit Okta identity configuration.',
    );
  }
  const authority = raw as Record<string, unknown>;
  const generationNumber = authority['generation_number'];
  if (
    typeof generationNumber !== 'number' ||
    !Number.isSafeInteger(generationNumber) ||
    generationNumber < 1
  ) {
    throw new OpenBoxConfigError(
      "Identity bootstrap response is invalid: 'authority.generation_number' must be a positive integer.",
    );
  }
  return {
    assignmentId: requireAuthorityUuid(authority, 'assignment_id'),
    providerGenerationId: requireAuthorityUuid(authority, 'provider_generation_id'),
    generationNumber,
    activationVersion: requireAuthorityUuid(authority, 'activation_version'),
    identityId: requireAuthorityUuid(authority, 'identity_id'),
    credentialId: requireAuthorityUuid(authority, 'credential_id'),
    projectionVersion: requireString(
      authority,
      'projection_version',
      'authority.projection_version',
    ),
  };
}

/**
 * Parse and strictly validate a bootstrap response body.
 *
 * Every check fails closed. A response that is merely *plausible* is not good
 * enough: the values here determine what this runtime signs, and a silently
 * accepted wrong value produces assertions Core will reject with no local
 * explanation.
 */
export function parseBootstrapDocument(raw: unknown): IdentityBootstrapDocument {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new OpenBoxConfigError('Identity bootstrap response is invalid: expected a JSON object.');
  }
  const body = raw as Record<string, unknown>;

  const version = body['bootstrap_version'];
  if (version !== SUPPORTED_BOOTSTRAP_VERSION) {
    throw new OpenBoxConfigError(
      `Unsupported identity bootstrap version ${JSON.stringify(version)}; this SDK supports ` +
        `version ${SUPPORTED_BOOTSTRAP_VERSION}. Upgrade the OpenBox SDK to match your Core deployment.`,
    );
  }

  const identityMethod = requireString(body, 'identity_method', 'identity_method');
  if (identityMethod !== 'okta_ai_agent') {
    throw new OpenBoxConfigError(
      `This OpenBox agent's identity method is '${identityMethod}', not 'okta_ai_agent'. ` +
        'Configure the matching identity for this agent, or select an Okta credential for it in OpenBox.',
    );
  }

  const oktaRaw = body['okta'];
  if (typeof oktaRaw !== 'object' || oktaRaw === null) {
    throw new OpenBoxConfigError(
      "Identity bootstrap response is invalid: 'okta' must be an object.",
    );
  }
  const okta = oktaRaw as Record<string, unknown>;

  const algorithm = requireString(okta, 'algorithm', 'okta.algorithm');
  if (algorithm.toUpperCase() !== 'RS256') {
    throw new OpenBoxConfigError(
      `Unsupported Okta credential algorithm '${algorithm}'; only 'RS256' is allowlisted.`,
    );
  }

  return {
    bootstrapVersion: SUPPORTED_BOOTSTRAP_VERSION,
    identityMethod,
    openboxAgentId: requireString(body, 'openbox_agent_id', 'openbox_agent_id'),
    organizationId: requireString(body, 'organization_id', 'organization_id'),
    deploymentId: requireString(body, 'deployment_id', 'deployment_id'),
    assertionAudience: requireString(body, 'assertion_audience', 'assertion_audience'),
    authority: parseAuthority(body['authority']),
    okta: {
      externalAgentId: requireString(okta, 'external_agent_id', 'okta.external_agent_id'),
      credentialKid: requireString(okta, 'credential_kid', 'okta.credential_kid'),
      algorithm: 'RS256',
      publicJwkThumbprint: requireString(
        okta,
        'public_jwk_thumbprint',
        'okta.public_jwk_thumbprint',
      ),
    },
  };
}

/**
 * The fatal key-mismatch message. Actionable on purpose: this is the one
 * bootstrap failure an operator can only fix by changing which key the runtime
 * holds, or which credential the agent has selected.
 */
export const PRIVATE_KEY_MISMATCH_MESSAGE =
  'The configured private key does not match the selected Okta credential for this OpenBox agent. ' +
  'Export the private key associated with the selected credential, or rotate the agent credential.';

/**
 * Verify the local private key corresponds to the selected public credential.
 *
 * This runs BEFORE any governed request. Sending one after a mismatch could only
 * produce a signature Core rejects, with a far less diagnosable error.
 */
export function assertPrivateKeyMatchesDocument(
  privateKeyPem: string,
  document: IdentityBootstrapDocument,
): void {
  const localThumbprint = jwkThumbprintSha256(loadRsaPkcs8PrivateKey(privateKeyPem));
  if (!thumbprintsMatch(localThumbprint, document.okta.publicJwkThumbprint)) {
    throw new OpenBoxConfigError(PRIVATE_KEY_MISMATCH_MESSAGE);
  }
}

export interface FetchBootstrapOptions {
  readonly apiUrl: string;
  /** The base API-key headers (no assertion — this request is what makes one possible). */
  readonly headers: Record<string, string>;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
  /** Aborts when the acquisition is superseded or the transport closes. */
  readonly signal?: AbortSignal;
}

/**
 * Fetch and validate the bootstrap document.
 *
 * Authenticated by API key ALONE — this request deliberately carries no
 * assertion, because the response is what makes constructing one possible. It
 * therefore builds its headers directly rather than going through the client's
 * signing path.
 */
export async function fetchBootstrapDocument(
  options: FetchBootstrapOptions,
): Promise<IdentityBootstrapDocument> {
  const url = `${options.apiUrl.replace(/\/+$/, '')}${AUTH_BOOTSTRAP_PATH_V2}`;
  const headers = { ...options.headers, Accept: 'application/json' };

  const { signal, dispose } = anySignal([timeoutSignal(options.timeoutMs), options.signal]);
  let response: Response;
  try {
    response = await options.fetchImpl(url, {
      method: 'GET',
      headers,
      signal,
      // Never follow a redirect: the API key must not travel to another host.
      redirect: 'manual',
      ...({ [INTERNAL_REQUEST_MARKER]: true } as Record<string, unknown>),
    });
  } catch (e) {
    // Never fall back to an unsigned or v1 request — surface the outage.
    throw new OpenBoxIdentityBootstrapError(
      `Identity bootstrap failed: could not reach OpenBox Core at ${url} ` +
        `(${e instanceof Error ? e.message : String(e)}); no governed request was sent.`,
      null,
    );
  } finally {
    dispose();
  }

  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    throw new OpenBoxIdentityBootstrapError(
      `Identity bootstrap was answered with a redirect (HTTP ${response.status}); redirects are refused so the API key never follows one.`,
      response.status,
    );
  }

  const text = await response.text().catch(() => '');

  if (response.status === 404) {
    throw new OpenBoxIdentityBootstrapError(
      'This Core version does not support Okta identity bootstrap. Upgrade Core or provide the ' +
        'complete legacy Okta identity configuration.',
      404,
    );
  }
  if (!response.ok) {
    const code = reasonCodeOf(text);
    throw new OpenBoxIdentityBootstrapError(
      `Identity bootstrap failed with HTTP ${response.status}` +
        (code ? ` (${code})` : '') +
        `: ${bootstrapGuidanceFor(code, response.status)}`,
      response.status,
      code,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OpenBoxConfigError('Identity bootstrap response is invalid: body is not valid JSON.');
  }
  return parseBootstrapDocument(parsed);
}

/**
 * Operator-facing guidance per Core reason code. Codes come from Core's stable
 * bootstrap set; an unrecognized code falls back to a generic hint rather than
 * being treated as success.
 */
function bootstrapGuidanceFor(code: string | null, status: number): string {
  switch (code) {
    case 'invalid_api_key':
      return 'the OPENBOX_API_KEY is absent, invalid, or revoked.';
    case 'agent_inactive':
      return 'this agent is not active in OpenBox.';
    case 'identity_method_mismatch':
      return 'this agent is not configured for Okta identity verification.';
    case 'selected_credential_missing':
      return 'select or register an Okta credential for this agent in OpenBox.';
    case 'selected_credential_inactive':
      return "the agent's selected Okta credential or its provider link is not active.";
    case 'credential_algorithm_unsupported':
      return 'the selected Okta credential uses an algorithm this contract does not allow.';
    case 'provider_metadata_stale':
      return 'OpenBox has not recently synchronized this credential from Okta; retry shortly.';
    case 'identity_configuration_invalid':
      return "the OpenBox Core deployment's identity configuration is incomplete.";
    case 'verifier_unavailable':
      return 'OpenBox Core is temporarily unable to resolve identity metadata; retry shortly.';
    default:
      return status >= 500
        ? 'OpenBox Core reported a server-side problem; retry shortly.'
        : "check the API key and this agent's identity configuration in OpenBox.";
  }
}
