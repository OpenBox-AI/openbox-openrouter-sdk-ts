/**
 * HTTP transport: `fetch` plus AIP request signing. A host that already owns
 * an HTTP stack can inject its own instead — see `OpenBoxTransport`.
 *
 * Error taxonomy:
 *   - 401/403             → GovernanceAuthError, ALWAYS hard-fails
 *   - a redirect          → SoftGovernanceError, never followed (see below)
 *   - anything else       → SoftGovernanceError, subject to `onApiError`
 * Nothing else may escape `request()`, or a fail-open deployment would start
 * crashing on transient network faults.
 */

import { envString } from './env';
import {
  GovernanceAuthError,
  GovernanceContractError,
  OpenBoxIdentityConfigError,
  OpenBoxWorkloadAuthError,
  SoftGovernanceError,
} from './errors';
import { mapAssertionError } from './identity/assertion-errors';
import { AuthStateCoordinator } from './identity/auth-state-coordinator';
import {
  AGENT_IDENTITY_METHODS,
  type AgentIdentityMethod,
  type IdentityFields,
  type ResolvedIdentityMethod,
  classifyOktaConfigMode,
  describeMutualExclusionConflict,
  describeOktaConfigProblem,
  describeWorkloadConflict,
  resolveIdentityMethod,
  resolveWorkloadPrivateKey,
} from './identity/identity-resolution';
import {
  ASSERTION_HEADER,
  OktaAgentIdentity,
  loadRsaPkcs8PrivateKey,
  oktaAssertionFor,
} from './identity/okta';
import {
  type IdentityBootstrapDocument,
  assertPrivateKeyMatchesDocument,
  fetchBootstrapDocument,
} from './identity/okta-bootstrap';
import { anySignal, timeoutSignal } from './identity/signals';
import { WORKLOAD_TOKEN_HEADER } from './identity/workload-assertion';
import { WorkloadAuthenticator, type WorkloadAuthState } from './identity/workload-authenticator';
import { CORE_REASON_KEYS, reasonCodeFrom } from './identity/workload-http';
import { validateUrlSecurity } from './identity/url-security';
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
  /**
   * Which identity the agent presents to Core. Inferred when omitted: DID
   * fields select `openbox_did`, a workload key selects `keycloak_workload`,
   * and nothing selects unsigned API-key mode. Set it explicitly
   * (`OPENBOX_AGENT_IDENTITY_METHOD`) so a missing key is an error rather than
   * a silent fall back to unsigned mode.
   */
  identityMethod?: AgentIdentityMethod;
  /**
   * PKCS8 PEM RSA private key of the agent's IAM v3 service account
   * (`OPENBOX_WORKLOAD_PRIVATE_KEY`). Selects `keycloak_workload`: every other
   * workload setting comes from Core's `/api/v3/auth/bootstrap`.
   */
  workloadPrivateKey?: string;
  /**
   * PKCS8 PEM RSA private key of the agent's selected Okta AI Agent credential
   * (`OPENBOX_OKTA_AGENT_PRIVATE_KEY`). Selects `okta_ai_agent` (v2): the rest
   * of the identity comes from Core's `/api/v2/auth/bootstrap`, unless every
   * field below is set explicitly.
   */
  oktaAgentPrivateKey?: string;
  /** Explicit Okta configuration only (`OPENBOX_OKTA_AGENT_ID`); normally supplied by Core. */
  oktaAgentId?: string;
  /** Explicit Okta configuration only (`OPENBOX_OKTA_AGENT_KEY_ID`). */
  oktaAgentKeyId?: string;
  /** Explicit Okta configuration only (`OPENBOX_OKTA_AGENT_ALGORITHM`); must be `RS256`. */
  oktaAgentAlgorithm?: string;
  /** Explicit Okta configuration only (`OPENBOX_AGENT_ID`). */
  agentId?: string;
  /** Explicit Okta configuration only (`OPENBOX_ORGANIZATION_ID`). */
  organizationId?: string;
  /** Explicit Okta configuration only (`OPENBOX_DEPLOYMENT_ID`). */
  deploymentId?: string;
  /** Explicit Okta configuration only (`OPENBOX_AGENT_PROOF_AUDIENCE`). */
  agentProofAudience?: string;
}

