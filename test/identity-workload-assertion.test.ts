/**
 * RS256 client assertion (RFC 7523 private_key_jwt) for IAM v3: exact header
 * and claims for a fixed non-production key, clock, and jti; signatures that an
 * independent verification accepts; and local rejection of unusable keys.
 */
import { createHash, createPrivateKey, verify as cryptoVerify } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { OpenBoxIdentityConfigError as OpenBoxConfigError } from '../src/errors';
import { loadRsaPrivateKey } from '../src/identity/rsa-private-key';
import {
  CLIENT_ASSERTION_LIFETIME_SECONDS,
  buildWorkloadClientAssertion,
} from '../src/identity/workload-assertion';
import {
  CLIENT_ID,
  EC_PEM,
  OTHER_WORKLOAD_PEM,
  TOKEN_ENDPOINT,
  UNDERSIZED_PEM,
  WORKLOAD_KID,
  WORKLOAD_PEM,
  decodeJwt,
  publicKeyOf,
} from './support/workload-identity-fakes';
import { fakePrivateKeyPem } from './support/fake-private-key-pem';

const TARGET = { clientId: CLIENT_ID, kid: WORKLOAD_KID, tokenEndpoint: TOKEN_ENDPOINT };
const ISSUED_AT = 1_790_000_000;
const JTI = 'fixed-jti-for-golden-assertion';

function signer(pem = WORKLOAD_PEM) {
  return loadRsaPrivateKey(pem, 'workloadPrivateKey');
}

describe('buildWorkloadClientAssertion', () => {
  it('produces the exact header and claims bytes, in sorted key order', () => {
    const token = buildWorkloadClientAssertion(signer(), TARGET, { issuedAt: ISSUED_AT, jti: JTI });
    const [headerB64, claimsB64] = token.split('.');
    expect(Buffer.from(headerB64!, 'base64url').toString()).toBe(
      `{"alg":"RS256","kid":"${WORKLOAD_KID}","typ":"JWT"}`,
    );
    expect(Buffer.from(claimsB64!, 'base64url').toString()).toBe(
      `{"aud":"${TOKEN_ENDPOINT}","exp":${ISSUED_AT + 60},"iat":${ISSUED_AT},` +
        `"iss":"${CLIENT_ID}","jti":"${JTI}","sub":"${CLIENT_ID}"}`,
    );
  });

  it('signs with RS256 so the workload public key verifies it — and no other key does', () => {
    const token = buildWorkloadClientAssertion(signer(), TARGET, { issuedAt: ISSUED_AT, jti: JTI });
    const { signingInput, signature } = decodeJwt(token);
    const input = Buffer.from(signingInput, 'utf-8');
    expect(cryptoVerify('RSA-SHA256', input, publicKeyOf(WORKLOAD_PEM), signature)).toBe(true);
    expect(cryptoVerify('RSA-SHA256', input, publicKeyOf(OTHER_WORKLOAD_PEM), signature)).toBe(
      false,
    );
    // Tampering with any claim invalidates the signature.
    const tampered = Buffer.from(
      signingInput.replace(/\.[^.]+$/, `.${Buffer.from('{}').toString('base64url')}`),
    );
    expect(cryptoVerify('RSA-SHA256', tampered, publicKeyOf(WORKLOAD_PEM), signature)).toBe(false);
  });

  it('matches the Python base SDK byte-for-byte (pinned parity anchor)', () => {
    // SHA-256 of the compact assertion that openbox-sdk-python's
    // `build_private_key_jwt` (f5b85623, openbox_core/workload_identity.py)
    // produced for this fixture key, issued_at=1790000000, and this jti. A
    // Python-parity anchor only — Core/Keycloak acceptance is proven by the
    // interop gate (scripts/core-interop), not by this hash.
    const token = buildWorkloadClientAssertion(signer(), TARGET, { issuedAt: ISSUED_AT, jti: JTI });
    expect(createHash('sha256').update(token).digest('hex')).toBe(
      '4d4a98f810585e2e79b1086fa03f714c4f751d56e6df82447278cb68d377920a',
    );
  });

  it('is deterministic for fixed inputs (RSASSA-PKCS1-v1_5)', () => {
    const a = buildWorkloadClientAssertion(signer(), TARGET, { issuedAt: ISSUED_AT, jti: JTI });
    const b = buildWorkloadClientAssertion(signer(), TARGET, { issuedAt: ISSUED_AT, jti: JTI });
    expect(a).toBe(b);
  });

  it('uses the current time, a one-minute lifetime, and a fresh random jti by default', () => {
    const before = Math.floor(Date.now() / 1000);
    const first = decodeJwt(buildWorkloadClientAssertion(signer(), TARGET)).claims;
    const second = decodeJwt(buildWorkloadClientAssertion(signer(), TARGET)).claims;
    const after = Math.floor(Date.now() / 1000);
    expect(first['iat']).toBeGreaterThanOrEqual(before);
    expect(first['iat']).toBeLessThanOrEqual(after);
    expect(first['exp']).toBe((first['iat'] as number) + CLIENT_ASSERTION_LIFETIME_SECONDS);
    expect(first['jti']).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(first['jti']).not.toBe(second['jti']);
  });

  it("binds audience to the token endpoint and iss/sub to the client id — never Core's audience", () => {
    const { header, claims } = decodeJwt(buildWorkloadClientAssertion(signer(), TARGET));
    expect(claims['aud']).toBe(TOKEN_ENDPOINT);
    expect(claims['iss']).toBe(CLIENT_ID);
    expect(claims['sub']).toBe(CLIENT_ID);
    expect(header['kid']).toBe(WORKLOAD_KID);
    expect(header['alg']).toBe('RS256');
    expect(Object.keys(header).sort()).toEqual(['alg', 'kid', 'typ']);
    expect(Object.keys(claims).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'jti', 'sub']);
  });
});

describe('loadRsaPrivateKey', () => {
  it.each([
    ['undersized RSA', UNDERSIZED_PEM, /at least 2048 bits, got 1024/],
    ['non-RSA', EC_PEM, /expected an RSA key, got 'ec'/],
    ['garbage', fakePrivateKeyPem('nope'), /could not load/],
    ['non-PEM', 'hello', /expected a PKCS8 PEM/],
    ['non-string', 42, /expected a PKCS8 PEM/],
  ])('rejects a %s key, naming the field and never the key bytes', (_label, pem, pattern) => {
    for (const label of ['workloadPrivateKey', 'candidatePrivateKey']) {
      let error: unknown;
      try {
        loadRsaPrivateKey(pem, label);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(OpenBoxConfigError);
      expect((error as Error).message).toContain(`Invalid ${label}`);
      expect((error as Error).message).toMatch(pattern);
      expect((error as Error).message).toContain('key bytes not shown');
      expect((error as Error).message).not.toContain('MII');
    }
  });

  it('loads a PKCS8 PEM RSA-2048 key', () => {
    const key = loadRsaPrivateKey(WORKLOAD_PEM, 'workloadPrivateKey');
    expect(key.asymmetricKeyType).toBe('rsa');
    expect(key.asymmetricKeyDetails?.modulusLength).toBe(2048);
    // The same key material round-trips through Node's own loader.
    expect(createPrivateKey(WORKLOAD_PEM).asymmetricKeyDetails?.modulusLength).toBe(2048);
  });
});
