/**
 * OktaAgentIdentity — v2 (`okta_ai_agent`) RS256 assertion signing.
 *
 * Implements the Core v2 verification contract
 * (docs/agent-identity-v2-contract.md §2-4, proposal §13.4). Unlike v1's
 * canonical-string + header scheme (identity/index.ts), v2 carries every
 * bound value as a named JWT claim inside one header,
 * `X-OpenBox-Agent-Assertion`. v1's identity headers
 * (`X-OpenBox-Agent-DID`/`-Timestamp`/`-Nonce`/`-Signature`,
 * `X-OpenBox-Body-SHA256`) are NEVER sent alongside it — this module never
 * imports or calls anything that sets them (contract §2.1).
 *
 * Contract invariants:
 * - Claims are inserted in the EXACT alphabetical key order Core's Go
 *   verifier's fixture generator produces (a `jwt.MapClaims`, a plain map,
 *   which `encoding/json` always marshals in sorted key order) — otherwise
 *   the signed bytes (and so the RS256 signature) diverge from the shared
 *   golden fixture even though both sides would still successfully verify
 *   each other's independently-built tokens.
 * - The private key's sole canonical encoding is PKCS8 PEM (decision §13.1
 *   rule 8). It is loaded into a `KeyObject` and never re-exposed: this class
 *   exposes only non-secret identity fields as public properties, exactly
 *   mirroring `AgentIdentity` in identity/index.ts (a `KeyObject` field is
 *   itself safe to hold — Node never serializes key material via
 *   `inspect`/`JSON.stringify`).
 * - RS256 is RSASSA-PKCS1-v1_5, which is deterministic: the same key and the
 *   exact same header/claim bytes always produce the same signature. That is
 *   what lets golden-fixture tests assert byte-identical assertions, not
 *   merely mutually-verifiable ones.
 *
 * Ported from `openbox-sdk-ts` `src/identity/okta.ts`. The transport serializes
 * the body once and passes those exact bytes here, so the hash that is signed
 * is the hash of what is sent.
 */

import { createHash, randomUUID, sign as cryptoSign, type KeyObject } from 'crypto';

import { OpenBoxIdentityConfigError as OpenBoxConfigError } from '../errors';
import { MIN_RSA_MODULUS_BITS, loadRsaPrivateKey } from './rsa-private-key';

/** A fully resolved Okta AI Agent identity: Core's metadata plus the local private key. */
export interface OktaAiAgentIdentityConfig {
  readonly method: 'okta_ai_agent';
  /** OpenBox agent UUID (signed as `obx_agent_id`). */
  readonly openboxAgentId: string;
  /** OpenBox organization id (signed as `obx_organization_id`). */
  readonly organizationId: string;
  /** Stable deployment identifier (signed as `obx_deployment_id`). */
  readonly deploymentId: string;
  /** The linked Okta AI Agent's external id (signed as `iss`/`sub`). */
  readonly externalAgentId: string;
  /** The selected public credential's `kid`. */
  readonly keyId: string;
  readonly algorithm: 'RS256';
  /** PKCS8 PEM RSA private key. */
  readonly privateKey: string;
  /** Assertion audience (`aud`). */
  readonly audience: string;
}

/** The v2 wire header carrying the compact RS256 JWT (contract §2.1). */
export const ASSERTION_HEADER = 'X-OpenBox-Agent-Assertion';
/** Required, case-sensitive protected-header `typ` (contract §3). */
export const ASSERTION_TYP = 'openbox-agent-proof+jwt';
/** Allowlisted at exactly one value for this release (contract §3, decision 24.2). */
export const ASSERTION_ALGORITHM = 'RS256';
/** Minimum RSA modulus size Core accepts — reject smaller keys locally (contract §3, decision 24.3). */
export { MIN_RSA_MODULUS_BITS };
/** `exp - iat` ceiling (contract §4, decision 24.4). Every assertion is minted at this maximum. */
export const ASSERTION_LIFETIME_SECONDS = 60;

/**
 * Load a PKCS8 PEM-encoded RSA private key, rejecting non-RSA key types and
 * RSA keys below the 2048-bit floor LOCALLY. Never echoes key bytes in any
 * error message — only shape/size facts. Delegates to the provider-neutral
 * loader so the Okta and workload paths share one validation rule.
 */
export function loadRsaPkcs8PrivateKey(pem: string): KeyObject {
  return loadRsaPrivateKey(pem, 'Okta agent private key');
}

/**
 * A validated Okta AI Agent identity plus its loaded RS256 signer.
 *
 * Only non-secret identity fields are public properties — the raw PEM never
 * survives construction as a class field (only the opaque `KeyObject` does),
 * so a routine `console.log(identity)` or `JSON.stringify(identity)` cannot
 * dump key material.
 */
