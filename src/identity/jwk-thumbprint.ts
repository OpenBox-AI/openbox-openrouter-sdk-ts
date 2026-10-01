/**
 * RFC 7638 JWK thumbprint derivation for the identity-bootstrap flow.
 *
 * The SDK derives its LOCAL private key's public thumbprint and compares it
 * against the one Core returns for the agent's selected credential. A match
 * proves the runtime holds the right key before a single governed request is
 * sent; a mismatch is fatal and must never be retried past.
 *
 * `crypto` only — this package carries no third-party crypto dependency and
 * this module does not introduce one. Ported from `openbox-sdk-ts`.
 */

import { createHash, createPublicKey, timingSafeEqual, type KeyObject } from 'crypto';

import { OpenBoxIdentityConfigError as OpenBoxConfigError } from '../errors';

/**
 * The three RFC 7638 required members for an RSA key, and nothing else.
 *
 * kid/alg/use are deliberately excluded: an SDK deriving a JWK from a private
 * key does not know Core's stored kid or alg, so including any of them would
 * make the two sides' digests disagree by construction.
 */
interface RsaThumbprintMembers {
  e: string;
  kty: string;
  n: string;
}

/**
 * Canonicalize per RFC 7638 §3: the required members only, lexicographic order
 * (e, kty, n), no whitespace.
 *
 * Built by explicit concatenation rather than `JSON.stringify` of the raw JWK
 * export, because that export may carry extra members and its key order is not
 * guaranteed to be the RFC's. All three values are base64url or the literal
 * "RSA", so none can contain a character JSON would need to escape.
 */
function canonicalize(members: RsaThumbprintMembers): string {
  return `{"e":${JSON.stringify(members.e)},"kty":${JSON.stringify(members.kty)},"n":${JSON.stringify(members.n)}}`;
}

/** Extract the RSA thumbprint members from a `KeyObject`'s JWK export. */
function rsaMembersOf(key: KeyObject): RsaThumbprintMembers {
  // A private key's JWK export includes d/p/q/dp/dq/qi. Converting to a public
  // key FIRST means the private parameters never enter this function's scope.
  const publicKey = key.type === 'private' ? createPublicKey(key) : key;
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;

  const { kty, n, e } = jwk;
  if (kty !== 'RSA' || typeof n !== 'string' || typeof e !== 'string' || !n || !e) {
    throw new OpenBoxConfigError(
      'Cannot derive a JWK thumbprint: expected an RSA key with modulus and exponent (key bytes not shown).',
    );
  }
  return { e, kty, n };
}

/**
 * RFC 7638 SHA-256 thumbprint of `key`'s PUBLIC half, base64url without
 * padding.
 *
 * Accepts a private or public `KeyObject`; a private key is reduced to its
 * public half before anything is serialized, so no private parameter can ever
 * reach the digest input or an error message.
 */
export function jwkThumbprintSha256(key: KeyObject): string {
  return createHash('sha256')
    .update(canonicalize(rsaMembersOf(key)), 'utf-8')
    .digest('base64url');
}

/**
 * Constant-time thumbprint comparison.
 *
 * `timingSafeEqual` throws on length mismatch, so unequal lengths are handled
 * first — that check leaks only the length of a non-secret digest. Constant-time
 * comparison is specified for this step even though a thumbprint is public, so
 * that the routine cannot become a side channel if it is ever reused for
 * something that is not.
 */
export function thumbprintsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf-8');
  const right = Buffer.from(b, 'utf-8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
