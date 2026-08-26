/**
 * GovernanceClient — the typed calls this SDK makes to OpenBox Core.
 *
 * It holds an {@link OpenBoxTransport}, so a host that owns its own HTTP
 * stack can supply one and keep these calls inside its own plumbing.
 */

import type { OpenBoxTransport } from './transport';
import { SoftGovernanceError } from './transport';
import { GovernancePatch, GovernanceVerdictResponse, OpenBoxGovernanceEvent } from './types';

export type OnApiError = 'fail_open' | 'fail_closed';

/**
 * 
 *
 * The OpenBox Core API only accepts the Temporal SDK's canonical event types
 * (ActivityStarted, ActivityCompleted, WorkflowStarted, …). SDK-specific names
 * (LLMStarted, ToolStarted, …) are internal and must be translated before the
 * request hits the wire. The original name is preserved in
 * `metadata.sdk_event_type` so the dashboard can still distinguish LLM spans
 * from generic activity spans.
 */
function toServerEventType(event: OpenBoxGovernanceEvent): OpenBoxGovernanceEvent {
  const SDK_TO_SERVER: Record<string, string> = {
    LLMStarted: 'ActivityStarted',
    LLMCompleted: 'ActivityCompleted',
    ToolStarted: 'ActivityStarted',
    ToolCompleted: 'ActivityCompleted',
  };

  const serverType = SDK_TO_SERVER[event.event_type];
  if (!serverType) return event;

  return {
    ...event,
    event_type: serverType,
    metadata: {
      ...((event.metadata as Record<string, unknown> | undefined) ?? {}),
      sdk_event_type: event.event_type,
    },
  };
}

export interface ApprovalPollResponse {
  id?: string;
  /**
   * Remediation directive, returned by Core on a BLOCK decision
   * (`GetApprovalStatusByWorkflow` sends it only for that verdict).
   */
  patch?: GovernancePatch;
  arm?: string;
  verdict?: string;
  action?: string;
  reason?: string;
  approval_expiration_time?: string;
  approvalExpirationTime?: string;
  expired?: boolean;
  [key: string]: unknown;
}

export class GovernanceClient {
  private traceId: string;
  private readonly timeoutMs?: number;
  /**
   * Exposed so span_processor can post hook-level ActivityStarted events
   * through the same transport (one client, one transport, so hook spans and
   * governance client's httpx session).
   */
  readonly transport: OpenBoxTransport;

  constructor(transport: OpenBoxTransport, traceId: string, timeoutMs?: number) {
    this.transport = transport;
    this.traceId = traceId;
    this.timeoutMs = timeoutMs;
  }

  updateTraceId(traceId: string): void {
    this.traceId = traceId;
  }

  /**
   * evaluate_event() — POST a governance event and return the verdict.
   * Returns null on soft (network/other) failures when onApiError is
   * "fail_open" (the default) so callers can continue without governance
   * rather than crashing the run. When "fail_closed", the failure is rethrown
   * instead of silently degrading to ungoverned. Auth/signing failures
   * (GovernanceAuthError, not a SoftGovernanceError) always propagate
   * regardless of this setting.
   */
  async evaluateEvent(
    event: OpenBoxGovernanceEvent,
    onApiError: OnApiError = 'fail_open',
  ): Promise<GovernanceVerdictResponse | null> {
    try {
      return await this.transport.request<GovernanceVerdictResponse>({
        method: 'POST',
        path: '/api/v1/governance/evaluate',
        body: toServerEventType(event) as unknown as Record<string, unknown>,
        traceId: this.traceId,
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      if (err instanceof SoftGovernanceError && onApiError !== 'fail_closed') return null;
      throw err;
    }
  }

  /** poll_approval() — POST the HITL poll payload to Core. */
  async pollApproval(
    workflowId: string,
    runId: string,
    activityId: string,
    approvalId?: string,
    onApiError: OnApiError = 'fail_open',
  ): Promise<ApprovalPollResponse | null> {
    // If Core returned an approval_id in the evaluate response, use it as the
    // poll key (Core returns it on the verdict). Otherwise
    // fall back to the triple (workflow_id, run_id, activity_id).
    const pollKey = approvalId ?? activityId;
    const reqBody = approvalId
      ? { workflow_id: pollKey, run_id: pollKey, activity_id: pollKey }
      : { workflow_id: workflowId, run_id: runId, activity_id: activityId };
    try {
      const data = await this.transport.request<ApprovalPollResponse>({
        method: 'POST',
        path: '/api/v1/governance/approval',
        body: reqBody,
        traceId: this.traceId,
        timeoutMs: this.timeoutMs,
      });
      const expiration = data.approval_expiration_time ?? data.approvalExpirationTime;
      if (typeof expiration === 'string' && expiration.trim()) {
        const expiresAt = Date.parse(expiration);
        if (!Number.isNaN(expiresAt) && expiresAt < Date.now()) {
          return { ...data, expired: true };
        }
      }
      return data;
    } catch (err) {
      if (err instanceof SoftGovernanceError && onApiError !== 'fail_closed') return null;
      throw err;
    }
  }
}