export class OktaAgentIdentity {
  readonly openboxAgentId: string;
  readonly organizationId: string;
  readonly deploymentId: string;
  readonly externalAgentId: string;
  readonly keyId: string;
  readonly algorithm: 'RS256';
  readonly audience: string;
  private readonly signer: KeyObject;

  private constructor(config: OktaAiAgentIdentityConfig, signer: KeyObject) {
    this.openboxAgentId = config.openboxAgentId;
    this.organizationId = config.organizationId;
    this.deploymentId = config.deploymentId;
    this.externalAgentId = config.externalAgentId;
    this.keyId = config.keyId;
    this.algorithm = config.algorithm;
    this.audience = config.audience;
    this.signer = signer;
  }

  /** Validate the algorithm allowlist, load the configured PKCS8 PEM key, return a ready identity. */
  static fromConfig(config: OktaAiAgentIdentityConfig): OktaAgentIdentity {
    // Cast defends against a caller that bypasses the static `"RS256"` literal
    // type (env-var-driven config, plain-JS callers) — the type system alone
    // would otherwise consider this branch unreachable.
    if ((config.algorithm as string) !== ASSERTION_ALGORITHM) {
      throw new OpenBoxConfigError(
        `Unsupported Okta agent algorithm: '${String(config.algorithm)}'. Only '${ASSERTION_ALGORITHM}' is allowlisted.`,
      );
    }
    return new OktaAgentIdentity(config, loadRsaPkcs8PrivateKey(config.privateKey));
  }

  /** Sign `signingInput` (`header.payload`) with RSASSA-PKCS1-v1_5 SHA-256; base64url, unpadded. */
  sign(signingInput: string): string {
    return cryptoSign('RSA-SHA256', Buffer.from(signingInput, 'utf-8'), this.signer).toString(
      'base64url',
    );
  }
}

/** Deterministic injection points for golden-fixture tests ONLY — never used in production. */
export interface OktaAssertionOverrides {
  jti?: string;
  iat?: number;
  exp?: number;
}

/** The three additional claims required only on `/api/v{1,2}/auth/transition-proof` (contract §4.1). */
export interface OktaTransitionClaims {
  transitionId: string;
  /** Raw challenge, base64url — passed through verbatim, never re-encoded. */
  transitionChallenge: string;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf-8').toString('base64url');
}

/**
 * Build and sign a compact v2 assertion. Claims are inserted in the EXACT key
 * order Core's Go verifier's map-based JSON marshaling produces (alphabetical
 * — see the module docstring), so two SDKs signing the same inputs produce
 * byte-identical tokens, not merely mutually-verifiable ones.
 */
export function signOktaAssertion(
  identity: OktaAgentIdentity,
  method: string,
  path: string,
  bodySha256: string,
  apiKey: string,
  transition: OktaTransitionClaims | null = null,
  overrides: OktaAssertionOverrides = {},
): string {
  const header = { alg: identity.algorithm, kid: identity.keyId, typ: ASSERTION_TYP };
  const iat = overrides.iat ?? Math.floor(Date.now() / 1000);
  const exp = overrides.exp ?? iat + ASSERTION_LIFETIME_SECONDS;
  const jti = overrides.jti ?? randomUUID();
  const apiKeySha256 = createHash('sha256').update(apiKey, 'utf-8').digest('hex');

  // Alphabetical key order — matches the shared Go/TS/Python golden fixture byte-for-byte.
  const claims: Record<string, unknown> = {
    aud: identity.audience,
    body_sha256: bodySha256,
    exp,
    htm: method.toUpperCase(),
    htu: path,
    iat,
    iss: identity.externalAgentId,
    jti,
    obx_agent_id: identity.openboxAgentId,
    obx_api_key_sha256: apiKeySha256,
    obx_deployment_id: identity.deploymentId,
    obx_organization_id: identity.organizationId,
  };
  if (transition !== null) {
    claims['obx_transition_challenge'] = transition.transitionChallenge;
    claims['obx_transition_id'] = transition.transitionId;
    claims['obx_transition_purpose'] = 'okta_ai_agent';
  }
  claims['sub'] = identity.externalAgentId;

  const headerB64 = base64UrlJson(header);
  const payloadB64 = base64UrlJson(claims);
  const signingInput = `${headerB64}.${payloadB64}`;
  return `${signingInput}.${identity.sign(signingInput)}`;
}

/**
 * The `X-OpenBox-Agent-Assertion` value for one request over `bodyBytes` —
 * the exact bytes the caller sends. v1 DID identity headers are never built
 * here; the caller adds this one header to the base bearer-auth headers.
 */
export function oktaAssertionFor(
  identity: OktaAgentIdentity,
  method: string,
  path: string,
  bodyBytes: Buffer,
  apiKey: string,
  overrides: OktaAssertionOverrides = {},
): string {
  const bodySha256 = createHash('sha256').update(bodyBytes).digest('hex');
  return signOktaAssertion(identity, method, path, bodySha256, apiKey, null, overrides);
}
