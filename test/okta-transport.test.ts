/**
 * Okta v2 (`okta_ai_agent`) identity through the transport the SDK uses.
 *
 * A scripted Core v2 stands in for the network (global `fetch` is stubbed).
 * Covers: selection, bootstrap from Core, the thumbprint check that runs
 * before anything is signed, v2-only routes and headers, and that no
 * bootstrap or assertion failure ever degrades to an unsigned or v1 request.
 */

import { createPrivateKey, createPublicKey, verify as cryptoVerify } from 'crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GovernanceClient } from '../src/client';
import {
  GovernanceAuthError,
  OpenBoxAssertionError,
  OpenBoxIdentityBootstrapError,
  OpenBoxIdentityConfigError,
} from '../src/errors';
import { jwkThumbprintSha256 } from '../src/identity/jwk-thumbprint';
import { FetchTransport, resolveCredentials } from '../src/transport';
import { OTHER_WORKLOAD_PEM, WORKLOAD_PEM, jsonResponse } from './support/workload-identity-fakes';

const CORE_URL = 'https://core.example.com';
const API_KEY = 'obx_test_oktaapikey';
const OKTA_PEM = WORKLOAD_PEM; // the fixture RSA-2048 key
const THUMBPRINT = jwkThumbprintSha256(createPrivateKey(OKTA_PEM));

const IDENTITY_VARS = [
  'OPENBOX_API_KEY',
  'OPENBOX_API_URL',
  'OPENBOX_AGENT_IDENTITY_METHOD',
  'OPENBOX_WORKLOAD_PRIVATE_KEY',
  'OPENBOX_AGENT_DID',
  'OPENBOX_AGENT_PRIVATE_KEY',
  'OPENBOX_OKTA_AGENT_ID',
  'OPENBOX_OKTA_AGENT_KEY_ID',
  'OPENBOX_OKTA_AGENT_PRIVATE_KEY',
  'OPENBOX_OKTA_AGENT_ALGORITHM',
  'OPENBOX_AGENT_ID',
  'OPENBOX_ORGANIZATION_ID',
  'OPENBOX_DEPLOYMENT_ID',
  'OPENBOX_AGENT_PROOF_AUDIENCE',
];

function bootstrapBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bootstrap_version: 1,
    identity_method: 'okta_ai_agent',
    openbox_agent_id: 'agent-1',
    organization_id: 'org-1',
    deployment_id: 'deploy-1',
    assertion_audience: 'https://core.example.com/agent-proof',
    authority: {
      assignment_id: '11111111-1111-4111-8111-111111111111',
      provider_generation_id: '22222222-2222-4222-8222-222222222222',
      generation_number: 1,
      activation_version: '33333333-3333-4333-8333-333333333333',
      identity_id: '44444444-4444-4444-8444-444444444444',
      credential_id: '55555555-5555-4555-8555-555555555555',
      projection_version: 'p1',
    },
    okta: {
      external_agent_id: 'okta-agent-1',
      credential_kid: 'kid-1',
      algorithm: 'RS256',
      public_jwk_thumbprint: THUMBPRINT,
    },
    ...overrides,
  };
}

interface Call {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

let calls: Call[];
let bootstrap: () => Response | Promise<Response>;
let evaluateReply: () => Response;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(IDENTITY_VARS.map((v) => [v, process.env[v]]));
  for (const v of IDENTITY_VARS) delete process.env[v];
  calls = [];
  bootstrap = () => jsonResponse(200, bootstrapBody());
  evaluateReply = () => jsonResponse(200, { verdict: 'allow' });
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const body =
      init.body instanceof Uint8Array
        ? Buffer.from(init.body).toString('utf8')
        : String(init.body ?? '');
    const path = new URL(input).pathname;
    calls.push({ path, method: init.method ?? 'GET', headers, body });
    if (path === '/api/v2/auth/bootstrap') return bootstrap();
    if (path.endsWith('/governance/evaluate')) return evaluateReply();
    if (path.endsWith('/governance/approval')) return jsonResponse(200, { action: 'allow' });
    if (path.endsWith('/auth/validate')) return jsonResponse(200, { valid: true });
    return jsonResponse(404, {});
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const v of IDENTITY_VARS) {
    if (savedEnv[v] === undefined) delete process.env[v];
    else process.env[v] = savedEnv[v];
  }
});

const oktaTransport = () =>
  new FetchTransport(
    resolveCredentials({ openboxUrl: CORE_URL, apiKey: API_KEY, oktaAgentPrivateKey: OKTA_PEM }),
  );
