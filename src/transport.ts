/**
 * HTTP transport to OpenBox Core, backed by the OpenBox base SDK
 * (`@openbox-ai/openbox-sdk-ts`). The base client owns the live wire contract:
 * which API version an agent speaks (v1 DID, v2 Okta, v3 Keycloak workload),
 * request signing, identity bootstrap and workload tokens. A host that already
 * owns an HTTP stack can inject its own transport instead — see
 * `OpenBoxTransport`.
 *
 * Error taxonomy:
 *   - auth/identity failure → GovernanceAuthError, ALWAYS hard-fails
 *   - outage / bad response → SoftGovernanceError, subject to `onApiError`
 * Nothing else may escape `request()`, or a fail-open deployment would start
 * crashing on transient network faults.
 */

import { OpenBoxClient } from '@openbox-ai/openbox-sdk-ts/client';
import { OpenBoxConfig } from '@openbox-ai/openbox-sdk-ts/config';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pkg = require('../package.json') as { version: string };

const OPENBOX_TIMEOUT_MS = 35_000;

export type AgentIdentityMethod = 'openbox_did' | 'okta_ai_agent' | 'keycloak_workload';

export interface OpenBoxCredentials {
  /** Base URL of OpenBox Core, no trailing slash. */
  openboxUrl: string;
  apiKey: string;
  /**
   * Pin the identity method. Normally inferred from which key is configured;
   * only needed to use the Okta key as a `keycloak_workload` migration alias.
   */
  identityMethod?: AgentIdentityMethod;
  /** v1: agent DID (`did:aip:<uuid>`). Omit, with the key, for unsigned mode. */
  agentDid?: string;
  /** v1: base64 raw 32-byte Ed25519 seed. */
  agentPrivateKey?: string;
  /**
   * v2: PKCS8 PEM RSA key of the agent's selected Okta credential. On its own
   * it is enough — Core supplies the rest of the identity from
   * `GET /api/v2/auth/bootstrap`. Set every Okta field below too, or none.
   */
  oktaAgentPrivateKey?: string;
  oktaAgentId?: string;
  oktaAgentKeyId?: string;
  oktaAgentAlgorithm?: string;
  agentId?: string;
  organizationId?: string;
  deploymentId?: string;
  agentProofAudience?: string;
  /** v3: PKCS8 PEM RSA key of the agent's active Keycloak service account. */
  workloadPrivateKey?: string;
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
 * — a proxy, a test double, a host framework — can supply its own without this package
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
 * An auth or identity failure: a 401/403 from Core, a key that does not match
 * the agent's credential, an identity bootstrap or workload token that Core or
 * Keycloak refused. Always a hard failure — never caught as fail-open,
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

/** An env var, with a blank value counting as unset. */
function envValue(name: string): string | undefined {
  const value = process.env[name];
  return value != null && value.trim() !== '' ? value : undefined;
}

/**
 * Resolve credentials from explicit options, falling back to the standard
 * OPENBOX_* environment variables.
 */
export function resolveCredentials(partial: Partial<OpenBoxCredentials> = {}): OpenBoxCredentials {
  const apiKey = partial.apiKey ?? envValue('OPENBOX_API_KEY');
  if (!apiKey) {
    throw new Error(
      'OpenBox API key not set. Pass `apiKey` or set OPENBOX_API_KEY.',
    );
  }
  const url =
    partial.openboxUrl ?? envValue('OPENBOX_API_URL') ?? envValue('OPENBOX_URL') ?? DEFAULT_OPENBOX_URL;
  return {
    openboxUrl: url.replace(/\/+$/, ''),
    apiKey,
    identityMethod:
      partial.identityMethod ??
      (envValue('OPENBOX_AGENT_IDENTITY_METHOD') as AgentIdentityMethod | undefined),
    agentDid: partial.agentDid ?? envValue('OPENBOX_AGENT_DID'),
    agentPrivateKey: partial.agentPrivateKey ?? envValue('OPENBOX_AGENT_PRIVATE_KEY'),
    oktaAgentPrivateKey: partial.oktaAgentPrivateKey ?? envValue('OPENBOX_OKTA_AGENT_PRIVATE_KEY'),
    oktaAgentId: partial.oktaAgentId ?? envValue('OPENBOX_OKTA_AGENT_ID'),
    oktaAgentKeyId: partial.oktaAgentKeyId ?? envValue('OPENBOX_OKTA_AGENT_KEY_ID'),
    oktaAgentAlgorithm: partial.oktaAgentAlgorithm ?? envValue('OPENBOX_OKTA_AGENT_ALGORITHM'),
    agentId: partial.agentId ?? envValue('OPENBOX_AGENT_ID'),
    organizationId: partial.organizationId ?? envValue('OPENBOX_ORGANIZATION_ID'),
    deploymentId: partial.deploymentId ?? envValue('OPENBOX_DEPLOYMENT_ID'),
    agentProofAudience: partial.agentProofAudience ?? envValue('OPENBOX_AGENT_PROOF_AUDIENCE'),
    workloadPrivateKey: partial.workloadPrivateKey ?? envValue('OPENBOX_WORKLOAD_PRIVATE_KEY'),
  };
}

const EVALUATE_PATH = '/api/v1/governance/evaluate';
const APPROVAL_PATH = '/api/v1/governance/approval';

/**
 * Transport backed by the base SDK's `OpenBoxClient`. One instance per
 * middleware; credentials are resolved once at construction, and an invalid
 * identity (two methods configured, a malformed key) throws here rather than
 * on the first governed call.
 *
 * Callers name the v1 routes; the client sends each operation on the agent's
 * own API version and never retries it on another.
 */
export class FetchTransport implements OpenBoxTransport {
  private readonly credentials: OpenBoxCredentials;
  private readonly client: OpenBoxClient;

