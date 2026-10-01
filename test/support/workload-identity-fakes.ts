/**
 * Test support for IAM v3 workload identity: fixture keys, Core/Keycloak
 * wire bodies, and a scriptable fetch double that answers Core's v3 routes and
 * a Keycloak token endpoint while capturing every request.
 *
 * Non-production keys only. No network.
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import type { JsonWebKey, KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { vi } from 'vitest';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'identity-v2');

interface FixtureKeypair {
  private_jwk: JsonWebKey;
  undersized_key_for_negative_test: { private_jwk: JsonWebKey };
}

function fixtureKeypair(): FixtureKeypair {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, 'keypair.json'), 'utf8')) as FixtureKeypair;
}

function pemOf(jwk: JsonWebKey): string {
  return createPrivateKey({ key: jwk, format: 'jwk' })
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();
}

function generatedRsaPem(): string {
  return generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
}

/** Deterministic, non-production 2048-bit RSA key shared with the v2 golden fixtures. */
export const WORKLOAD_PEM = pemOf(fixtureKeypair().private_jwk);
/** A 1024-bit RSA key that must be rejected locally. */
export const UNDERSIZED_PEM = pemOf(fixtureKeypair().undersized_key_for_negative_test.private_jwk);
/** Distinct keys for isolation, wrong-key, and candidate scenarios. */
export const OTHER_WORKLOAD_PEM = generatedRsaPem();
export const CANDIDATE_PEM = generatedRsaPem();
export const EC_PEM = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

export function publicKeyOf(pem: string): KeyObject {
  return createPublicKey(createPrivateKey(pem));
}

export const CORE_URL = 'https://core.example.com';
export const API_KEY = 'obx_test_workloadapikey';
export const OTHER_API_KEY = 'obx_test_otherworkloadkey';
export const ISSUER = 'https://identity.example.com/realms/openbox';
export const TOKEN_ENDPOINT = `${ISSUER}/protocol/openid-connect/token`;
export const CLIENT_ID = 'example-workload-client';
export const WORKLOAD_KID = 'example-workload-key';
export const SERVICE_ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
export const ACTIVATION_VERSION = '22222222-2222-4222-8222-222222222222';
export const NEXT_ACTIVATION_VERSION = '33333333-3333-4333-8333-333333333333';
export const TRANSITION_ID = '44444444-4444-4444-8444-444444444444';

export function workloadBootstrapBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    bootstrap_version: 3,
    contract_version: 3,
    token_endpoint: TOKEN_ENDPOINT,
    issuer: ISSUER,
    audience: 'openbox-core',
    client_id: CLIENT_ID,
    service_account_id: SERVICE_ACCOUNT_ID,
    activation_version: ACTIVATION_VERSION,
    identity_source: 'openbox',
    kid: WORKLOAD_KID,
    ...overrides,
  };
}

export function tokenBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { access_token: 'access-token', token_type: 'Bearer', expires_in: 300, ...overrides };
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export interface CapturedCall {
  readonly url: string;
  readonly path: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly redirect: RequestInit['redirect'];
}

export type Responder = (call: CapturedCall) => Response | Promise<Response>;

function bodyText(body: RequestInit['body']): string {
  if (body === null || body === undefined) return '';
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf-8');
  return '[unsupported body]';
}

/**
 * Scriptable Core v3 + Keycloak double. Each responder may be replaced per
 * test. By default: bootstrap answers the fixture document, every token
 * exchange mints a numbered token (`access-token-1`, `-2`, ...), and runtime
 * routes answer a benign success.
 */
export class WorkloadFakeEndpoints {
  readonly calls: CapturedCall[] = [];
  private tokenCounter = 0;

  bootstrap: Responder = () => jsonResponse(200, workloadBootstrapBody());
  token: Responder = () => {
    this.tokenCounter += 1;
    return jsonResponse(200, tokenBody({ access_token: `access-token-${this.tokenCounter}` }));
  };
  evaluate: Responder = () => jsonResponse(200, { verdict: 'allow' });
  approval: Responder = () => jsonResponse(200, { action: 'allow' });
  validate: Responder = () => jsonResponse(200, { valid: true });
  handoff: Responder = () =>
    jsonResponse(200, { handoff_id: 'h-1', from_agent_id: 'a-1', to_agent_id: 'a-2' });
  transitionBootstrap: Responder = () => jsonResponse(404, { code: 404 });
  transitionProof: Responder = () => jsonResponse(404, { code: 404 });