const evaluate = (t: FetchTransport) =>
  t.request({
    method: 'POST',
    path: '/api/v1/governance/evaluate',
    body: { event_type: 'ActivityStarted' },
  });
const governed = () => calls.filter((c) => /\/governance\/|\/auth\/validate/.test(c.path));

function decode(jwt: string) {
  const [h, p, sig] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString()),
    claims: JSON.parse(Buffer.from(p, 'base64url').toString()),
    signingInput: `${h}.${p}`,
    signature: Buffer.from(sig, 'base64url'),
  };
}

describe('selection', () => {
  it('selects okta_ai_agent from OPENBOX_OKTA_AGENT_PRIVATE_KEY alone (bootstrap mode)', () => {
    process.env.OPENBOX_API_KEY = API_KEY;
    process.env.OPENBOX_OKTA_AGENT_PRIVATE_KEY = OKTA_PEM;
    const creds = resolveCredentials();
    expect(creds.resolvedIdentityMethod).toBe('okta_ai_agent');
    expect(creds.oktaAgentId).toBeUndefined();
  });

  it('rejects a partial explicit configuration, naming the fields', () => {
    expect(() =>
      resolveCredentials({
        apiKey: API_KEY,
        oktaAgentPrivateKey: OKTA_PEM,
        oktaAgentKeyId: 'stale-kid',
      }),
    ).toThrow(/Configured: oktaAgentKeyId/);
  });

  it('rejects Okta and DID settings together', () => {
    expect(() =>
      resolveCredentials({
        apiKey: API_KEY,
        oktaAgentPrivateKey: OKTA_PEM,
        agentDid: 'did:aip:x',
        agentPrivateKey: 'k',
      }),
    ).toThrow(/mutually exclusive/);
  });

  it('rejects a non-RS256 algorithm', () => {
    expect(() =>
      resolveCredentials({
        apiKey: API_KEY,
        oktaAgentPrivateKey: OKTA_PEM,
        oktaAgentAlgorithm: 'RS512',
      }),
    ).toThrow(/only RS256/);
  });
});

describe('bootstrap mode', () => {
  it('bootstraps with the API key alone, then signs only /api/v2 requests with an assertion', async () => {
    const t = oktaTransport();
    await expect(evaluate(t)).resolves.toEqual({ verdict: 'allow' });

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/v2/auth/bootstrap',
      'POST /api/v2/governance/evaluate',
    ]);
    const [boot, runtime] = calls;
    expect(boot.headers['authorization']).toBe(`Bearer ${API_KEY}`);
    expect(boot.headers['x-openbox-agent-assertion']).toBeUndefined();

    expect(runtime.headers['authorization']).toBe(`Bearer ${API_KEY}`);
    expect(
      Object.keys(runtime.headers).filter((h) =>
        /^x-openbox-(agent-did|agent-timestamp|agent-nonce|agent-signature|body-sha256)$/.test(h),
      ),
    ).toEqual([]);

    const jwt = decode(runtime.headers['x-openbox-agent-assertion']);
    expect(jwt.header).toEqual({ alg: 'RS256', kid: 'kid-1', typ: 'openbox-agent-proof+jwt' });
    expect(jwt.claims).toMatchObject({
      aud: 'https://core.example.com/agent-proof',
      htm: 'POST',
      htu: '/api/v2/governance/evaluate',
      iss: 'okta-agent-1',
      sub: 'okta-agent-1',
      obx_agent_id: 'agent-1',
      obx_organization_id: 'org-1',
      obx_deployment_id: 'deploy-1',
    });
    expect(jwt.claims.exp - jwt.claims.iat).toBe(60);
    const publicKey = createPublicKey(createPrivateKey(OKTA_PEM));
    expect(
      cryptoVerify('RSA-SHA256', Buffer.from(jwt.signingInput), publicKey, jwt.signature),
    ).toBe(true);
  });

  it('bootstraps once for concurrent and later requests, and exposes the document', async () => {
    const t = oktaTransport();
    expect(t.contractVersion).toBe(2);
    await Promise.all([evaluate(t), evaluate(t), evaluate(t)]);
    await t.request({ method: 'POST', path: '/api/v1/governance/approval', body: {} });
    expect(calls.filter((c) => c.path === '/api/v2/auth/bootstrap')).toHaveLength(1);
    expect(governed().map((c) => c.path)).toEqual([
      ...Array(3).fill('/api/v2/governance/evaluate'),
      '/api/v2/governance/approval',
    ]);
    expect(t.identityMetadata()?.okta.credentialKid).toBe('kid-1');
  });

  it('refuses to sign when the local key does not match the selected credential', async () => {
    bootstrap = () =>
      jsonResponse(
        200,
        bootstrapBody({
          okta: {
            ...(bootstrapBody().okta as object),
            public_jwk_thumbprint: jwkThumbprintSha256(createPrivateKey(OTHER_WORKLOAD_PEM)),
          },
        }),
      );
    await expect(evaluate(oktaTransport())).rejects.toThrow(
      /does not match the selected Okta credential/,
    );
    expect(governed()).toHaveLength(0);
  });

  it('refreshIdentityMetadata() bootstraps again', async () => {
    const t = oktaTransport();
    await evaluate(t);
    bootstrap = () =>
      jsonResponse(
        200,
        bootstrapBody({ okta: { ...(bootstrapBody().okta as object), credential_kid: 'kid-2' } }),
      );
    const doc = await t.refreshIdentityMetadata();
    expect(doc.okta.credentialKid).toBe('kid-2');
    await evaluate(t);
    expect(decode(calls.at(-1)!.headers['x-openbox-agent-assertion']).header.kid).toBe('kid-2');
  });
});

