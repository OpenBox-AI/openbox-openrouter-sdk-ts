/**
 * Hook handler functions: the lifecycle stages composed into the middleware.
 *
 * handle_before_agent / handle_after_agent / handle_wrap_model_call.
 */

import {
  applyPiiRedaction,
  baseEventFields,
  buildEvent,
  evaluate,
  extractGovernanceBlocked,
  extractLastUserMessage,
  extractPromptFromMessages,
  extractResponseMetadata,
  hasHumanTurn,
  sendOrphanClosure,
  Turn,
} from './hooks';
import { toErrorInfo } from './error-info';
import { pollApprovalOrHalt } from './hitl';
import {

  clearActivityAbort,
  getActivityAbortReason,
  hasActivityAbort,
  isActivityApproved,
  markActivityApproved,
  registerActivity,
  runWithActivity,
  unregisterActivity,
  unregisterWorkflow,
} from './span_processor';
import type { OpenBoxOpenRouterMiddleware } from './middleware';
import {
  GovernanceVerdictResponse,
  hexId,
  safeSerialize,
} from './types';
import { GovernanceHaltError, enforceVerdict, unwrapGovernanceError } from './verdict';

export interface AgentState {
  messages: unknown[];
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════
// handle_before_agent → WorkflowStarted + SignalReceived (enforced)
// ═══════════════════════════════════════════════════════════════════

export async function handleBeforeAgent(
  mw: OpenBoxOpenRouterMiddleware,
  state: AgentState,
  threadId: string = 'openrouter',
): Promise<Turn> {
  const minted = hexId(32);
  const turn: Turn = {
    workflowId: `${threadId}-${minted.slice(0, 8)}`,
    runId: `${threadId}-run-${minted.slice(8, 16)}`,
  };
  mw._client.updateTraceId(turn.workflowId);

  const messages = state.messages ?? [];

  // Everything below can throw (governance block/halt, or a hard API-error
  // failure now that auth/onApiError=fail_closed propagate instead of
  // silently swallowing). turn is minted above and never depends on any of
  // this succeeding, so attach it to any thrown error — the caller
  // (OpenBoxAgent.node.ts) needs it to still call afterAgent()/close the
  // workflow even when beforeAgent itself fails.
  try {
    // WorkflowStarted — identity only. Sent before SignalReceived so Core's
    // event ordering matches actual execution order.
    if (mw._config.sendChainStartEvent) {
      await evaluate(mw, buildEvent(mw, turn, 'WorkflowStarted', `${turn.runId}-wf`, mw._workflowType));
    }

    // SignalReceived — user prompt as trigger. Governed whenever there is a
    // human/user turn at all, regardless of whether the extracted text is
    // empty or multimodal — an empty/non-text first turn must still be
    // governed, not silently skipped.
    if (hasHumanTurn(messages)) {
      const userPrompt = extractLastUserMessage(messages) ?? '';
      const sigActivityId = `${turn.runId}-sig`;
      const response = await evaluate(mw, buildEvent(mw, turn, 'SignalReceived', sigActivityId, 'user_prompt', {
        signal_name: 'user_prompt',
        signal_args: [userPrompt],
      }));

      if (response != null) {
        try {
          const result = enforceVerdict(response, 'signal_received');
          if (result.requiresHitl) {
            await pollApprovalOrHalt(mw, turn, sigActivityId, 'user_prompt', result.approvalId);
          }
        } catch (err) {
          await sendOrphanClosure(mw, turn, 'ActivityCompleted', sigActivityId, 'user_prompt', err);
          throw err;
        }
      }
    }

    // LLMStarted pre-screen is intentionally deferred to handleWrapModelCall.
    // Sending LLMStarted here (before memory_load) would anchor the llm_call
    // activity to the before_agent timestamp, causing Core to display it before
    // the memory_load activity even though the model call happens after.
    // wrapModelCall sends LLMStarted at the correct time (after memory is loaded),
    // so all events arrive at Core in true execution order.
    return turn;
  } catch (err) {
    if (err != null && typeof err === 'object') {
      (err as Record<string, unknown>).__obTurn = turn;
    }
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════
// handle_after_agent → WorkflowCompleted
// ═══════════════════════════════════════════════════════════════════

export async function handleAfterAgent(
  mw: OpenBoxOpenRouterMiddleware,
  turn: Turn,
  state: AgentState,
  failedWith?: Error,
  extra?: Record<string, unknown>,
): Promise<GovernanceVerdictResponse | null> {
  if (!mw._config.sendChainEndEvent) return null;

  const messages = state.messages ?? [];
  let lastContent: unknown = null;
  if (messages.length > 0) {
    const lastMsg = messages[messages.length - 1] as Record<string, unknown>;
    lastContent = lastMsg?.content ?? null;
  }

  const output = safeSerialize({ result: lastContent });

  const verdict = await evaluate(mw, buildEvent(mw, turn, 'WorkflowCompleted', `${turn.runId}-wf`, mw._workflowType, {
    // `activity_output` is the key Core actually binds: its payload struct
    // (internal/content/governance.go) has ActivityOutput and no
    // workflow_output field at all, and setOptionalPayloadFields copies it
    // into the `output` column for EVERY event type, WorkflowCompleted
    // included. Sending only `workflow_output` meant the final answer was
    // dropped at unmarshal — which is why no WorkflowCompleted row in Core
    // has ever had an output.
    activity_output: output,
    // Kept alongside it: harmless to Core (unknown keys are ignored) and it
    // is the field name the other OpenBox SDKs emit, so anything reading the
    // raw event stream rather than the database still sees it.
    workflow_output: output,
    status: failedWith ? 'failed' : 'completed',
    ...(failedWith ? { error: toErrorInfo(failedWith) } : {}),
    ...(extra != null ? { extra } : {}),
  }));

  // Clean up any lingering activity registrations for this workflow.
  unregisterWorkflow(turn.workflowId);
  return verdict;
}

// ═══════════════════════════════════════════════════════════════════
// handle_wrap_model_call → LLMStarted → PII redact → Model → LLMCompleted
// ═══════════════════════════════════════════════════════════════════

export async function handleWrapModelCall(
  mw: OpenBoxOpenRouterMiddleware,
  turn: Turn,
  messages: unknown[],
  handler: () => Promise<unknown>,
): Promise<unknown> {
  // Use only the last human message as the governed prompt — extractPromptFromMessages
  // would join ALL human messages including chat history loaded from memory, producing
  // a concatenated blob of prior turns instead of the current user input.
  const promptText = extractLastUserMessage(messages) ?? extractPromptFromMessages(messages);

  const activityId = hexId(32);
  let startResponse: GovernanceVerdictResponse | null;
  const startMs = Date.now();

  if (mw._config.sendLlmStartEvent) {
    startResponse = await evaluate(mw, buildEvent(mw, turn, 'LLMStarted', activityId, 'llm_call', {
      activity_input: [{ prompt: promptText }],
      prompt: promptText,
    }));
  } else {
    startResponse = null;
  }

  // PII redaction — only apply when the returned text is a valid, non-null
  // coercion of Core's redacted_input. Redaction removes/replaces content; it
  // never expands it arbitrarily, so no length heuristic is applied here —
  // that heuristic previously caused legitimate (longer) redactions to be
  // silently skipped, leaking the raw prompt to the model provider.
  const guardrails = startResponse?.guardrails_result ?? startResponse?.guardrailsResult;
  if (guardrails?.input_type === 'activity_input' && guardrails.redacted_input != null) {
    applyPiiRedaction(messages, guardrails.redacted_input);
  }

  // Enforce LLMStarted verdict (block/halt throw; require_approval polls).
  // On a hard block/halt, close the orphaned llm_call row before rethrowing —
  // otherwise it's a "started, never completed" row on Core forever.
  if (startResponse != null) {
    try {
      const result = enforceVerdict(startResponse, 'llm_start');
      if (result.requiresHitl) {
        await pollApprovalOrHalt(mw, turn, activityId, 'llm_call', result.approvalId);
        markActivityApproved(activityId);
      }
    } catch (err) {
      if (mw._config.sendLlmEndEvent) {
        await sendOrphanClosure(mw, turn, 'LLMCompleted', activityId, 'llm_call', err);
      }
      throw err;
    }
  }

  // ── Layer 2: HTTP span collector. Patches Node.js https.request so the actual HTTP
  // call to the LLM provider is intercepted and its request/response bodies
  // are sent to Core as ActivityStarted + hook_trigger + http_request spans.
  const activityCtxBase = baseEventFields(mw, turn);
  registerActivity(
    activityId,
    {
      ...activityCtxBase,
      event_type: 'ActivityStarted',
      activity_id: activityId,
      activity_type: 'llm_call',
    },
    mw._client.transport,
    turn.workflowId,
    { hitl: mw._config.hitl, onApiError: mw._config.onApiError, logger: mw._config.logger, requestTimeoutMs: mw._config.governanceTimeout * 1000 },
  );

  // Call the model — https.request patch fires automatically
  let modelResponse: unknown;
  let llmWasApproved = false;
  try {
    while (true) {
      try {
        modelResponse = await runWithActivity(activityId, handler);
        // Some LLM clients swallow the completed-span abort internally (mirrors
        // the Wikipedia-tool case in handleWrapToolCall) — the hook still set the
        // abort flag before letting the response through, so check it here too.
        if (hasActivityAbort(activityId)) {
          await pollApprovalOrHalt(mw, turn, activityId, 'llm_call');
          markActivityApproved(activityId);
          clearActivityAbort(activityId);
          continue;
        }
        break;
      } catch (err) {
        const hookErr = extractGovernanceBlocked(err);
        if (hookErr?.verdict === 'require_approval') {
          await pollApprovalOrHalt(mw, turn, activityId, 'llm_call');
          markActivityApproved(activityId);
          clearActivityAbort(activityId);
          continue;
        }
        // A GovernanceHaltError/GovernanceBlockedError thrown inside the
        // patched fetch (e.g. a mid-call HTTP hook rejection) surfaces here
        // wrapped in whatever generic transport error the LLM client uses —
        // e.g. the OpenAI SDK wraps ANY fetch-throw as APIConnectionError
        // with the fixed message "Connection error.", burying our real
        // reason ("Activity rejected: ...") in `.cause`. Prefer the reason we
        // recorded ourselves at the moment of the abort (span_processor.ts's
        // abortAndThrow) — it's reliable regardless of how the client library
        // mangled the exception. Fall back to unwrapping the caught error's
        // cause chain, then to the raw error, only if nothing was recorded.
        const abortReasonText = getActivityAbortReason(activityId);
        const failure = abortReasonText != null
          ? new GovernanceHaltError(abortReasonText)
          : unwrapGovernanceError(err) ?? err;
        // A genuine (non-governance) model-call failure — close the llm_call
        // row instead of leaving it orphaned.
        if (mw._config.sendLlmEndEvent) {
          await sendOrphanClosure(mw, turn, 'LLMCompleted', activityId, 'llm_call', failure);
        }
        throw failure;
      }
    }
    // Capture BEFORE finally runs — unregisterActivity clears _approvedActivities.
    llmWasApproved = isActivityApproved(activityId);
  } finally {
    await unregisterActivity(activityId);
  }
  const endMs = Date.now();
  const duration_ms = endMs - startMs;

  // LLMCompleted — skip evaluate entirely when already approved to avoid
  // spurious approval requests on Core for the same activity_type. Reuses
  // the SAME activityId as LLMStarted — Core matches completions to starts
  // by activity_id; a different id produces an orphan Core discards.
  if (mw._config.sendLlmEndEvent && !llmWasApproved) {
    const meta = extractResponseMetadata(modelResponse);
    const resp = await evaluate(mw, buildEvent(mw, turn, 'LLMCompleted', activityId, 'llm_call', {
      status: 'completed',
      duration_ms,
      llm_model: meta.llm_model,
      input_tokens: meta.input_tokens,
      output_tokens: meta.output_tokens,
      total_tokens: meta.total_tokens,
      has_tool_calls: meta.has_tool_calls,
      completion: meta.completion,
    }));

    if (resp != null) {
      const endResult = enforceVerdict(resp, 'llm_end');
      if (endResult.requiresHitl) {
        await pollApprovalOrHalt(mw, turn, activityId, 'llm_call', endResult.approvalId);
      }
    }
  }

  return modelResponse;
}

// ═══════════════════════════════════════════════════════════════════
// handle_wrap_memory_op → scopes memory load/save so pg queries
// inside the memory node generate db_query spans on the dashboard.
// ═══════════════════════════════════════════════════════════════════

export async function handleWrapMemoryOp<T>(
  mw: OpenBoxOpenRouterMiddleware,
  turn: Turn,
  opType: 'load_memory' | 'save_context',
  fn: () => Promise<T>,
): Promise<T> {
  const activityId = hexId(32);
  const startMs = Date.now();

  // Send explicit ActivityStarted evaluate BEFORE registering the activity.
  // This creates an anchor node in Core's timeline so subsequent DB hook_triggers
  // (hook_trigger:true, stage:'started'|'completed') are grouped under it
  // instead of each creating their own ActivityStarted node. Mirrors how
  // LLMStarted anchors HTTP spans for llm_call activities.
  try {
    await evaluate(mw, buildEvent(mw, turn, 'ActivityStarted', activityId, opType));
  } catch { /* non-fatal */ }

  registerActivity(
    activityId,
    {
      ...baseEventFields(mw, turn),
      event_type: 'ActivityStarted',
      activity_id: activityId,
      activity_type: opType,
    },
    mw._client.transport,
    turn.workflowId,
    { hitl: mw._config.hitl, onApiError: mw._config.onApiError, logger: mw._config.logger, requestTimeoutMs: mw._config.governanceTimeout * 1000 },
  );

  // Capture result so ActivityCompleted can include activity_output.
  // The same activity_id is used for both ActivityStarted and
  // ActivityCompleted. Core matches
  // completions to their starts by activity_id; a different id (e.g. '-c' suffix)
  // produces an orphan that Core discards — the dashboard shows "started, never ended".
  // When fn() throws (e.g. a Postgres error), ActivityCompleted is still sent
  // from finally — with the correct id — so the activity never dangles.
  let status: 'completed' | 'failed' = 'completed';
  let errorInfo: ReturnType<typeof toErrorInfo> | undefined;
  let result: T | undefined;
  try {
    // DB spans evaluated during fn() (a memory load/save) can come back
    // require_approval — the DB hook swallows that internally so the query
    // completes normally, but flags the abort. Poll and retry here, mirroring
    // handleWrapToolCall's hasActivityAbort check, instead of letting the
    // approval requirement pass through unenforced.
    while (true) {
      try {
        result = await runWithActivity(activityId, fn);
        if (hasActivityAbort(activityId)) {
          await pollApprovalOrHalt(mw, turn, activityId, opType);
          clearActivityAbort(activityId);
          continue;
        }
        break;
      } catch (err) {
        const hookErr = extractGovernanceBlocked(err);
        if (hookErr?.verdict === 'require_approval') {
          await pollApprovalOrHalt(mw, turn, activityId, opType);
          clearActivityAbort(activityId);
          continue;
        }
        throw err;
      }
    }
    return result as T;
  } catch (err) {
    // Same rationale as handleWrapModelCall: a DB driver may wrap a thrown
    // GovernanceHaltError/GovernanceBlockedError in its own error type. Prefer
    // the reason recorded at the moment of the abort over the (possibly
    // mangled) caught error.
    const abortReasonText = getActivityAbortReason(activityId);
    const failure = abortReasonText != null
      ? new GovernanceHaltError(abortReasonText)
      : unwrapGovernanceError(err) ?? err;
    status = 'failed';
    errorInfo = toErrorInfo(failure);
    throw failure;
  } finally {
    await unregisterActivity(activityId);
    const completedEvent = buildEvent(mw, turn, 'ActivityCompleted', activityId, opType, {
      status,
      duration_ms: Date.now() - startMs,
      activity_output: status === 'completed' ? safeSerialize(result) : null,
      spans: [],
      span_count: 0,
      ...(errorInfo ? { error: errorInfo } : {}),
    });
    // Await ActivityCompleted so it arrives at Core before the caller proceeds
    // to the next lifecycle event (e.g. LLMStarted): lifecycle events must be
    // strictly ordered by arrival.
    try {
      await evaluate(mw, completedEvent);
    } catch { /* non-fatal */ }
  }
}