/** Credentials after identity resolution: exactly one method, and only its inputs. */
export interface ResolvedCredentials extends OpenBoxCredentials {
  readonly resolvedIdentityMethod: ResolvedIdentityMethod;
}

export interface OpenBoxRequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path beginning with "/", appended to the OpenBox base URL. */
  path: string;
  body?: unknown;
  traceId?: string;
  /** Overrides OPENBOX_TIMEOUT_MS — sourced from GovernanceConfig.governanceTimeout. */
  timeoutMs?: number;
  /** Cancels the request; combined with the timeout. */
  signal?: AbortSignal;
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

export { GovernanceAuthError, SoftGovernanceError } from './errors';

export const DEFAULT_OPENBOX_URL = 'https://core.openbox.ai';

/**
 * Resolve credentials from explicit options, falling back to the standard
 * OPENBOX_* environment variables.
 */
export function resolveCredentials(partial: Partial<OpenBoxCredentials> = {}): ResolvedCredentials {
  const apiKey = partial.apiKey ?? envString('OPENBOX_API_KEY');
  if (!apiKey) {
    throw new Error(
      'OpenBox API key not set. Pass `apiKey` or set OPENBOX_API_KEY.',
    );
  }
  const url =
    partial.openboxUrl ?? envString('OPENBOX_API_URL') ?? envString('OPENBOX_URL') ?? DEFAULT_OPENBOX_URL;
  const openboxUrl = url.replace(/\/+$/, '');

  const fields = identityFields(partial);
  const conflict = describeWorkloadConflict(fields) ?? describeMutualExclusionConflict(fields);
  if (conflict) throw new OpenBoxIdentityConfigError(conflict);

  const method = resolveIdentityMethod(fields);
  switch (method) {
    case 'keycloak_workload': {
      const workloadPrivateKey = resolveWorkloadPrivateKey(fields);
      if (!workloadPrivateKey) {
        throw new OpenBoxIdentityConfigError(
          "identityMethod is 'keycloak_workload' but no workload private key is configured: set workloadPrivateKey (OPENBOX_WORKLOAD_PRIVATE_KEY).",
        );
      }
      // A reusable workload token (and the API key) must never travel in cleartext.
      validateUrlSecurity(openboxUrl);
      return { openboxUrl, apiKey, identityMethod: method, workloadPrivateKey, resolvedIdentityMethod: method };
    }
    case 'openbox_did': {
      if (!fields.agentDid || !fields.agentPrivateKey) {
        throw new OpenBoxIdentityConfigError(
          "identityMethod is 'openbox_did' but agentDid (OPENBOX_AGENT_DID) and agentPrivateKey (OPENBOX_AGENT_PRIVATE_KEY) are not both set.",
        );
      }
      return {
        openboxUrl,
        apiKey,
        identityMethod: method,
        agentDid: fields.agentDid,
        agentPrivateKey: fields.agentPrivateKey,
        resolvedIdentityMethod: method,
      };
    }
    case 'okta_ai_agent': {
      const problem = describeOktaConfigProblem(fields);
      if (problem) throw new OpenBoxIdentityConfigError(problem);
      const oktaAgentPrivateKey = fields.oktaAgentPrivateKey as string;
      const base = { openboxUrl, apiKey, identityMethod: method, oktaAgentPrivateKey, resolvedIdentityMethod: method };
      if (classifyOktaConfigMode(fields) === 'bootstrap') return base;
      // Fully explicit configuration: no bootstrap call.
      return {
        ...base,
        oktaAgentId: fields.oktaAgentId as string,
        oktaAgentKeyId: fields.oktaAgentKeyId as string,
        oktaAgentAlgorithm: fields.oktaAgentAlgorithm as string,
        agentId: fields.agentId as string,
        organizationId: fields.organizationId as string,
        deploymentId: fields.deploymentId as string,
        agentProofAudience: fields.agentProofAudience as string,
      };
    }
    case 'legacy_unsigned':
      return { openboxUrl, apiKey, resolvedIdentityMethod: method };
  }
}

