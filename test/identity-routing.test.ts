/**
 * FetchTransport speaks each agent's own API version through the base SDK:
 * v1 unsigned/DID, v2 Okta (bootstrap), v3 Keycloak workload — and keeps this
 * package's error taxonomy (auth → hard, outage → soft).
 */

import { createHash, generateKeyPairSync } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FetchTransport,
  GovernanceAuthError,
  OPENBOX_INTERNAL_REQUEST,
  SoftGovernanceError,
} from '../src/transport';

const CORE = 'http://localhost:8086';
const API_KEY = 'obx_test_identity_routing';
const ISSUER = 'http://localhost:8080/realms/openbox';
const VERDICT = { verdict: 'allow', reason: 'ok', patch: { new_input: { amount: 5 } } };

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const jwk = publicKey.export({ format: 'jwk' });
const THUMBPRINT = createHash('sha256')
  .update(`{"e":${JSON.stringify(jwk.e)},"kty":"RSA","n":${JSON.stringify(jwk.n)}}`)
  .digest('base64url');

interface Call {
  url: string;
  init: RequestInit & Record<string, unknown>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Stub fetch with a route table; records every call. */
function stubFetch(routes: Record<string, () => Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init as Call['init'] });
    const route = routes[url];
    if (!route) throw new Error(`unexpected request: ${url}`);
    return route();
  });
  return calls;
}