describe('no Okta failure fails open', () => {
  const client = (t: FetchTransport) => new GovernanceClient(t, 'trace');

  it.each([
    ['Core without bootstrap (404)', () => jsonResponse(404, {}), OpenBoxIdentityBootstrapError],
    [
      'bootstrap rejected (401 invalid_api_key)',
      () => jsonResponse(401, { reason_code: 'invalid_api_key' }),
      OpenBoxIdentityBootstrapError,
    ],
    [
      'Core unreachable',
      () => Promise.reject(new TypeError('fetch failed')),
      OpenBoxIdentityBootstrapError,
    ],
    [
      'document without authority',
      () => jsonResponse(200, bootstrapBody({ authority: undefined })),
      OpenBoxIdentityConfigError,
    ],
    [
      'agent not on okta_ai_agent',
      () => jsonResponse(200, bootstrapBody({ identity_method: 'openbox_did' })),
      OpenBoxIdentityConfigError,
    ],
  ])('%s throws under fail_open and sends no governed request', async (_name, reply, errorType) => {
    bootstrap = reply as () => Response;
    await expect(
      client(oktaTransport()).evaluateEvent(
        { event_type: 'ActivityStarted' } as never,
        'fail_open',
      ),
    ).rejects.toBeInstanceOf(errorType);
    expect(governed()).toHaveLength(0);
    expect(calls.filter((c) => c.path.startsWith('/api/v1/'))).toHaveLength(0);
  });

  it('a rejected assertion raises an actionable error and is not retried or re-bootstrapped', async () => {
    evaluateReply = () => jsonResponse(401, { reason_code: 'assertion_signature_invalid' });
    const err = await client(oktaTransport())
      .evaluateEvent({ event_type: 'ActivityStarted' } as never, 'fail_open')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenBoxAssertionError);
    expect(err).toBeInstanceOf(GovernanceAuthError);
    expect((err as OpenBoxAssertionError).reasonCode).toBe('assertion_signature_invalid');
    expect((err as Error).message).toMatch(/body-hash mismatch|rotated private key/);
    expect(calls.filter((c) => c.path === '/api/v2/auth/bootstrap')).toHaveLength(1);
    expect(governed()).toHaveLength(1);
  });
});

describe('explicit configuration', () => {
  it('signs with the configured metadata and never calls bootstrap', async () => {
    const t = new FetchTransport(
      resolveCredentials({
        openboxUrl: CORE_URL,
        apiKey: API_KEY,
        oktaAgentPrivateKey: OKTA_PEM,
        oktaAgentId: 'okta-explicit',
        oktaAgentKeyId: 'kid-explicit',
        oktaAgentAlgorithm: 'RS256',
        agentId: 'agent-explicit',
        organizationId: 'org-explicit',
        deploymentId: 'deploy-explicit',
        agentProofAudience: 'aud-explicit',
      }),
    );
    await evaluate(t);
    expect(calls.map((c) => c.path)).toEqual(['/api/v2/governance/evaluate']);
    const jwt = decode(calls[0].headers['x-openbox-agent-assertion']);
    expect(jwt.header.kid).toBe('kid-explicit');
    expect(jwt.claims).toMatchObject({
      iss: 'okta-explicit',
      aud: 'aud-explicit',
      obx_agent_id: 'agent-explicit',
    });
  });
});