/** Identity settings from explicit options, falling back to the base SDK's env names. */
function identityFields(partial: Partial<OpenBoxCredentials>): IdentityFields {
  const rawMethod = partial.identityMethod ?? envString('OPENBOX_AGENT_IDENTITY_METHOD');
  if (rawMethod !== undefined && !(AGENT_IDENTITY_METHODS as readonly string[]).includes(rawMethod)) {
    throw new OpenBoxIdentityConfigError(
      `identityMethod (OPENBOX_AGENT_IDENTITY_METHOD) must be one of ${AGENT_IDENTITY_METHODS.join(', ')}, got '${rawMethod}'.`,
    );
  }
  return {
    identityMethod: (rawMethod as AgentIdentityMethod | undefined) ?? null,
    agentDid: partial.agentDid ?? envString('OPENBOX_AGENT_DID') ?? null,
    agentPrivateKey: partial.agentPrivateKey ?? envString('OPENBOX_AGENT_PRIVATE_KEY') ?? null,
    workloadPrivateKey: partial.workloadPrivateKey ?? envString('OPENBOX_WORKLOAD_PRIVATE_KEY') ?? null,
    oktaAgentId: partial.oktaAgentId ?? envString('OPENBOX_OKTA_AGENT_ID') ?? null,
    oktaAgentKeyId: partial.oktaAgentKeyId ?? envString('OPENBOX_OKTA_AGENT_KEY_ID') ?? null,
    oktaAgentPrivateKey: partial.oktaAgentPrivateKey ?? envString('OPENBOX_OKTA_AGENT_PRIVATE_KEY') ?? null,
    oktaAgentAlgorithm: partial.oktaAgentAlgorithm ?? envString('OPENBOX_OKTA_AGENT_ALGORITHM') ?? null,
    agentId: partial.agentId ?? envString('OPENBOX_AGENT_ID') ?? null,
    organizationId: partial.organizationId ?? envString('OPENBOX_ORGANIZATION_ID') ?? null,
    deploymentId: partial.deploymentId ?? envString('OPENBOX_DEPLOYMENT_ID') ?? null,
    agentProofAudience: partial.agentProofAudience ?? envString('OPENBOX_AGENT_PROOF_AUDIENCE') ?? null,
  };
}

/**
 * The v1 Core routes this SDK calls, and their v2 (Okta) and v3 (workload)
 * equivalents. A v2 or v3 client sends ONLY to its own version's routes — any
 * other path is refused rather than sent to v1 with the wrong credential.
 */
const RUNTIME_ROUTES: Readonly<Record<2 | 3, Readonly<Record<string, string>>>> = {
  2: {
    '/api/v1/governance/evaluate': '/api/v2/governance/evaluate',
    '/api/v1/governance/approval': '/api/v2/governance/approval',
    '/api/v1/auth/validate': '/api/v2/auth/validate',
  },
  3: {
    '/api/v1/governance/evaluate': '/api/v3/governance/evaluate',
    '/api/v1/governance/approval': '/api/v3/governance/approval',
    '/api/v1/auth/validate': '/api/v3/auth/validate',
  },
};

/** An Okta v2 bootstrap-mode identity together with the document it was built from. */
interface OktaBootstrapState {
  readonly identity: OktaAgentIdentity;
  readonly document: IdentityBootstrapDocument;
}

/**
 * `fetch`-backed transport. One instance per middleware; credentials are
 * resolved once at construction rather than per request (a host that owns
 * credential rotation would re-read them each call; here the
 * process lifetime is the credential lifetime).
 */
export class FetchTransport implements OpenBoxTransport {
  private readonly credentials: OpenBoxCredentials;
  /** IAM v3 workload authentication; non-null exactly when the method is `keycloak_workload`. */
  private readonly workload: WorkloadAuthenticator | null;
  /** Okta v2 identity configured explicitly (no bootstrap). */
  private readonly oktaIdentity: OktaAgentIdentity | null = null;
  /** Okta v2 identity fetched from Core on first use; replaced only by `refreshIdentityMetadata()`. */
  private readonly oktaBootstrap: AuthStateCoordinator<OktaBootstrapState> | null = null;
  private closed = false;