const evaluate = (t: FetchTransport) =>
  t.request<Record<string, unknown>>({
    method: 'POST',
    path: '/api/v1/governance/evaluate',
    body: { event_type: 'ActivityStarted', workflow_id: 'w', run_id: 'r', activity_id: 'a' },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FetchTransport identity routing', () => {
  it('sends an unsigned agent to v1 and returns the raw verdict', async () => {
    const calls = stubFetch({ [`${CORE}/api/v1/governance/evaluate`]: () => json(VERDICT) });
    const t = new FetchTransport({ openboxUrl: CORE, apiKey: API_KEY });

    const raw = await evaluate(t);

    expect(raw.patch).toEqual(VERDICT.patch);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(headers['X-OpenBox-SDK-Version']).toMatch(/^openbox-openrouter-typescript-v\d/);
    expect(calls[0].init[OPENBOX_INTERNAL_REQUEST]).toBe(true);
  });

  it('bootstraps an Okta agent and sends it to v2 with an assertion', async () => {
    const calls = stubFetch({
      [`${CORE}/api/v2/auth/bootstrap`]: () =>
        json({
          bootstrap_version: 1,
          identity_method: 'okta_ai_agent',
          openbox_agent_id: '11111111-1111-4111-8111-111111111111',
          organization_id: '22222222-2222-4222-8222-222222222222',
          deployment_id: 'dep-1',
          assertion_audience: 'urn:openbox:dep-1:core',
          authority: {
            assignment_id: '33333333-3333-4333-8333-333333333333',
            provider_generation_id: '44444444-4444-4444-8444-444444444444',
            generation_number: 1,
            activation_version: '55555555-5555-4555-8555-555555555555',
            identity_id: '66666666-6666-4666-8666-666666666666',
            credential_id: '77777777-7777-4777-8777-777777777777',
            projection_version: 'p1',
          },
          okta: {
            external_agent_id: 'wlp-okta-agent',
            credential_kid: 'kid-1',
            algorithm: 'RS256',
            public_jwk_thumbprint: THUMBPRINT,
          },
        }),
      [`${CORE}/api/v2/governance/evaluate`]: () => json(VERDICT),
    });
    const t = new FetchTransport({ openboxUrl: CORE, apiKey: API_KEY, oktaAgentPrivateKey: PEM });

    await evaluate(t);

    expect(calls.map((c) => c.url)).toEqual([
      `${CORE}/api/v2/auth/bootstrap`,
      `${CORE}/api/v2/governance/evaluate`,
    ]);
    const assertion = (calls[1].init.headers as Record<string, string>)['X-OpenBox-Agent-Assertion'];
    const claims = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString());
    expect(claims).toMatchObject({
      htm: 'POST',
      htu: '/api/v2/governance/evaluate',
      iss: 'wlp-okta-agent',
      aud: 'urn:openbox:dep-1:core',
    });
    expect(calls.every((c) => c.init[OPENBOX_INTERNAL_REQUEST] === true)).toBe(true);
  });

  it('refuses an Okta key that does not match the selected credential', async () => {
    stubFetch({
      [`${CORE}/api/v2/auth/bootstrap`]: () =>
        json({
          bootstrap_version: 1,
          identity_method: 'okta_ai_agent',
          openbox_agent_id: 'a',
          organization_id: 'o',
          deployment_id: 'd',
          assertion_audience: 'aud',
          authority: {
            assignment_id: '33333333-3333-4333-8333-333333333333',
            provider_generation_id: '44444444-4444-4444-8444-444444444444',
            generation_number: 1,
            activation_version: '55555555-5555-4555-8555-555555555555',
            identity_id: '66666666-6666-4666-8666-666666666666',
            credential_id: '77777777-7777-4777-8777-777777777777',
            projection_version: 'p1',
          },
          okta: { external_agent_id: 'x', credential_kid: 'k', algorithm: 'RS256', public_jwk_thumbprint: 'nope' },
        }),
    });
    const t = new FetchTransport({ openboxUrl: CORE, apiKey: API_KEY, oktaAgentPrivateKey: PEM });

    await expect(evaluate(t)).rejects.toBeInstanceOf(GovernanceAuthError);
  });

  describe('Keycloak workload agent', () => {
    const tokenEndpoint = `${ISSUER}/protocol/openid-connect/token`;
    const routes = () => ({
      [`${CORE}/api/v3/auth/bootstrap`]: () =>
        json({
          bootstrap_version: 3,
          contract_version: 3,
          issuer: ISSUER,
          token_endpoint: tokenEndpoint,
          audience: 'openbox-core',
          client_id: 'agent-client',
          kid: 'kid-w',
          service_account_id: '88888888-8888-4888-8888-888888888888',
          activation_version: '99999999-9999-4999-8999-999999999999',
          identity_source: 'openbox',
        }),
      [tokenEndpoint]: () => json({ access_token: 'wl-token', token_type: 'Bearer', expires_in: 300 }),
      [`${CORE}/api/v3/governance/evaluate`]: () => json(VERDICT),
      [`${CORE}/api/v3/governance/approval`]: () => json({ verdict: 'allow' }),
    });

    it('exchanges a token once and sends evaluate and approval to v3', async () => {
      const calls = stubFetch(routes());
      const t = new FetchTransport({ openboxUrl: CORE, apiKey: API_KEY, workloadPrivateKey: PEM });

      await evaluate(t);
      await t.request({
        method: 'POST',
        path: '/api/v1/governance/approval',
        body: { workflow_id: 'w', run_id: 'r', activity_id: 'a' },
      });

      expect(calls.map((c) => c.url)).toEqual([
        `${CORE}/api/v3/auth/bootstrap`,
        tokenEndpoint,
        `${CORE}/api/v3/governance/evaluate`,
        `${CORE}/api/v3/governance/approval`,
      ]);
      const sent = calls[2].init.headers as Record<string, string>;
      expect(sent['X-OpenBox-Workload-Token']).toBe('wl-token');
      expect(sent.Authorization).toBe(`Bearer ${API_KEY}`);
      expect(String(calls[1].init.body)).toContain('client_assertion_type=');
      // The token exchange goes to another host: it must be skipped by the fetch patch too.
      expect(calls.every((c) => c.init[OPENBOX_INTERNAL_REQUEST] === true)).toBe(true);
    });

    it('hard-fails when Keycloak rejects the assertion', async () => {
      stubFetch({ ...routes(), [tokenEndpoint]: () => json({ error: 'invalid_client' }, 401) });
      const t = new FetchTransport({ openboxUrl: CORE, apiKey: API_KEY, workloadPrivateKey: PEM });

      await expect(evaluate(t)).rejects.toBeInstanceOf(GovernanceAuthError);
    });
  });

  it('refuses two identity methods at once', () => {
    expect(
      () =>
        new FetchTransport({
          openboxUrl: CORE,
          apiKey: API_KEY,
          oktaAgentPrivateKey: PEM,
          workloadPrivateKey: PEM,
        }),
    ).toThrow();
  });

  it("returns Core's own fail-closed verdict instead of treating it as an outage", async () => {
    const failClosed = {
      verdict: 'block',
      reason: 'Policy package undefined - fail-closed security policy applied',
      fallback_used: true,
    };
    stubFetch({ [`${CORE}/api/v1/governance/evaluate`]: () => json(failClosed) });
    const t = new FetchTransport({ openboxUrl: CORE, apiKey: API_KEY });

    await expect(evaluate(t)).resolves.toMatchObject({ verdict: 'block', fallback_used: true });
  });

  it('keeps the error taxonomy: 401 is hard, 5xx is soft', async () => {
    let status = 401;
    stubFetch({ [`${CORE}/api/v1/governance/evaluate`]: () => json({ error: 'x' }, status) });
    const t = new FetchTransport({ openboxUrl: CORE, apiKey: API_KEY });

    await expect(evaluate(t)).rejects.toBeInstanceOf(GovernanceAuthError);
    status = 503;
    await expect(evaluate(t)).rejects.toBeInstanceOf(SoftGovernanceError);
  });
});
