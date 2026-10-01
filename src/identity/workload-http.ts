/**
 * Transport and failure classification for SDK-owned IAM v3 authentication
 * requests: workload bootstrap and Keycloak token exchange. Ported from
 * `openbox-sdk-ts` `src/client/workload-http.ts`.
 *
 * Every request here is:
 * - marked as our own traffic (`OPENBOX_INTERNAL_REQUEST`), so the fetch
 *   instrumentation never governs it. Keycloak is not Core, so without the
 *   marker token acquisition would try to govern itself;
 * - bounded by its own timeout, plus the owning client's close signal;
 * - refused on any redirect, so an API key or assertion never follows one.
 *
 * Failures become sanitized `OpenBoxWorkloadAuthError`s: status, stage, and a
 * short machine code only — never a token, assertion, request body, or raw
 * provider response.
 */

import { OpenBoxWorkloadAuthError, type WorkloadAuthStage } from '../errors';
import { anySignal, timeoutSignal } from './signals';

/** Same value as `OPENBOX_INTERNAL_REQUEST` in transport.ts (not imported, to keep this module a leaf). */
const INTERNAL_REQUEST_MARKER = '__openboxInternalRequest';

export interface AuthenticationTransport {
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
  /** Aborts when the owning acquisition is superseded or the client closes. */
  readonly closeSignal?: AbortSignal;
}

export interface AuthenticationRequest {
  readonly method: "GET" | "POST";
  readonly headers: Record<string, string>;
  readonly body?: string;
}

export interface AuthenticationResponse {
  readonly status: number;
  readonly text: string;
}

// Machine codes are short identifiers (`workload_identity_unavailable`, OAuth
// `invalid_client`, ...). Anything else is dropped rather than echoed.
const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** A short machine code from a JSON error body (first matching key), or null. */
export function reasonCodeFrom(text: string, keys: readonly string[]): string | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  for (const key of keys) {
    const value = (data as Record<string, unknown>)[key];
    if (typeof value === "string" && SAFE_CODE.test(value)) return value;
  }
  return null;
}

/** Core error bodies carry `reason_code` (their numeric `code` is the HTTP status). */
/**
 * A redirect answer: a 3xx under `redirect: "manual"` (Node), or an opaque
 * redirect (browsers). v3 requests never follow one.
 */
export function isRedirectResponse(response: Response): boolean {
  return response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400);
}

export const CORE_REASON_KEYS = ["reason_code", "code", "reason"] as const;
/** OAuth token-endpoint errors carry `error` (RFC 6749 §5.2); `error_description` is never read. */
export const OAUTH_REASON_KEYS = ["error"] as const;

function networkDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
  return `${error.message}${cause}`;
}

/**
 * Send one authentication request under the rules in the module docstring.
 * `target` names the endpoint in messages; `networkFailure` words a transport
 * failure (network error or timeout) for this stage.
 */
export async function sendAuthenticationRequest(
  transport: AuthenticationTransport,
  stage: WorkloadAuthStage,
  url: string,
  request: AuthenticationRequest,
  describe: { readonly target: string; readonly networkFailure: (detail: string) => string }
): Promise<AuthenticationResponse> {
  const { signal, dispose } = anySignal([timeoutSignal(transport.timeoutMs), transport.closeSignal]);
  let response: Response;
  try {
    response = await transport.fetchImpl(url, {
      ...request,
      redirect: 'manual',
      signal,
      ...({ [INTERNAL_REQUEST_MARKER]: true } as Record<string, unknown>),
    });
  } catch (error) {
    throw new OpenBoxWorkloadAuthError(describe.networkFailure(networkDetail(error)), { stage });
  } finally {
    dispose();
  }
  const target = describe.target;
  if (isRedirectResponse(response)) {
    throw new OpenBoxWorkloadAuthError(
      `${target} answered with a redirect (HTTP ${response.status}); redirects are refused so ` +
        "credentials never follow them to another target.",
      { stage, httpStatus: response.status }
    );
  }
  const text = await response.text().catch(() => "");
  return { status: response.status, text };
}

function withCode(status: number, reasonCode: string | null): string {
  return reasonCode ? `HTTP ${status} ${reasonCode}` : `HTTP ${status}`;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Classify a non-200 `GET /api/v3/auth/bootstrap` response. */
export function workloadBootstrapFailure(status: number, text: string): OpenBoxWorkloadAuthError {
  const reasonCode = reasonCodeFrom(text, CORE_REASON_KEYS);
  const detail = withCode(status, reasonCode);
  let message: string;
  if (status === 404) {
    message =
      "OpenBox Core does not serve GET /api/v3/auth/bootstrap (HTTP 404), so this deployment cannot " +
      "authenticate Keycloak workload identities. The SDK does not fall back to v1/v2 or API-key-only " +
      "requests: upgrade Core, or explicitly configure the agent's legacy identity instead.";
  } else if (status === 409 && reasonCode === "workload_identity_unavailable") {
    message =
      `OpenBox Core returned no usable active workload authority for this agent (${detail}). ` +
      "Check the agent's workload provisioning and activation and the Core deployment's workload " +
      "identity schema. The SDK does not fall back to legacy authentication; removing the workload " +
      "key is not a fix.";
  } else if (status === 401 || status === 403) {
    message =
      `OpenBox Core rejected the workload bootstrap request (${detail}): the API key is absent, ` +
      "invalid, or revoked, or the agent is not active. This is an authentication failure, not an outage.";
  } else if (isRetryableStatus(status)) {
    message =
      `OpenBox Core could not return workload identity metadata (${detail}); no governed request ` +
      "was sent. Retry later.";
  } else {
    message = `OpenBox Core rejected the workload bootstrap request (${detail}).`;
  }
  return new OpenBoxWorkloadAuthError(message, { stage: "bootstrap", httpStatus: status, reasonCode });
}

/** Classify a non-200 Keycloak token-endpoint response. */
export function workloadTokenFailure(status: number, text: string): OpenBoxWorkloadAuthError {
  const reasonCode = reasonCodeFrom(text, OAUTH_REASON_KEYS);
  const detail = withCode(status, reasonCode);
  const message =
    status === 400 || status === 401 || status === 403
      ? `Keycloak rejected the workload client assertion (${detail}). Confirm this runtime holds the ` +
        "private key registered for the agent's active service account; a different key requires a " +
        "new client after the managed transition."
      : `Keycloak's token endpoint failed (${detail}); no governed request was sent. Retry later.`;
  return new OpenBoxWorkloadAuthError(message, { stage: "token", httpStatus: status, reasonCode });
}