  constructor(credentials: OpenBoxCredentials, options: { logger?: { info?(message: string): void } } = {}) {
    this.credentials = credentials;
    if (credentials.workloadPrivateKey !== undefined) {
      validateUrlSecurity(credentials.openboxUrl);
      if (credentials.agentDid || credentials.agentPrivateKey) {
        throw new OpenBoxIdentityConfigError(
          'A workload private key (keycloak_workload) cannot be combined with agentDid/agentPrivateKey (openbox_did); exactly one identity method is allowed.',
        );
      }
      const info = options.logger?.info?.bind(options.logger);
      // Parses and size-checks the key now: a bad key fails before any request.
      this.workload = new WorkloadAuthenticator({
        privateKeyPem: credentials.workloadPrivateKey,
        apiUrl: credentials.openboxUrl,
        coreHeaders: () => buildSignedHeaders('GET', '', Buffer.alloc(0), credentials.apiKey),
        fetchImpl: (input, init) => fetch(input, init),
        timeoutMs: OPENBOX_TIMEOUT_MS,
        logger: { info: (message) => info?.(message) },
        closedError: () => new OpenBoxIdentityConfigError('This OpenBox transport has been closed.'),
      });
    } else {
      this.workload = null;
    }

    const oktaKey = credentials.oktaAgentPrivateKey;
    if (oktaKey !== undefined) {
      if (this.workload !== null || credentials.agentDid || credentials.agentPrivateKey) {
        throw new OpenBoxIdentityConfigError(
          'An Okta agent private key (okta_ai_agent) cannot be combined with another identity method; exactly one is allowed.',
        );
      }
      // Fails locally, before any request, on a malformed, non-RSA or undersized key.
      loadRsaPkcs8PrivateKey(oktaKey);
      const explicit = credentials.oktaAgentId !== undefined;
      if (explicit) {
        this.oktaIdentity = OktaAgentIdentity.fromConfig({
          method: 'okta_ai_agent',
          openboxAgentId: credentials.agentId as string,
          organizationId: credentials.organizationId as string,
          deploymentId: credentials.deploymentId as string,
          externalAgentId: credentials.oktaAgentId as string,
          keyId: credentials.oktaAgentKeyId as string,
          algorithm: credentials.oktaAgentAlgorithm as 'RS256',
          privateKey: oktaKey,
          audience: credentials.agentProofAudience as string,
        });
      } else {
        const info = options.logger?.info?.bind(options.logger);
        this.oktaBootstrap = new AuthStateCoordinator<OktaBootstrapState>({
          acquire: (signal) => this.runOktaBootstrap(oktaKey, signal),
          isUsable: () => true,
          closedError: () => new OpenBoxIdentityConfigError('This OpenBox transport has been closed.'),
          // Logged on publish, so a superseded bootstrap never reports success.
          onPublish: ({ document }) =>
            info?.(
              `OpenBox identity bootstrap succeeded (agent ${document.openboxAgentId}, kid ${document.okta.credentialKid}, thumbprint matched)`,
            ),
        });
      }
    }
  }

  /**
   * The identity contract every request uses: 3 for workload identity, 2 for
   * Okta, else 1. Fixed at construction — a failed bootstrap or token
   * acquisition can never downgrade it.
   */
  get contractVersion(): 1 | 2 | 3 {
    if (this.workload !== null) return 3;
    if (this.oktaIdentity !== null || this.oktaBootstrap !== null) return 2;
    return 1;
  }

  /** The validated Okta bootstrap document, or null (not bootstrap mode, or not bootstrapped yet). Non-secret. */
  identityMetadata(): IdentityBootstrapDocument | null {
    return this.oktaBootstrap?.current()?.document ?? null;
  }

