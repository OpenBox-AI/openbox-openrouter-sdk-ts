/**
 * Per-transport IAM v3 workload authentication: Core bootstrap → RFC 7523
 * `private_key_jwt` → Keycloak client-credentials access token. Ported from
 * `openbox-sdk-ts` `src/client/workload-authenticator.ts`.
 *
 * One instance per `FetchTransport` — no process-global cache, singleton, timer,
 * or persistent store. The signer, validated metadata, token, and in-flight
 * acquisition live here in real private fields, so inspecting a client never
 * reveals key or token material.
 *
 * Every acquisition — first use and each renewal — re-fetches
 * `GET /api/v3/auth/bootstrap` before exchanging a token. That one extra small
 * request per renewal is what keeps a long-running client from renewing tokens
 * forever against authority metadata from a previous activation.
 *
 * The access token is opaque here: it is cached for at most 300 s, renewed 30 s
 * before that, and never used once refresh-due — even when renewal fails.
 */

import type { KeyObject } from 'crypto';

import { OpenBoxWorkloadAuthError } from '../errors';
import { loadRsaPrivateKey } from './rsa-private-key';
import { CLIENT_ASSERTION_TYPE, buildWorkloadClientAssertion } from './workload-assertion';
import { AuthStateCoordinator } from './auth-state-coordinator';
import {
  ACCESS_TOKEN_REFRESH_MARGIN_SECONDS,
  parseWorkloadBootstrapDocument,
  parseWorkloadTokenResponse,
  type WorkloadAccessTokenResponse,
  type WorkloadBootstrapDocument,
} from './workload-documents';
import {
  sendAuthenticationRequest,
  workloadBootstrapFailure,
  workloadTokenFailure,
  type AuthenticationTransport,
} from './workload-http';

/** `GET /api/v3/auth/bootstrap` — API-key-only, returns the active service-account metadata. */
export const AUTH_BOOTSTRAP_PATH_V3 = '/api/v3/auth/bootstrap';

/** Metadata fields compared (by name only) to report an authority change. */
const AUTHORITY_FIELDS = [
  'issuer',
  'tokenEndpoint',
  'audience',
  'clientId',
  'kid',
  'serviceAccountId',
  'activationVersion',
  'identitySource',
] as const;

/**
 * One published acquisition: the metadata and token always come from the same
 * bootstrap + exchange. The token is a private field so neither inspection nor
 * JSON serialization of this object can reveal it.
 */
export class WorkloadAuthState {
  readonly metadata: WorkloadBootstrapDocument;
  /** Monotonic time (ms) from which this state must no longer be used. */
  readonly refreshAtMs: number;
  readonly #accessToken: string;

  constructor(metadata: WorkloadBootstrapDocument, accessToken: string, refreshAtMs: number) {
    this.metadata = metadata;
    this.refreshAtMs = refreshAtMs;
    this.#accessToken = accessToken;
  }

  /** The raw token for `X-OpenBox-Workload-Token` (no `Bearer ` prefix). */
  accessToken(): string {
    return this.#accessToken;
  }
}

export interface WorkloadAuthenticatorOptions {
  readonly privateKeyPem: string;
  readonly apiUrl: string;
  /** Core auth + SDK identity headers: API key, `User-Agent`, `X-OpenBox-SDK-Version`. */
  readonly coreHeaders: () => Record<string, string>;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
  readonly logger: { info(message: string): void };
  /** The error every call receives after `close()`. */
  readonly closedError: () => Error;
  /** Monotonic clock in ms; defaults to `performance.now`. */
  readonly now?: () => number;
}

export class WorkloadAuthenticator {
  // Everything except the PEM: the key is kept only as the parsed signer, which close() drops.
  readonly #options: Omit<WorkloadAuthenticatorOptions, 'privateKeyPem'>;
  readonly #now: () => number;
  readonly #coordinator: AuthStateCoordinator<WorkloadAuthState>;
  #signer: KeyObject | null;
  // Previous PUBLISHED metadata, kept ONLY to report what changed — never an authentication fallback.
  #lastMetadata: WorkloadBootstrapDocument | null = null;

