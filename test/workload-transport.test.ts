/**
 * IAM v3 workload identity through the transport the SDK actually uses.
 *
 * A scripted Core v3 + Keycloak double stands in for the network (global
 * `fetch` is stubbed), so these tests are about OUR contract: which identity
 * is selected, which routes and headers go on the wire, how the token is
 * reused and renewed, and that no workload failure ever degrades to an
 * ungoverned or v1 request.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GovernanceClient } from '../src/client';
import {
  GovernanceAuthError,
  GovernanceContractError,
  OpenBoxIdentityConfigError,
  OpenBoxWorkloadAuthError,
} from '../src/errors';
import { FetchTransport, resolveCredentials } from '../src/transport';
import {
  API_KEY,
  CORE_URL,
  OTHER_WORKLOAD_PEM,
  UNDERSIZED_PEM,
  WORKLOAD_PEM,
  WorkloadFakeEndpoints,
  jsonResponse,
  tokenBody,
} from './support/workload-identity-fakes';

const IDENTITY_VARS = [
  'OPENBOX_API_KEY',
  'OPENBOX_API_URL',
  'OPENBOX_URL',
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

let savedEnv: Record<string, string | undefined>;
let endpoints: WorkloadFakeEndpoints;

beforeEach(() => {
  savedEnv = Object.fromEntries(IDENTITY_VARS.map((v) => [v, process.env[v]]));
  for (const v of IDENTITY_VARS) delete process.env[v];
  endpoints = new WorkloadFakeEndpoints();
  vi.stubGlobal('fetch', endpoints.fetchImpl);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const v of IDENTITY_VARS) {
    if (savedEnv[v] === undefined) delete process.env[v];
    else process.env[v] = savedEnv[v];
  }
});

function workloadTransport(): FetchTransport {
  return new FetchTransport(
    resolveCredentials({ openboxUrl: CORE_URL, apiKey: API_KEY, workloadPrivateKey: WORKLOAD_PEM }),
  );
}

const evaluate = (t: FetchTransport) =>
  t.request({
    method: 'POST',
    path: '/api/v1/governance/evaluate',
    body: { event_type: 'ActivityStarted' },
  });

describe('identity selection', () => {
  it('selects keycloak_workload from OPENBOX_WORKLOAD_PRIVATE_KEY alone', () => {
    process.env.OPENBOX_API_KEY = API_KEY;
    process.env.OPENBOX_API_URL = CORE_URL;
    process.env.OPENBOX_WORKLOAD_PRIVATE_KEY = WORKLOAD_PEM;
    const creds = resolveCredentials();
    expect(creds.resolvedIdentityMethod).toBe('keycloak_workload');
    expect(creds.workloadPrivateKey).toBe(WORKLOAD_PEM);
    expect(creds.agentDid).toBeUndefined();
  });

  it('keeps DID mode and unsigned mode as they were', () => {
    expect(resolveCredentials({ apiKey: API_KEY }).resolvedIdentityMethod).toBe('legacy_unsigned');
    expect(
      resolveCredentials({ apiKey: API_KEY, agentDid: 'did:aip:x', agentPrivateKey: 'k' })
        .resolvedIdentityMethod,
    ).toBe('openbox_did');
  });

  it('rejects a workload key combined with DID settings, naming them', () => {
    expect(() =>
      resolveCredentials({
        apiKey: API_KEY,
        openboxUrl: CORE_URL,
        workloadPrivateKey: WORKLOAD_PEM,
        agentDid: 'did:aip:x',
      }),
    ).toThrow(/cannot be combined with: agentDid/);
  });

  it('rejects leftover Okta metadata in workload mode', () => {
    process.env.OPENBOX_AGENT_ID = '00000000-0000-4000-8000-000000000001';
    expect(() =>
      resolveCredentials({
        apiKey: API_KEY,
        openboxUrl: CORE_URL,
        workloadPrivateKey: WORKLOAD_PEM,
      }),
    ).toThrow(/agentId \(OPENBOX_AGENT_ID\)/);
  });

  it('fails locally when keycloak_workload is selected without a key', () => {
    expect(() =>
      resolveCredentials({
        apiKey: API_KEY,
        openboxUrl: CORE_URL,
        identityMethod: 'keycloak_workload',
      }),
    ).toThrow(OpenBoxIdentityConfigError);
  });

  it('accepts the Okta key as the workload key only with an explicit keycloak_workload', () => {
    process.env.OPENBOX_OKTA_AGENT_PRIVATE_KEY = WORKLOAD_PEM;
    const creds = resolveCredentials({
      apiKey: API_KEY,
      openboxUrl: CORE_URL,
      identityMethod: 'keycloak_workload',
    });
    expect(creds.workloadPrivateKey).toBe(WORKLOAD_PEM);
  });

  it('rejects both the workload key and its Okta alias', () => {
    process.env.OPENBOX_OKTA_AGENT_PRIVATE_KEY = OTHER_WORKLOAD_PEM;
    expect(() =>
      resolveCredentials({
        apiKey: API_KEY,
        openboxUrl: CORE_URL,
        workloadPrivateKey: WORKLOAD_PEM,
      }),
    ).toThrow(/Configure exactly one workload private key/);
  });

  it('rejects an unknown identity method', () => {
    process.env.OPENBOX_AGENT_IDENTITY_METHOD = 'magic';
    expect(() => resolveCredentials({ apiKey: API_KEY })).toThrow(/must be one of/);
  });

  it('refuses plain HTTP to a non-loopback Core in workload mode', () => {
    expect(() =>
      resolveCredentials({
        apiKey: API_KEY,
        openboxUrl: 'http://core.example.com',
        workloadPrivateKey: WORKLOAD_PEM,
      }),
    ).toThrow(/Insecure HTTP URL/);
    expect(() =>
      resolveCredentials({
        apiKey: API_KEY,
        openboxUrl: 'http://localhost:8086',
        workloadPrivateKey: WORKLOAD_PEM,
      }),
    ).not.toThrow();
  });

  it('rejects an undersized key at construction, before any request', () => {
    expect(
      () =>
        new FetchTransport(
          resolveCredentials({
            apiKey: API_KEY,
            openboxUrl: CORE_URL,
            workloadPrivateKey: UNDERSIZED_PEM,
          }),
        ),
    ).toThrow(/at least 2048 bits/);
    expect(endpoints.calls).toHaveLength(0);
  });
});

describe('v3 requests', () => {
  it('bootstraps, exchanges a token, and sends only to /api/v3 with the workload token', async () => {
    const t = workloadTransport();
    await expect(evaluate(t)).resolves.toEqual({ verdict: 'allow' });

    expect(endpoints.calls.map((c) => c.path)).toEqual([
      '/api/v3/auth/bootstrap',
      '/realms/openbox/protocol/openid-connect/token',
      '/api/v3/governance/evaluate',
    ]);
    expect(endpoints.legacyCalls).toHaveLength(0);

    const [runtime] = endpoints.runtimeCalls;
    expect(runtime.headers['authorization']).toBe(`Bearer ${API_KEY}`);
    expect(runtime.headers['x-openbox-workload-token']).toBe('access-token-1');
    expect(Object.keys(runtime.headers).filter((h) => h.startsWith('x-openbox-agent-'))).toEqual(
      [],
    );
    expect(runtime.redirect).toBe('manual');
  });

  it('sends Keycloak exactly the four client-credentials fields and never the API key', async () => {
    await evaluate(workloadTransport());
    const [token] = endpoints.tokenCalls;
    const form = new URLSearchParams(token.body);
    expect([...form.keys()].sort()).toEqual([
      'client_assertion',
      'client_assertion_type',
      'client_id',
      'grant_type',
    ]);
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(token.headers['authorization']).toBeUndefined();
    expect(token.body).not.toContain(API_KEY);
    expect(token.redirect).toBe('manual');
  });

  it('maps every runtime route to v3 and refuses one it has no v3 route for', async () => {
    const t = workloadTransport();
    await t.request({ method: 'POST', path: '/api/v1/governance/approval', body: {} });
    await t.request({ method: 'GET', path: '/api/v1/auth/validate' });
    expect(endpoints.runtimeCalls.map((c) => c.path)).toEqual([
      '/api/v3/governance/approval',
      '/api/v3/auth/validate',
    ]);
    const before = endpoints.calls.length;
    await expect(
      t.request({ method: 'POST', path: '/api/v1/handoffs', body: {} }),
    ).rejects.toBeInstanceOf(GovernanceContractError);
    expect(endpoints.calls).toHaveLength(before);
  });

  it('reuses one token, and concurrent first requests share one acquisition', async () => {
    const t = workloadTransport();
    await Promise.all([evaluate(t), evaluate(t), evaluate(t)]);
    await evaluate(t);
    expect(endpoints.bootstrapCalls).toHaveLength(1);
    expect(endpoints.tokenCalls).toHaveLength(1);
    expect(endpoints.runtimeCalls.map((c) => c.headers['x-openbox-workload-token'])).toEqual(
      Array(4).fill('access-token-1'),
    );
  });

  it('renews a refresh-due token, re-fetching bootstrap first', async () => {
    // expires_in 31 leaves one usable second before the 30 s refresh margin.
    endpoints.token = () =>
      jsonResponse(
        200,
        tokenBody({ access_token: `tok-${endpoints.tokenCalls.length}`, expires_in: 31 }),
      );
    const t = workloadTransport();
    await evaluate(t);
    await new Promise((r) => setTimeout(r, 1_100));
    await evaluate(t);
    expect(endpoints.bootstrapCalls).toHaveLength(2);
    expect(endpoints.runtimeCalls.map((c) => c.headers['x-openbox-workload-token'])).toEqual([
      'tok-1',
      'tok-2',
    ]);
  });

  it('discards the token on a runtime 401, does not replay, and bootstraps again next time', async () => {
    let first = true;
    endpoints.evaluate = () => {
      if (first) {
        first = false;
        return jsonResponse(401, { reason_code: 'invalid_workload_token' });
      }
      return jsonResponse(200, { verdict: 'allow' });
    };
    const t = workloadTransport();
    const err = await evaluate(t).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenBoxWorkloadAuthError);
    expect(err).toBeInstanceOf(GovernanceAuthError);
    expect((err as OpenBoxWorkloadAuthError).stage).toBe('runtime');
    expect((err as OpenBoxWorkloadAuthError).reasonCode).toBe('invalid_workload_token');
    expect(endpoints.runtimeCalls).toHaveLength(1);

    await evaluate(t);
    expect(endpoints.bootstrapCalls).toHaveLength(2);
    expect(endpoints.runtimeCalls.map((c) => c.headers['x-openbox-workload-token'])).toEqual([
      'access-token-1',
      'access-token-2',
    ]);
  });

  it('never leaks the token or the API key into an error message', async () => {
    endpoints.evaluate = () => jsonResponse(401, {});
    const err = (await evaluate(workloadTransport()).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain('access-token-1');
    expect(err.message).not.toContain(API_KEY);
  });
});

describe('no workload failure fails open', () => {
  const client = (t: FetchTransport) => new GovernanceClient(t, 'trace');

  it.each([
    [
      'bootstrap 404 (Core without v3)',
      () => (endpoints.bootstrap = () => jsonResponse(404, { code: 404 })),
      'bootstrap',
    ],
    [
      'bootstrap 409 workload_identity_unavailable',
      () =>
        (endpoints.bootstrap = () =>
          jsonResponse(409, { reason_code: 'workload_identity_unavailable' })),
      'bootstrap',
    ],
    [
      'Core unreachable for bootstrap',
      () => (endpoints.bootstrap = () => Promise.reject(new TypeError('fetch failed'))),
      'bootstrap',
    ],
    [
      'Keycloak rejects the assertion',
      () => (endpoints.token = () => jsonResponse(401, { error: 'invalid_client' })),
      'token',
    ],
    [
      'Keycloak unreachable',
      () => (endpoints.token = () => Promise.reject(new TypeError('fetch failed'))),
      'token',
    ],
  ])('%s throws under fail_open and sends no governed request', async (_name, arrange, stage) => {
    arrange();
    const err = await client(workloadTransport())
      .evaluateEvent({ event_type: 'ActivityStarted' } as never, 'fail_open')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenBoxWorkloadAuthError);
    expect((err as OpenBoxWorkloadAuthError).stage).toBe(stage);
    expect(endpoints.runtimeCalls).toHaveLength(0);
    expect(endpoints.legacyCalls).toHaveLength(0);
  });

  it('a v3 non-retryable 4xx is a contract error even under fail_open', async () => {
    endpoints.evaluate = () => jsonResponse(400, { reason_code: 'invalid_payload' });
    await expect(
      client(workloadTransport()).evaluateEvent(
        { event_type: 'ActivityStarted' } as never,
        'fail_open',
      ),
    ).rejects.toBeInstanceOf(GovernanceContractError);
  });

  it('a v3 redirect is a contract error even under fail_open', async () => {
    endpoints.evaluate = () =>
      new Response(null, { status: 302, headers: { location: 'https://elsewhere.example' } });
    await expect(
      client(workloadTransport()).evaluateEvent(
        { event_type: 'ActivityStarted' } as never,
        'fail_open',
      ),
    ).rejects.toBeInstanceOf(GovernanceContractError);
  });

  it('a 5xx after successful authentication is still an outage that onApiError governs', async () => {
    endpoints.evaluate = () => jsonResponse(503, {});
    await expect(
      client(workloadTransport()).evaluateEvent(
        { event_type: 'ActivityStarted' } as never,
        'fail_open',
      ),
    ).resolves.toBeNull();
  });
});

describe('close()', () => {
  it('refuses later requests', async () => {
    const t = workloadTransport();
    await evaluate(t);
    t.close();
    await expect(evaluate(t)).rejects.toThrow(/closed/);
  });
});