  /**
   * Re-fetch Okta identity metadata from Core, e.g. after a credential
   * rotation. The current identity is dropped FIRST, so a refresh that fails
   * leaves no stale signer behind and later requests stay blocked until a
   * bootstrap succeeds. Never called automatically after an auth failure: a
   * rotated credential may need a key this process does not hold.
   */
  async refreshIdentityMetadata(): Promise<IdentityBootstrapDocument> {
    if (this.oktaBootstrap === null) {
      throw new OpenBoxIdentityConfigError(
        'refreshIdentityMetadata() needs an Okta identity in bootstrap mode (only OPENBOX_OKTA_AGENT_PRIVATE_KEY configured).',
      );
    }
    this.oktaBootstrap.reset();
    return (await this.oktaBootstrap.get()).document;
  }

  /** The Okta identity to sign with: the explicit one, or the bootstrapped one (bootstrapping once if needed). */
  private async resolveOktaIdentity(signal?: AbortSignal): Promise<OktaAgentIdentity> {
    if (this.oktaIdentity !== null) return this.oktaIdentity;
    if (this.oktaBootstrap === null) {
      throw new OpenBoxIdentityConfigError('No Okta identity is configured for this transport.');
    }
    return (await this.oktaBootstrap.get(signal)).identity;
  }

  /** Fetch, validate and thumbprint-check the Okta identity; nothing is signed before the key matches. */
  private async runOktaBootstrap(privateKeyPem: string, signal: AbortSignal): Promise<OktaBootstrapState> {
    const document = await fetchBootstrapDocument({
      apiUrl: this.credentials.openboxUrl,
      headers: buildSignedHeaders('GET', '', Buffer.alloc(0), this.credentials.apiKey),
      fetchImpl: (input, init) => fetch(input, init),
      timeoutMs: OPENBOX_TIMEOUT_MS,
      signal,
    });
    // Throws on mismatch — no governed request is ever sent after this point.
    assertPrivateKeyMatchesDocument(privateKeyPem, document);
    const identity = OktaAgentIdentity.fromConfig({
      method: 'okta_ai_agent',
      openboxAgentId: document.openboxAgentId,
      organizationId: document.organizationId,
      deploymentId: document.deploymentId,
      externalAgentId: document.okta.externalAgentId,
      keyId: document.okta.credentialKid,
      algorithm: 'RS256',
      privateKey: privateKeyPem,
      audience: document.assertionAudience,
    });
    return { identity, document };
  }