  constructor(credentials: OpenBoxCredentials, options: { timeoutMs?: number } = {}) {
    this.credentials = credentials;
    const config = OpenBoxConfig.resolve({
      apiUrl: credentials.openboxUrl,
      apiKey: credentials.apiKey,
      timeoutSeconds: (options.timeoutMs ?? OPENBOX_TIMEOUT_MS) / 1000,
      // An outage comes back as a fallback ALLOW, which request() turns into
      // a SoftGovernanceError so this package's own onApiError decides.
      onApiError: 'fail_open',
      identityMethod: credentials.identityMethod ?? null,
      agentDid: credentials.agentDid ?? null,
      agentPrivateKey: credentials.agentPrivateKey ?? null,
      oktaAgentPrivateKey: credentials.oktaAgentPrivateKey ?? null,
      oktaAgentId: credentials.oktaAgentId ?? null,
      oktaAgentKeyId: credentials.oktaAgentKeyId ?? null,
      oktaAgentAlgorithm: credentials.oktaAgentAlgorithm ?? null,
      agentId: credentials.agentId ?? null,
      organizationId: credentials.organizationId ?? null,
      deploymentId: credentials.deploymentId ?? null,
      agentProofAudience: credentials.agentProofAudience ?? null,
      workloadPrivateKey: credentials.workloadPrivateKey ?? null,
      sdkVersion: pkg.version,
      sdkEngine: 'openrouter',
      sdkLanguage: 'typescript',
      // Credentials are already resolved; the environment is not read twice.
      environ: {},
    });
    this.client = OpenBoxClient.fromConfig(config, {
      // Marks our own governance traffic — identity bootstrap and the
      // Keycloak token exchange included — so the fetch patch in
      // span_processor can skip it without a URL-prefix match.
      fetchImpl: (input, init) =>
        globalThis.fetch(input, { ...init, [OPENBOX_INTERNAL_REQUEST]: true } as RequestInit),
      logger: {
        info: () => {},
        warn: () => {},
        error: (message) => console.error(`[openbox] ${message}`),
      },
    });
  }

  get baseUrl(): string {
    return this.credentials.openboxUrl;
  }

  async request<T = unknown>(options: OpenBoxRequestOptions): Promise<T> {
    if (options.path === EVALUATE_PATH) {
      const result = await this.hard(() => this.client.evaluate((options.body ?? {}) as never));
      // Only the client's own outage fallback is soft. It carries no body;
      // Core also sends `fallback_used` (its policy engine failed closed),
      // and that is a real verdict to enforce.
      if (result.fallbackUsed && Object.keys(result.raw).length === 0) {
        throw new SoftGovernanceError(result.reason ?? 'OpenBox governance request failed', null);
      }
      return result.raw as T;
    }
    if (options.path === APPROVAL_PATH) {
      const body = (options.body ?? {}) as Record<string, string>;
      const result = await this.hard(() =>
        this.client.pollApproval(body.workflow_id, body.run_id, body.activity_id),
      );
      if (result === null) {
        throw new SoftGovernanceError('OpenBox approval poll failed', null);
      }
      return result.raw as T;
    }
    throw new Error(`FetchTransport does not support ${options.method} ${options.path}`);
  }

  /**
   * Run one client call. With `fail_open`, the base client throws only for
   * what must never fail open — auth/signing rejections, identity bootstrap
   * or workload token failures, v3 contract errors — so anything it throws is
   * hard.
   */
  private async hard<R>(call: () => Promise<R>): Promise<R> {
    try {
      return await call();
    } catch (err) {
      // Workload errors carry the status; v1/v2 auth errors only name it.
      const named = /HTTP (\d{3})/.exec(err instanceof Error ? err.message : '');
      const status =
        (err as { httpStatus?: number | null }).httpStatus ?? (named ? Number(named[1]) : 0);
      throw new GovernanceAuthError(
        `OpenBox governance auth failed: ${err instanceof Error ? err.message : String(err)}`,
        status,
        err,
      );
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