  /** Parses and validates the key immediately: a bad key fails before any HTTP. */
  constructor(options: WorkloadAuthenticatorOptions) {
    const { privateKeyPem, ...rest } = options;
    this.#signer = loadRsaPrivateKey(privateKeyPem, 'workloadPrivateKey');
    this.#options = rest;
    this.#now = options.now ?? (() => performance.now());
    this.#coordinator = new AuthStateCoordinator<WorkloadAuthState>({
      acquire: (signal) => this.#acquire(signal),
      isUsable: (state) => this.#now() < state.refreshAtMs,
      closedError: options.closedError,
      onPublish: (state) => {
        this.#noteAuthority(state.metadata);
      },
    });
  }

  /** A usable auth state, acquiring (bootstrap + token) when none is cached or it is refresh-due. */
  get(signal?: AbortSignal): Promise<WorkloadAuthState> {
    return this.#coordinator.get(signal);
  }

  /** Metadata backing the current usable state, or null. Immutable and non-secret. */
  metadata(): WorkloadBootstrapDocument | null {
    return this.#coordinator.current()?.metadata ?? null;
  }

  /**
   * Invalidate the current state immediately, then acquire again through the
   * same coordination as automatic renewal. On failure nothing usable remains:
   * later operations stay blocked until an acquisition succeeds.
   */
  async refresh(): Promise<WorkloadBootstrapDocument> {
    this.#coordinator.reset();
    return (await this.#coordinator.get()).metadata;
  }

  /** Discard `state` after Core rejected a request carrying it (no-op if already replaced). */
  invalidate(state: WorkloadAuthState): void {
    this.#coordinator.invalidate(state);
  }

  /** Idempotent: drop the signer and cached state, and abort in-flight acquisition. */
  close(): void {
    this.#coordinator.close();
    this.#signer = null;
    this.#lastMetadata = null;
  }

  /** One acquisition; `signal` aborts when it is superseded (explicit refresh) or the client closes. */
  async #acquire(signal: AbortSignal): Promise<WorkloadAuthState> {
    const transport: AuthenticationTransport = {
      fetchImpl: this.#options.fetchImpl,
      timeoutMs: this.#options.timeoutMs,
      closeSignal: signal,
    };
    const metadata = await this.#fetchBootstrap(transport);
    const signer = this.#signer;
    if (signer === null) throw this.#options.closedError();

    // Measured before the exchange: the token cannot have been issued earlier,
    // so its lifetime is never overestimated by the time the exchange took.
    const startedAt = this.#now();
    const token = await this.#exchangeToken(transport, signer, metadata);
    const refreshAtMs =
      startedAt + (token.cacheSeconds - ACCESS_TOKEN_REFRESH_MARGIN_SECONDS) * 1000;
    if (this.#now() >= refreshAtMs) {
      throw new OpenBoxWorkloadAuthError(
        "The workload token exchange took longer than the token's usable lifetime " +
          `(expires_in minus the ${ACCESS_TOKEN_REFRESH_MARGIN_SECONDS}s refresh margin); no governed request was sent.`,
        { stage: 'token' },
      );
    }
    return new WorkloadAuthState(metadata, token.accessToken, refreshAtMs);
  }

  async #fetchBootstrap(transport: AuthenticationTransport): Promise<WorkloadBootstrapDocument> {
    const response = await sendAuthenticationRequest(
      transport,
      'bootstrap',
      `${this.#options.apiUrl}${AUTH_BOOTSTRAP_PATH_V3}`,
      { method: 'GET', headers: { ...this.#options.coreHeaders(), Accept: 'application/json' } },
      {
        target: "OpenBox Core's workload bootstrap endpoint",
        networkFailure: (detail) =>
          `OpenBox Core could not be reached for workload bootstrap (${detail}); no governed request was sent.`,
      },
    );
    if (response.status !== 200) throw workloadBootstrapFailure(response.status, response.text);
    return parseWorkloadBootstrapDocument(
      parseJsonBody(response.text, 'Workload bootstrap response', 'bootstrap'),
    );
  }

  async #exchangeToken(
    transport: AuthenticationTransport,
    signer: KeyObject,
    metadata: WorkloadBootstrapDocument,
  ): Promise<WorkloadAccessTokenResponse> {
    // Exactly these four fields: no scope/audience parameter (Backend's token
    // mappers set the access-token audience), and no OpenBox API key, workload
    // token, DID/Okta proof, or client secret ever reaches Keycloak.
    const body = new URLSearchParams([
      ['grant_type', 'client_credentials'],
      ['client_id', metadata.clientId],
      ['client_assertion_type', CLIENT_ASSERTION_TYPE],
      ['client_assertion', buildWorkloadClientAssertion(signer, metadata)],
    ]).toString();
    const response = await sendAuthenticationRequest(
      transport,
      'token',
      metadata.tokenEndpoint,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      },
      {
        target: "Keycloak's token endpoint",
        networkFailure: (detail) =>
          `Keycloak's token endpoint could not be reached (${detail}); no governed request was sent.`,
      },
    );
    if (response.status !== 200) throw workloadTokenFailure(response.status, response.text);
    return parseWorkloadTokenResponse(
      parseJsonBody(response.text, 'Keycloak workload token response', 'token'),
    );
  }

  /** On publish: log safe diagnostics on the first state and on any authority change (field names only). */
  #noteAuthority(metadata: WorkloadBootstrapDocument): void {
    const previous = this.#lastMetadata;
    this.#lastMetadata = metadata;
    const summary =
      `contract v3, service account ${metadata.serviceAccountId}, ` +
      `activation ${metadata.activationVersion}, source ${metadata.identitySource}`;
    if (previous === null) {
      this.#options.logger.info(`OpenBox workload authentication ready (${summary})`);
      return;
    }
    const changed = AUTHORITY_FIELDS.filter((field) => previous[field] !== metadata[field]);
    if (changed.length > 0) {
      this.#options.logger.info(
        `OpenBox workload authority changed (${changed.join(', ')}); now ${summary}`,
      );
    }
  }
}

function parseJsonBody(text: string, what: string, stage: 'bootstrap' | 'token'): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new OpenBoxWorkloadAuthError(`${what} is invalid: body is not valid JSON.`, {
      stage,
      httpStatus: 200,
    });
  }
}
