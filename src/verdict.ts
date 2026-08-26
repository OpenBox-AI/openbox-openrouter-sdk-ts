/**
 * Verdict enforcement — TypeScript port of openbox_langgraph/verdict_handler.py.
 *
 * enforce_verdict() maps governance verdict arms to exceptions. The Python SDK
 * also has GovernanceBlockedError for OTel hook-level blocks; we include it
 * here for structural completeness even though n8n skips the OTel layer.
 */

import { GovernancePatch, GovernanceVerdictResponse, VerdictArm } from './types';

export class GovernanceHaltError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GovernanceHaltError';
  }
}

export class GovernanceBlockedError extends Error {
  verdict: VerdictArm;
  /**
   * The remediation directive Core sent with this block, if any — the whole
   * point of which is that something downstream can act on it. Core validates
   * it and sends it on the verdict; before this it was read by nothing here,
   * so an agent blocked with "retry with the capped amount" told its user to
   * contact support instead.
   */
  patch: GovernancePatch | null;
  constructor(verdict: VerdictArm, message: string, patch: GovernancePatch | null = null) {
    super(message);
    this.name = 'GovernanceBlockedError';
    this.verdict = verdict;
    this.patch = patch;
  }
}

/**
 * Read a patch off a verdict or approval-poll response, if it carries a usable
 * one. Core has already validated the shape; this only guards against a body
 * that is not an object at all, so a malformed field degrades to "no
 * directive" exactly as it does on Core.
 */
export function patchFrom(response: { patch?: unknown } | null | undefined): GovernancePatch | null {
  const patch = response?.patch;
  if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) return null;
  return patch as GovernancePatch;
}

/**
 * Append the policy's suggested input to a block message.
 *
 * The message is what reaches the model when a governed tool is blocked, so
 * this is what lets an agent act on the directive: the model sees the
 * suggestion and may retry — and that retry is governed again like any other
 * call. The SDK never applies the patch itself. Silently re-running a
 * money-moving tool with arguments the caller never wrote is not a decision
 * an observability layer gets to make; re-evaluating a model's own retry is
 * the loop the directive was designed for.
 */
export function withPatchHint(message: string, patch: GovernancePatch | null): string {
  if (patch == null || !('new_input' in patch)) return message;
  let suggestion: string;
  try {
    suggestion = JSON.stringify(patch.new_input);
  } catch {
    return message;
  }
  if (suggestion === undefined) return message;
  return `${message} — policy suggests retrying with: ${suggestion}`;
}

export class GuardrailsValidationError extends Error {
  reasons: string[];
  constructor(reasons: string[]) {
    super(reasons.length > 0 ? reasons.join('; ') : 'Guardrails validation failed');
    this.name = 'GuardrailsValidationError';
    this.reasons = reasons;
  }
}

export type GovernanceError = GovernanceHaltError | GovernanceBlockedError | GuardrailsValidationError;

/**
 * Recover one of our own governance errors from anywhere in an error's cause
 * chain. Needed because a GovernanceHaltError/GovernanceBlockedError thrown
 * *inside* a patched fetch (e.g. when a mid-call HTTP hook evaluation gets
 * rejected) surfaces to the caller through whatever HTTP client library made
 * that call — and most Node HTTP clients (the OpenAI SDK included) catch
 * ANY error their fetch implementation throws and wrap it in a generic
 * transport error (e.g. `APIConnectionError` with the fixed message
 * "Connection error."), stashing the real cause in `.cause`. Without
 * unwrapping, both the error surfaced to the user AND the closure telemetry
 * sent to Core would show "Connection error." instead of the real reason
 * (e.g. "Activity rejected: ..."). Mirrors extractGovernanceBlocked's cause-
 * chain walk but recognizes all three governance error types, not just
 * GovernanceBlockedError.
 */
export function unwrapGovernanceError(err: unknown): GovernanceError | null {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current != null && !seen.has(current)) {
    seen.add(current);
    if (
      current instanceof GovernanceHaltError ||
      current instanceof GovernanceBlockedError ||
      current instanceof GuardrailsValidationError
    ) {
      return current;
    }
    if (typeof current === 'object') {
      const record = current as Record<string, unknown>;
      current = record.cause ?? record.context;
    } else {
      current = null;
    }
  }
  return null;
}

/**
 * Format the "a human rejected this activity" message. Previously each poll
 * loop built this inline as `Activity rejected: ${response.reason ?? 'Activity
 * rejected'}`, which — whenever Core didn't send a reason — produced the
 * redundant "Activity rejected: Activity rejected".
 */
export function formatActivityRejectedMessage(reason?: string | null): string {
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  return trimmed ? `Activity rejected: ${trimmed}` : 'Activity rejected (no reason provided)';
}

export interface VerdictResult {
  /** True when arm === 'require_approval' and the caller should poll. */
  requiresHitl: boolean;
  /** Core-assigned approval ID — use this for polling, not the local activityId. */
  approvalId?: string;
}

/**
 * enforce_verdict(response, phase) — direct port.
 *
 * Throws GovernanceHaltError/GovernanceBlockedError on halt/block.
 * Returns VerdictResult({ requiresHitl: true }) on require_approval.
 * Returns VerdictResult({ requiresHitl: false }) on allow/monitor/constrain.
 */
export function enforceVerdict(
  response: GovernanceVerdictResponse,
  phase: string,
): VerdictResult {
  const arm = verdictFromString(response.arm ?? response.verdict);

  if (arm === 'halt') {
    throw new GovernanceHaltError(
      `OpenBox governance halt at ${phase}: ${response.reason ?? 'halted by policy'}`,
    );
  }
  if (arm === 'block') {
    const patch = patchFrom(response);
    throw new GovernanceBlockedError(
      'block',
      withPatchHint(
        `OpenBox governance block at ${phase}: ${response.reason ?? 'blocked by policy'}`,
        patch,
      ),
      patch,
    );
  }

  const guardrails = response.guardrails_result ?? response.guardrailsResult;
  if (guardrails && guardrails.validation_passed === false) {
    const reasons = Array.isArray(guardrails.reasons)
      ? guardrails.reasons
        .map((r) => r.reason)
        .filter((r): r is string => typeof r === 'string' && r.length > 0)
      : [];
    throw new GuardrailsValidationError(reasons);
  }

  if (arm === 'require_approval') {
    const approvalId = response.approval_id ?? response.approvalId ?? response.id;
    return { requiresHitl: true, approvalId };
  }

  return { requiresHitl: false };
}

export function verdictFromString(value: unknown): VerdictArm {
  if (typeof value !== 'string') return 'allow';
  const normalized = value.toLowerCase().replace(/-/g, '_');
  if (normalized === 'continue') return 'allow';
  if (normalized === 'stop') return 'halt';
  if (normalized === 'request_approval') return 'require_approval';
  if (
    normalized === 'allow' ||
    normalized === 'monitor' ||
    normalized === 'constrain' ||
    normalized === 'block' ||
    normalized === 'halt' ||
    normalized === 'require_approval'
  ) {
    return normalized;
  }
  return 'allow';
}