  /** Signals each request was sent with, in order (aborts are observable like real fetch). */
  readonly signals: Array<AbortSignal | undefined> = [];

  readonly fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: CapturedCall = {
      url,
      path: new URL(url).pathname,
      method: init?.method ?? 'GET',
      headers,
      body: bodyText(init?.body),
      redirect: init?.redirect,
    };
    this.calls.push(call);
    const signal = init?.signal ?? undefined;
    this.signals.push(signal);
    // Like real fetch: an aborted signal rejects the request, even mid-flight.
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const pending = Promise.resolve(this.route(call));
    if (!signal) return pending;
    return new Promise<Response>((resolve, reject) => {
      const onAbort = (): void => {
        reject(abortError(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  };

  private route(call: CapturedCall): Response | Promise<Response> {
    if (
      call.url.startsWith(TOKEN_ENDPOINT) ||
      call.path.endsWith('/protocol/openid-connect/token')
    ) {
      return this.token(call);
    }
    switch (call.path) {
      case '/api/v3/auth/bootstrap':
        return this.bootstrap(call);
      case '/api/v3/auth/workload-transition/bootstrap':
        return this.transitionBootstrap(call);
      case '/api/v3/auth/workload-transition/proof':
        return this.transitionProof(call);
      default:
        if (call.path.endsWith('/governance/evaluate')) return this.evaluate(call);
        if (call.path.endsWith('/governance/approval')) return this.approval(call);
        if (call.path.endsWith('/auth/validate')) return this.validate(call);
        if (call.path.endsWith('/handoffs')) return this.handoff(call);
        return jsonResponse(404, { code: 404 });
    }
  }

  callsTo(path: string): CapturedCall[] {
    return this.calls.filter((call) => call.path === path);
  }

  get bootstrapCalls(): CapturedCall[] {
    return this.callsTo('/api/v3/auth/bootstrap');
  }

  get tokenCalls(): CapturedCall[] {
    return this.calls.filter((call) => call.path.endsWith('/protocol/openid-connect/token'));
  }

  /** Requests to any v1/v2 route — must stay empty for a v3 client. */
  get legacyCalls(): CapturedCall[] {
    return this.calls.filter((call) => /^\/api\/v[12]\//.test(call.path));
  }

  /** v3 governed (runtime) requests. */
  get runtimeCalls(): CapturedCall[] {
    return this.calls.filter((call) =>
      [
        '/api/v3/auth/validate',
        '/api/v3/governance/evaluate',
        '/api/v3/governance/approval',
        '/api/v3/handoffs',
      ].includes(call.path),
    );
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('This operation was aborted', 'AbortError');
}

export interface RecordingLogger {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  /** Every logged message, joined — for secret-absence assertions. */
  all(): string;
}

export function recordingLogger(): RecordingLogger {
  const info = vi.fn();
  const warn = vi.fn();
  const error = vi.fn();
  return {
    info,
    warn,
    error,
    all: () => [...info.mock.calls, ...warn.mock.calls, ...error.mock.calls].flat().join('\n'),
  };
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Decode a compact JWT's header and claims (no verification). */
export function decodeJwt(token: string): {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
} {
  const [header, claims, signature] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(header!, 'base64url').toString('utf-8')) as Record<
      string,
      unknown
    >,
    claims: JSON.parse(Buffer.from(claims!, 'base64url').toString('utf-8')) as Record<
      string,
      unknown
    >,
    signingInput: `${header}.${claims}`,
    signature: Buffer.from(signature!, 'base64url'),
  };
}

/** A controllable monotonic clock backing `performance.now()` for cache-timing tests. */
export function controlledClock(startMs = 1_000_000): { advance(ms: number): void; now(): number } {
  let now = startMs;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  return {
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}
