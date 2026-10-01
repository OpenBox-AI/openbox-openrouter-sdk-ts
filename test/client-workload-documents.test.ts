/**
 * Strict IAM v3 document parsing: Core's active bootstrap, Core's candidate
 * bootstrap, and Keycloak's token response. Every malformed input fails closed
 * with a sanitized `OpenBoxWorkloadAuthError` before any exchange or request.
 */
import { describe, expect, it } from 'vitest';

import {
  parseWorkloadBootstrapDocument,
  parseWorkloadTokenResponse,
} from '../src/identity/workload-documents';
import { GovernanceAuthError as OpenBoxAuthError } from '../src/errors';
import { OpenBoxWorkloadAuthError } from '../src/errors';
import {
  ACTIVATION_VERSION,
  CLIENT_ID,
  ISSUER,
  SERVICE_ACCOUNT_ID,
  TOKEN_ENDPOINT,
  WORKLOAD_KID,
  workloadBootstrapBody,
} from './support/workload-identity-fakes';

function expectBootstrapRejected(raw: unknown, pattern?: RegExp): void {
  let error: unknown;
  try {
    parseWorkloadBootstrapDocument(raw);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(OpenBoxWorkloadAuthError);
  expect(error).toBeInstanceOf(OpenBoxAuthError);
  expect((error as OpenBoxWorkloadAuthError).stage).toBe('bootstrap');
  if (pattern) expect((error as Error).message).toMatch(pattern);
}

describe("parseWorkloadBootstrapDocument — accepts Core's document", () => {
  it('parses the canonical document into an immutable camelCase snapshot', () => {
    const document = parseWorkloadBootstrapDocument(workloadBootstrapBody());
    expect(document).toEqual({
      bootstrapVersion: 3,
      contractVersion: 3,
      tokenEndpoint: TOKEN_ENDPOINT,
      issuer: ISSUER,
      audience: 'openbox-core',
      clientId: CLIENT_ID,
      serviceAccountId: SERVICE_ACCOUNT_ID,
      activationVersion: ACTIVATION_VERSION,
      identitySource: 'openbox',
      kid: WORKLOAD_KID,
    });
    expect(Object.isFrozen(document)).toBe(true);
  });

  it.each(['openbox', 'okta', 'entra'])('accepts identity source %s as metadata', (source) => {
    expect(
      parseWorkloadBootstrapDocument(workloadBootstrapBody({ identity_source: source }))
        .identitySource,
    ).toBe(source);
  });

  it('normalizes canonical UUIDs to lowercase', () => {
    const document = parseWorkloadBootstrapDocument(
      workloadBootstrapBody({ service_account_id: SERVICE_ACCOUNT_ID.toUpperCase() }),
    );
    expect(document.serviceAccountId).toBe(SERVICE_ACCOUNT_ID);
  });

  it('allows exact loopback HTTP and an issuer with one trailing slash', () => {
    for (const host of ['localhost:8080', '127.0.0.1:8080', '[::1]:8080']) {
      const issuer = `http://${host}/realms/openbox`;
      expect(() =>
        parseWorkloadBootstrapDocument(
          workloadBootstrapBody({
            issuer,
            token_endpoint: `${issuer}/protocol/openid-connect/token`,
          }),
        ),
      ).not.toThrow();
    }
    expect(() =>
      parseWorkloadBootstrapDocument(
        workloadBootstrapBody({ issuer: `${ISSUER}/`, token_endpoint: TOKEN_ENDPOINT }),
      ),
    ).not.toThrow();
  });

  it('allows Core and Keycloak on different origins', () => {
    // The required relationship is issuer ↔ token endpoint, not Core ↔ Keycloak.
    const issuer = 'https://auth.other-origin.example/realms/tenant-a';
    expect(() =>
      parseWorkloadBootstrapDocument(
        workloadBootstrapBody({
          issuer,
          token_endpoint: `${issuer}/protocol/openid-connect/token`,
        }),
      ),
    ).not.toThrow();
  });
});

describe('parseWorkloadBootstrapDocument — fails closed', () => {
  it.each([null, [], 'document', 3, [workloadBootstrapBody()]])(
    'rejects a non-object body %#',
    (raw) => {
      expectBootstrapRejected(raw, /expected a JSON object/);
    },
  );

  it.each([
    ['bootstrap_version', 1],
    ['bootstrap_version', 2],
    ['bootstrap_version', '3'],
    ['bootstrap_version', undefined],
    ['contract_version', 2],
    ['contract_version', '3'],
    ['contract_version', undefined],
  ])('rejects %s = %j', (key, value) => {
    expectBootstrapRejected(
      workloadBootstrapBody({ [key]: value }),
      /Unsupported workload bootstrap/,
    );
  });

  it.each(['token_endpoint', 'issuer', 'audience', 'client_id', 'kid'])(
    'rejects a missing, empty, blank, or non-string %s',
    (key) => {
      for (const value of [undefined, '', '   ', 42, null]) {
        expectBootstrapRejected(workloadBootstrapBody({ [key]: value }));
      }
    },
  );

  it.each(['service_account_id', 'activation_version'])(
    'rejects a non-canonical or nil %s',
    (key) => {
      for (const value of [
        undefined,
        'not-a-uuid',
        '00000000-0000-0000-0000-000000000000',
        `{${SERVICE_ACCOUNT_ID}}`,
        SERVICE_ACCOUNT_ID.replace(/-/g, ''),
        42,
      ]) {
        expectBootstrapRejected(workloadBootstrapBody({ [key]: value }), /canonical, non-nil UUID/);
      }
    },
  );

  it.each(['OKTA', 'google', '', undefined, 1])('rejects identity source %j', (source) => {
    expectBootstrapRejected(workloadBootstrapBody({ identity_source: source }), /identity_source/);
  });

  it.each([
    ['plain HTTP on a public host', 'http://identity.example.com/realms/openbox'],
    ['a hostname merely containing localhost', 'http://localhost.evil.example/realms/openbox'],
    ['user information', 'https://user:pass@identity.example.com/realms/openbox'],
    ['a query', 'https://identity.example.com/realms/openbox?x=1'],
    ['an empty query', 'https://identity.example.com/realms/openbox?'],
    ['a fragment', 'https://identity.example.com/realms/openbox#frag'],
    ['whitespace', ' https://identity.example.com/realms/openbox'],
    ['a backslash', 'https://identity.example.com\\@evil.example/realms/openbox'],
    ['a relative URL', '/realms/openbox'],
    ['a non-HTTP scheme', 'ftp://identity.example.com/realms/openbox'],
  ])('rejects an issuer with %s', (_label, issuer) => {
    expectBootstrapRejected(
      workloadBootstrapBody({ issuer, token_endpoint: `${issuer}/protocol/openid-connect/token` }),
      /absolute HTTPS URL|does not belong/,
    );
  });

  it.each([
    ['another host', 'https://evil.example/realms/openbox/protocol/openid-connect/token'],
    ['another realm', 'https://identity.example.com/realms/other/protocol/openid-connect/token'],
    [
      'a doubled slash',
      'https://identity.example.com/realms/openbox//protocol/openid-connect/token',
    ],
    ['a different path', 'https://identity.example.com/realms/openbox/token'],
    ['a trailing slash', `${TOKEN_ENDPOINT}/`],
  ])('rejects a token endpoint on %s', (_label, token_endpoint) => {
    expectBootstrapRejected(
      workloadBootstrapBody({ token_endpoint }),
      /does not belong to the advertised issuer/,
    );
  });

  it('never echoes the document in the error', () => {
    let message = '';
    try {
      parseWorkloadBootstrapDocument(
        workloadBootstrapBody({ identity_source: 'secret-looking-value' }),
      );
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain('secret-looking-value');
  });
});

describe('parseWorkloadTokenResponse', () => {
  it('accepts a Bearer token (case-insensitive) and caps the cache at 300 s', () => {
    expect(
      parseWorkloadTokenResponse({ access_token: 'a.b.c', token_type: 'bearer', expires_in: 3600 }),
    ).toEqual({
      accessToken: 'a.b.c',
      cacheSeconds: 300,
    });
    expect(
      parseWorkloadTokenResponse({ access_token: 't', token_type: 'BEARER', expires_in: 31 })
        .cacheSeconds,
    ).toBe(31);
  });

  it.each([
    ['no access_token', { token_type: 'Bearer', expires_in: 300 }],
    ['an empty access_token', { access_token: '', token_type: 'Bearer', expires_in: 300 }],
    ['a non-string access_token', { access_token: 1, token_type: 'Bearer', expires_in: 300 }],
    [
      'an access_token with whitespace',
      { access_token: 'a b', token_type: 'Bearer', expires_in: 300 },
    ],
    [
      'an access_token with a newline',
      { access_token: 'a\nb', token_type: 'Bearer', expires_in: 300 },
    ],
    ['a non-Bearer token_type', { access_token: 't', token_type: 'mac', expires_in: 300 }],
    ['no token_type', { access_token: 't', expires_in: 300 }],
    ['a string expires_in', { access_token: 't', token_type: 'Bearer', expires_in: '300' }],
    ['a boolean expires_in', { access_token: 't', token_type: 'Bearer', expires_in: true }],
    [
      'a non-finite expires_in',
      { access_token: 't', token_type: 'Bearer', expires_in: Number.POSITIVE_INFINITY },
    ],
    ['a NaN expires_in', { access_token: 't', token_type: 'Bearer', expires_in: Number.NaN }],
    [
      'expires_in at the refresh margin',
      { access_token: 't', token_type: 'Bearer', expires_in: 30 },
    ],
    ['a negative expires_in', { access_token: 't', token_type: 'Bearer', expires_in: -1 }],
    ['an array body', [{ access_token: 't', token_type: 'Bearer', expires_in: 300 }]],
    ['a null body', null],
  ])('rejects %s', (_label, raw) => {
    let error: unknown;
    try {
      parseWorkloadTokenResponse(raw);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(OpenBoxWorkloadAuthError);
    expect((error as OpenBoxWorkloadAuthError).stage).toBe('token');
  });
});
