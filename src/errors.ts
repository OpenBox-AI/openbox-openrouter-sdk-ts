/**
 * Error types shared by the transport and the identity modules. Kept in a leaf
 * module so the identity code can extend them without importing the transport.
 */

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

/**
 * Core answered, but not with anything the contract allows — on IAM v3, a
 * redirect or a non-retryable 4xx. Never an outage: it hard-fails under every
 * `onApiError`, so a broken contract can never become "run ungoverned".
 */
export class GovernanceContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GovernanceContractError';
  }
}

/**
 * A local identity misconfiguration — a malformed or undersized key, or
 * identity settings that contradict each other. Raised before any request is
 * sent, and never subject to `onApiError`.
 */
export class OpenBoxIdentityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenBoxIdentityConfigError';
  }
}

/** Where in the IAM v3 workload flow a failure happened. */
export type WorkloadAuthStage = 'bootstrap' | 'token' | 'runtime';

export interface OpenBoxWorkloadAuthErrorDetails {
  readonly stage: WorkloadAuthStage;
  /** HTTP status of the failing response; null for local, network or timeout failures. */
  readonly httpStatus?: number | null;
  /** Short machine code from Core (`reason_code`) or Keycloak (`error`), when present. */
  readonly reasonCode?: string | null;
}

/**
 * IAM v3 (`keycloak_workload`) authentication failure.
 *
 * It is a `GovernanceAuthError` on purpose: every stage of workload
 * authentication, including an acquisition that failed only because Core or
 * Keycloak was unreachable, fails closed under every `onApiError`. It is never
 * an outage that may become "run ungoverned", and never a reason to retry the
 * request on v1 or with the API key alone.
 *
 * Messages carry the stage, HTTP status and a short machine code only — never
 * an API key, private key, assertion, access token or raw provider response.
 */
export class OpenBoxWorkloadAuthError extends GovernanceAuthError {
  readonly stage: WorkloadAuthStage;
  readonly httpStatus: number | null;
  readonly reasonCode: string | null;

  constructor(message: string, details: OpenBoxWorkloadAuthErrorDetails) {
    super(message, details.httpStatus ?? 0, null);
    this.name = 'OpenBoxWorkloadAuthError';
    this.stage = details.stage;
    this.httpStatus = details.httpStatus ?? null;
    this.reasonCode = details.reasonCode ?? null;
  }
}