  /**
   * Drop the workload signer and cached token and abort an in-flight
   * acquisition. Later requests are refused. Idempotent.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.workload?.close();
    this.oktaBootstrap?.close();
  }

  get baseUrl(): string {
    return this.credentials.openboxUrl;
  }

  async request<T = unknown>(options: OpenBoxRequestOptions): Promise<T> {
    if (this.closed) throw new OpenBoxIdentityConfigError('This OpenBox transport has been closed.');
    const workload = this.workload;
    const contractVersion = this.contractVersion;

    // A v2 or v3 client is fixed to its own routes and never sends to v1.
    let path = options.path;
    if (contractVersion !== 1) {
      const mapped = RUNTIME_ROUTES[contractVersion][path];
      if (mapped === undefined) {
        throw new GovernanceContractError(
          `No v${contractVersion} route for ${path}; a v${contractVersion} client never sends to a v1 route.`,
        );
      }
      path = mapped;
    }
    const url = `${this.credentials.openboxUrl}${path}`;

    // Serialize before signing so the bytes we hash are the bytes we send.
    const bodyBytes = serializeBody(options.body ?? null);

    // v3 sends the API key, SDK headers and the raw workload token — never DID
    // signature headers. Acquisition failures throw here, before any request.
    let workloadAuth: WorkloadAuthState | null = null;
    let headers: Record<string, string>;
    if (workload !== null) {
      workloadAuth = await workload.get(options.signal);
      headers = buildSignedHeaders(options.method, path, bodyBytes, this.credentials.apiKey);
      headers[WORKLOAD_TOKEN_HEADER] = workloadAuth.accessToken();
    } else if (contractVersion === 2) {
      // v2 sends ONLY the base headers plus X-OpenBox-Agent-Assertion — never
      // v1 DID identity headers. Bootstrap failures throw here, before any request.
      const identity = await this.resolveOktaIdentity(options.signal);
      headers = buildSignedHeaders(options.method, path, bodyBytes, this.credentials.apiKey);
      headers[ASSERTION_HEADER] = oktaAssertionFor(identity, options.method, path, bodyBytes, this.credentials.apiKey);
    } else {
      headers = buildSignedHeaders(
        options.method,
        path,
        bodyBytes,
        this.credentials.apiKey,
        this.credentials.agentDid,
        this.credentials.agentPrivateKey,
      );
    }
    if (options.traceId) {
      headers['X-OpenBox-Trace-Id'] = options.traceId;
    }

    // The caller's signal, if any, is combined with the timeout by hand:
    // Node 18 has no AbortSignal.any.
    const { signal, dispose } = anySignal([
      timeoutSignal(options.timeoutMs ?? OPENBOX_TIMEOUT_MS),
      options.signal,
    ]);

    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method,
        headers,
        // `new Uint8Array(...)`, not the Buffer itself: a Buffer is a view
        // onto a pooled ArrayBuffer, and `fetch` would read the whole pool.
        body: bodyBytes.length > 0 ? new Uint8Array(bodyBytes) : undefined,
        signal,
        // Never follow a redirect. On a cross-origin redirect `fetch` drops
        // `Authorization` but re-sends every custom header, so following one
        // would hand the X-OpenBox-* signing headers (or the workload token)
        // to the redirect target — and its body would then be read as Core's
        // governance answer.
        redirect: 'manual',
        // Marks our own governance traffic so the fetch patch in
        // span_processor can skip it without a URL-prefix match.
        ...({ [OPENBOX_INTERNAL_REQUEST]: true } as Record<string, unknown>),
      });
    } catch (err) {
      throw new SoftGovernanceError(err instanceof Error ? err.message : String(err), err);
    } finally {
      dispose();
    }

    // `redirect: 'manual'` surfaces the 3xx itself in Node, and an opaque
    // status-0 response in a browser-like runtime. Either way it is not an
    // answer from Core.
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get('location');
      const message = `OpenBox governance request was redirected (${response.status}${location ? ` to ${location}` : ''}); redirects are not followed — check the OpenBox URL`;
      // On v3 a redirect is a contract error under every outage policy.
      if (workload !== null) throw new GovernanceContractError(message);
      throw new SoftGovernanceError(message, null);
    }

    const text = await response.text().catch(() => '');

    if (response.status === 401 || response.status === 403) {
      if (workload !== null && workloadAuth !== null) {
        // Discard exactly the token this request carried; the next request
        // bootstraps again. The rejected request is not replayed. Core folds
        // every identity failure into a generic 401, so no reason code is
        // needed to decide this.
        workload.invalidate(workloadAuth);
        const reasonCode = reasonCodeFrom(text, CORE_REASON_KEYS);
        const detail = reasonCode ? `HTTP ${response.status} ${reasonCode}` : `HTTP ${response.status}`;
        throw new OpenBoxWorkloadAuthError(
          `OpenBox Core rejected the workload-authenticated request to ${path} (${detail}). The cached workload token was discarded and the next request bootstraps again; check the agent's active workload identity if this persists.`,
          { stage: 'runtime', httpStatus: response.status, reasonCode },
        );
      }
      if (contractVersion === 2) {
        // No automatic refresh: a rotated credential may need a key this
        // process does not hold, and a silent retry would hide that.
        throw mapAssertionError(response.status, reasonCodeFrom(text, CORE_REASON_KEYS));
      }
      throw new GovernanceAuthError(
        `OpenBox governance auth failed (${response.status}): ${text.slice(0, 500)}`,
        response.status,
        null,
      );
    }
    // v3: a non-retryable 4xx (malformed payload, missing route) is a contract
    // error, never an outage, so it never becomes "run ungoverned".
    if (workload !== null && response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) {
      const reasonCode = reasonCodeFrom(text, CORE_REASON_KEYS);
      throw new GovernanceContractError(
        `OpenBox Core rejected the v3 request to ${path} (HTTP ${response.status}${reasonCode ? ` ${reasonCode}` : ''}). This is a contract error, not an outage; check that the SDK and Core versions are compatible.`,
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
