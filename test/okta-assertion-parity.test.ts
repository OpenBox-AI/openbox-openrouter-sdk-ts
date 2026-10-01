/**
 * Okta v2 assertions are byte-identical to openbox-core's golden fixtures.
 *
 * The fixtures (test/fixtures/identity-v2, owned by openbox-core and synced
 * through openbox-sdk-ts) were minted by Core's own generator. RS256 is
 * deterministic, so producing the exact same compact JWT for the same inputs
 * proves our claims, claim order, header, body hash and signature all match
 * what Core verifies — not merely that our tokens are self-consistent.
 *
 * Do not edit the fixture files; re-sync them from openbox-core.
 */

import { createHash, createPrivateKey, type JsonWebKey } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { inspect } from 'util';

import { describe, expect, it } from 'vitest';

import { OktaAgentIdentity, oktaAssertionFor, signOktaAssertion } from '../src/identity/okta';
import { serializeBody } from '../src/signing';

const FIXTURE_DIR = join(__dirname, 'fixtures', 'identity-v2');

interface PositiveFixture {
  method: string;
  path: string;
  api_key: string;
  body_base64: string;
  body_sha256: string;
  header: { kid: string; alg: string; typ: string };
  claims: Record<string, unknown>;
  assertion: string;
}

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as T;
}

const FIXTURE_PEM = createPrivateKey({
  key: readFixture<{ private_jwk: JsonWebKey }>('keypair.json').private_jwk,
  format: 'jwk',
})
  .export({ type: 'pkcs8', format: 'pem' })
  .toString();

function identityFromFixture(fixture: PositiveFixture): OktaAgentIdentity {
  return OktaAgentIdentity.fromConfig({
    method: 'okta_ai_agent',
    openboxAgentId: fixture.claims.obx_agent_id as string,
    organizationId: fixture.claims.obx_organization_id as string,
    deploymentId: fixture.claims.obx_deployment_id as string,
    externalAgentId: fixture.claims.iss as string,
    keyId: fixture.header.kid,
    algorithm: 'RS256',
    privateKey: FIXTURE_PEM,
    audience: fixture.claims.aud as string,
  });
}

const overridesOf = (fixture: PositiveFixture) => ({
  jti: fixture.claims.jti as string,
  iat: fixture.claims.iat as number,
  exp: fixture.claims.exp as number,
});

describe('Okta v2 assertion — golden fixture parity', () => {
  // The routes this SDK calls. (handoff and transition-proof are not.)
  it.each([
    { file: 'evaluate.json', hasBody: true },
    { file: 'approval.json', hasBody: true },
    { file: 'auth-validate.json', hasBody: false },
  ])('mints an assertion byte-identical to $file', ({ file, hasBody }) => {
    const fixture = readFixture<PositiveFixture>(file);
    const payload = hasBody
      ? JSON.parse(Buffer.from(fixture.body_base64, 'base64').toString('utf8'))
      : null;

    // Our serializer reproduces Core's body bytes, so the signed hash is the sent hash.
    const body = serializeBody(payload);
    expect(createHash('sha256').update(body).digest('hex')).toBe(fixture.body_sha256);

    const assertion = oktaAssertionFor(
      identityFromFixture(fixture),
      fixture.method,
      fixture.path,
      body,
      fixture.api_key,
      overridesOf(fixture),
    );
    expect(assertion).toBe(fixture.assertion);
  });

  it('binds the method, path, API key and body — any change gives a different assertion', () => {
    const fixture = readFixture<PositiveFixture>('evaluate.json');
    const identity = identityFromFixture(fixture);
    const sign = (method: string, path: string, bodySha: string, apiKey: string) =>
      signOktaAssertion(identity, method, path, bodySha, apiKey, null, overridesOf(fixture));
    const golden = sign(fixture.method, fixture.path, fixture.body_sha256, fixture.api_key);
    expect(golden).toBe(fixture.assertion);
    expect(sign('GET', fixture.path, fixture.body_sha256, fixture.api_key)).not.toBe(golden);
    expect(
      sign(fixture.method, '/api/v1/governance/evaluate', fixture.body_sha256, fixture.api_key),
    ).not.toBe(golden);
    expect(sign(fixture.method, fixture.path, fixture.body_sha256, 'obx_other')).not.toBe(golden);
    expect(sign(fixture.method, fixture.path, '0'.repeat(64), fixture.api_key)).not.toBe(golden);
  });

  it('never exposes the private key through inspection or JSON', () => {
    const identity = identityFromFixture(readFixture<PositiveFixture>('evaluate.json'));
    expect(JSON.stringify(identity)).not.toContain('PRIVATE KEY');
    expect(inspect(identity, { depth: 5 })).not.toContain('PRIVATE KEY');
  });
});
