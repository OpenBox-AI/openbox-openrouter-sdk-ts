/**
 * IAM v3 workload client assertion — the RFC 7523 `private_key_jwt` a runtime
 * presents to Keycloak's token endpoint (and to Core's candidate-proof route).
 *
 * The assertion authenticates the CLIENT to the token endpoint; it is never the
 * access token sent to Core. Its `aud` is the exact token endpoint and its
 * `kid` names the workload client key — neither is related to the access
 * token's audience (Core's workload audience) or `kid` (a Keycloak realm key).
 *
 * Fixed protocol, fixed shape:
 *   header  {"alg":"RS256","kid":<bootstrap kid>,"typ":"JWT"}
 *   claims  {"aud":<token endpoint>,"exp":iat+60,"iat":<now, integer s>,
 *            "iss":<client id>,"jti":<fresh CSPRNG>,"sub":<client id>}
 * Keys are emitted in sorted order — the same bytes the Python SDK's
 * `sort_keys=True` produces — and RSASSA-PKCS1-v1_5 is deterministic, so fixed
 * inputs yield byte-identical assertions across SDKs.
 *
 */

import { randomBytes, sign as cryptoSign, type KeyObject } from 'crypto';

/** Header carrying the raw (un-prefixed) workload access token on v3 routes. */
export const WORKLOAD_TOKEN_HEADER = 'X-OpenBox-Workload-Token';
/** RFC 7523 client-assertion type for the token-endpoint form. */
export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
/** `exp - iat` of every client assertion. */
export const CLIENT_ASSERTION_LIFETIME_SECONDS = 60;

/** The non-secret values an assertion binds, all supplied by Core. */
export interface ClientAssertionTarget {
  readonly clientId: string;
  readonly kid: string;
  readonly tokenEndpoint: string;
}

/** Deterministic injection points for golden-fixture tests ONLY — never used in production. */
export interface ClientAssertionOverrides {
  readonly issuedAt?: number;
  readonly jti?: string;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf-8').toString('base64url');
}

/**
 * Build and sign a compact RS256 client assertion with `signer` (a key already
 * validated by `loadRsaPrivateKey`).
 */
export function buildWorkloadClientAssertion(
  signer: KeyObject,
  target: ClientAssertionTarget,
  overrides: ClientAssertionOverrides = {},
): string {
  const iat = overrides.issuedAt ?? Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: target.kid, typ: 'JWT' };
  const claims = {
    aud: target.tokenEndpoint,
    exp: iat + CLIENT_ASSERTION_LIFETIME_SECONDS,
    iat,
    iss: target.clientId,
    jti: overrides.jti ?? randomBytes(24).toString('base64url'),
    sub: target.clientId,
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const signature = cryptoSign('RSA-SHA256', Buffer.from(signingInput, 'utf-8'), signer);
  return `${signingInput}.${signature.toString('base64url')}`;
}
