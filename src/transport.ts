/**
 * Standalone HTTP transport — the one seam the n8n node fulfils with
 * `IExecuteFunctions.helpers.httpRequest` (so requests show up in n8n's
 * execution UI). Outside n8n there is no host to delegate to, so this module
 * owns the request itself: `fetch` + AIP request signing.
 *
 * Error taxonomy is identical to the n8n port's `openbox-client.ts`:
 *   - 401/403             → GovernanceAuthError, ALWAYS hard-fails
 *   - anything else       → SoftGovernanceError, subject to `onApiError`
 * Nothing else may escape `request()`, or a fail-open deployment would start
 * crashing on transient network faults.
 */

import { buildSignedHeaders, serializeBody } from './signing';

const OPENBOX_TIMEOUT_MS = 35_000;

export interface OpenBoxCredentials {
  /** Base URL of OpenBox Core, no trailing slash. */
  openboxUrl: string;
  apiKey: string;
  /** Agent DID (`did:aip:<uuid>`). Omit for unsigned mode. */
  agentDid?: string;
  /** Base64 raw 32-byte Ed25519 seed. Omit for unsigned mode. */
  agentPrivateKey?: string;
}

export interface OpenBoxRequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path beginning with "/", appended to the OpenBox base URL. */
  path: string;
  body?: unknown;
  traceId?: string;
  /** Overrides OPENBOX_TIMEOUT_MS — sourced from GovernanceConfig.governanceTimeout. */
  timeoutMs?: number;
}

/**
 * The narrow contract span_processor / GovernanceClient depend on. Kept as an
 * interface (not a concrete class) so a host that already owns an HTTP stack
 * — n8n, a proxy, a test double — can supply its own without this package
 * reaching for `fetch`.
 */
export interface OpenBoxTransport {
  request<T = unknown>(options: OpenBoxRequestOptions): Promise<T>;
}

/**
 * Marker error for governance/network failures. Callers that can safely
 * continue (fail-open) catch this; callers that must fail hard re-throw it.
 */
export class SoftGovernanceError extends Error {
  public readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'SoftGovernanceError';
    this.cause = cause;
  }
}

/**
 * A 401/403 from Core. Always a hard failure — never caught as fail-open,
 * regardless of the configured onApiError policy: a revoked or invalid key
 * must never silently degrade to "run ungoverned".
 */
export class GovernanceAuthError extends Error {
  public readonly statusCode: number;
  public readonly cause: unknown;
  constructor(message: string, statusCode: number, cause: unknown) {
    super(message);
    this.name = 'GovernanceAuthError';
    this.statusCode = statusCode;
    this.cause = cause;
  }
}

export const DEFAULT_OPENBOX_URL = 'https://core.openbox.ai';

/**
 * Resolve credentials from explicit options, falling back to the standard
 * OPENBOX_* environment variables. Mirrors the n8n credential fields.
 */
export function resolveCredentials(partial: Partial<OpenBoxCredentials> = {}): OpenBoxCredentials {
  const env = process.env;
  const apiKey = partial.apiKey ?? env.OPENBOX_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OpenBox API key not set. Pass `apiKey` or set OPENBOX_API_KEY.',
    );
  }
  const url = partial.openboxUrl ?? env.OPENBOX_API_URL ?? env.OPENBOX_URL ?? DEFAULT_OPENBOX_URL;
  return {
    openboxUrl: url.replace(/\/+$/, ''),
    apiKey,
    agentDid: partial.agentDid ?? env.OPENBOX_AGENT_DID,
    agentPrivateKey: partial.agentPrivateKey ?? env.OPENBOX_AGENT_PRIVATE_KEY,
  };
}

/**
 * `fetch`-backed transport. One instance per middleware; credentials are
 * resolved once at construction rather than per request (the n8n port
 * re-reads them each call because n8n owns credential rotation; here the
 * process lifetime is the credential lifetime).
 */
export class FetchTransport implements OpenBoxTransport {
  private readonly credentials: OpenBoxCredentials;

  constructor(credentials: OpenBoxCredentials) {
    this.credentials = credentials;
  }

  get baseUrl(): string {
    return this.credentials.openboxUrl;
  }

  async request<T = unknown>(options: OpenBoxRequestOptions): Promise<T> {
    const url = `${this.credentials.openboxUrl}${options.path}`;

    // Serialize before signing so the bytes we hash are the bytes we send.
    const bodyBytes = serializeBody(options.body ?? null);

    const headers = buildSignedHeaders(
      options.method,
      options.path,
      bodyBytes,
      this.credentials.apiKey,
      this.credentials.agentDid,
      this.credentials.agentPrivateKey,
    );
    if (options.traceId) {
      headers['X-OpenBox-Trace-Id'] = options.traceId;
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? OPENBOX_TIMEOUT_MS,
    );

    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method,
        headers,
        // `new Uint8Array(...)`, not the Buffer itself: a Buffer is a view
        // onto a pooled ArrayBuffer, and `fetch` would read the whole pool.
        body: bodyBytes.length > 0 ? new Uint8Array(bodyBytes) : undefined,
        signal: controller.signal,
        // Marks our own governance traffic so the fetch patch in
        // span_processor can skip it without a URL-prefix match.
        ...({ [OPENBOX_INTERNAL_REQUEST]: true } as Record<string, unknown>),
      });
    } catch (err) {
      throw new SoftGovernanceError(err instanceof Error ? err.message : String(err), err);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text().catch(() => '');

    if (response.status === 401 || response.status === 403) {
      throw new GovernanceAuthError(
        `OpenBox governance auth failed (${response.status}): ${text.slice(0, 500)}`,
        response.status,
        null,
      );
    }
    if (!response.ok) {
      throw new SoftGovernanceError(
        `OpenBox governance request failed (${response.status}): ${text.slice(0, 500)}`,
        null,
      );
    }

    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new SoftGovernanceError('OpenBox governance response was not JSON', err);
    }
  }
}

/**
 * Sentinel property set on our own outgoing governance requests. The fetch
 * patch checks it so an evaluate call made while an activity is registered is
 * never itself captured as a span — which would post a second governance
 * event to Core and, for require_approval policies, create a duplicate
 * approval request.
 */
export const OPENBOX_INTERNAL_REQUEST = '__openboxInternalRequest';
