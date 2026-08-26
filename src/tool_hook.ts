/**
 * Tool governance hook: ToolStarted → execute → ToolCompleted.
 *
 * handle_wrap_tool_call: ToolStarted → execute tool → ToolCompleted.
 */

import { baseEventFields, buildEvent, evaluate, extractGovernanceBlocked, sendOrphanClosure, Turn } from './hooks';
import { toErrorInfo } from './error-info';
import {
  clearActivityAbort,
  getActivityAbortReason,
  hasActivityAbort,
  isActivityApproved,
  markActivityApproved,
  registerActivity,
  runWithActivity,
  unregisterActivity,
} from './span_processor';
import { pollApprovalOrHalt } from './hitl';
import type { OpenBoxOpenRouterMiddleware } from './middleware';
import { hexId, safeSerialize } from './types';
import { GovernanceBlockedError, GovernanceHaltError, enforceVerdict, unwrapGovernanceError } from './verdict';

export async function handleWrapToolCall(
  mw: OpenBoxOpenRouterMiddleware,
  turn: Turn,
  toolName: string,
  toolArgs: unknown,
  handler: () => Promise<unknown>,
): Promise<unknown> {
  // Skip governance for excluded tools (mirrors skip_tool_types config)
  if (mw._config.skipToolTypes.has(toolName)) {
    return handler();
  }

  const activityId = hexId(32);
  const toolType = mw._config.toolTypeMap[toolName];
  const startMs = Date.now();

  // ── ToolStarted ──────────────────────────────────────────────────────────────
  // registerActivity is called AFTER this evaluate (mirrors handleWrapModelCall).
  // Registering before the evaluate would put the activity in _activeActivities
  // while the HTTP request for the evaluate call fires — patchedFetch would then
  // capture that request as a hook span for the tool activity, sending a second
  // governance event to Core and creating a duplicate approval request.
  if (mw._config.sendToolStartEvent) {
    const response = await evaluate(mw, buildEvent(mw, turn, 'ToolStarted', activityId, toolName, {
      activity_input: [safeSerialize(toolArgs)],
      tool_name: toolName,
      tool_type: toolType,
    }));

    if (response != null) {
      try {
        const result = enforceVerdict(response, 'tool_start');
        if (result.requiresHitl) {
          await pollApprovalOrHalt(mw, turn, activityId, toolName, result.approvalId);
          markActivityApproved(activityId);
          clearActivityAbort(activityId);
        }
      } catch (err) {
        // A hard block/halt at tool-start previously threw here with no
        // completion event sent at all — a true orphan on Core. Close it
        // with the same activity id before rethrowing.
        if (mw._config.sendToolEndEvent) {
          await sendOrphanClosure(mw, turn, 'ToolCompleted', activityId, toolName, err);
        }
        throw err;
      }
    }
  }

  registerActivity(
    activityId,
    {
      ...baseEventFields(mw, turn),
      event_type: 'ActivityStarted',
      activity_id: activityId,
      activity_type: toolName,
    },
    mw._client.transport,
    turn.workflowId,
    { hitl: mw._config.hitl, onApiError: mw._config.onApiError, logger: mw._config.logger, requestTimeoutMs: mw._config.governanceTimeout * 1000 },
  );

  // ── Execute tool ─────────────────────────────────────────────────────────────
  let toolResult: unknown;
  // Capture approval state before unregisterActivity clears it in the finally block.
  let wasApproved = false;
  try {
    while (true) {
      try {
        toolResult = await runWithActivity(activityId, handler);
        // Some tools catch HTTP errors internally and
        // return them as strings rather than throwing. The hook still set the abort
        // flag before throwing — check it here so approval is triggered even when
        // the GovernanceBlockedError never propagated to this catch block.
        if (hasActivityAbort(activityId)) {
          await pollApprovalOrHalt(mw, turn, activityId, toolName);
          markActivityApproved(activityId);
          clearActivityAbort(activityId);
          continue;
        }
        break;
      } catch (err) {
        const hookErr =
          err instanceof GovernanceBlockedError ? err : extractGovernanceBlocked(err);
        if (hookErr?.verdict === 'require_approval') {
          await pollApprovalOrHalt(mw, turn, activityId, toolName);
          markActivityApproved(activityId);
          clearActivityAbort(activityId);
          continue;
        }

        // A GovernanceHaltError/GovernanceBlockedError thrown inside the
        // patched fetch/http/db layer during tool execution can surface here
        // wrapped in whatever generic transport error the tool's own HTTP
        // client uses (e.g. a fetch-based client wrapping any thrown error as
        // a generic "connection error"), burying the real reason in `.cause`.
        // Prefer the reason recorded at the moment of the abort
        // (span_processor.ts's abortAndThrow) — reliable regardless of how
        // the client mangled the exception. Fall back to unwrapping the
        // caught error's cause chain, then to the raw error.
        const abortReasonText = getActivityAbortReason(activityId);
        const failure = abortReasonText != null
          ? new GovernanceHaltError(abortReasonText)
          : unwrapGovernanceError(err) ?? err;

        const failEndMs = Date.now();
        if (mw._config.sendToolEndEvent && !isActivityApproved(activityId)) {
          await evaluate(mw, buildEvent(mw, turn, 'ToolCompleted', activityId, toolName, {
            activity_output: safeSerialize({ error: toErrorInfo(failure) }),
            tool_name: toolName,
            tool_type: toolType,
            status: 'failed',
            duration_ms: failEndMs - startMs,
            error: toErrorInfo(failure),
          }));
        }
        throw failure;
      }
    }
    // Capture BEFORE finally runs — unregisterActivity clears _approvedActivities.
    wasApproved = isActivityApproved(activityId);
  } finally {
    await unregisterActivity(activityId);
  }

  const endMs = Date.now();
  const duration_ms = endMs - startMs;

  // ── ToolCompleted ─────────────────────────────────────────────────────────────
  if (mw._config.sendToolEndEvent) {
    // String results wrapped as {result: ...}, non-strings serialized directly
    const serializedOutput =
      typeof toolResult === 'string'
        ? safeSerialize({ result: toolResult })
        : safeSerialize(toolResult);

    // Always send ToolCompleted so Core can show the completion on the dashboard.
    // Reuses the SAME activityId as ToolStarted — Core matches completions to
    // starts by activity_id; a different id produces an orphan Core discards.
    // When wasApproved=true (ToolStarted already required+received human approval),
    // send the event but skip verdict enforcement — enforcing it would trigger a
    // second governance evaluation and create a spurious approval row on Core.
    // Use wasApproved (captured before finally) because unregisterActivity already
    // cleared _approvedActivities by the time we reach here.
    const resp = await evaluate(mw, buildEvent(mw, turn, 'ToolCompleted', activityId, toolName, {
      activity_output: serializedOutput,
      tool_name: toolName,
      tool_type: toolType,
      status: 'completed',
      duration_ms,
    }));

    if (resp != null && !wasApproved) {
      const result = enforceVerdict(resp, 'tool_end');
      if (result.requiresHitl) {
        await pollApprovalOrHalt(mw, turn, activityId, toolName, result.approvalId);
      }
    }
  }

  return toolResult;
}
