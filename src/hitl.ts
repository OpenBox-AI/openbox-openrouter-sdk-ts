import type { OpenBoxOpenRouterMiddleware } from './middleware';
import type { Turn } from './hooks';
import {
  GovernanceHaltError,
  formatActivityRejectedMessage,
  patchFrom,
  verdictFromString,
  withPatchHint,
} from './verdict';

import { ApprovalWaitAbortedError, sleepUnlessAborted } from './wait';

export async function pollApprovalOrHalt(
  mw: OpenBoxOpenRouterMiddleware,
  turn: Turn,
  activityId: string,
  activityType: string,
  approvalId?: string,
): Promise<void> {
  if (!mw._config.hitl.enabled) {
    throw new GovernanceHaltError(`Approval required for activity ${activityType}`);
  }

  const { timeoutMs, pollIntervalMs, abortSignal } = mw._config.hitl;
  // An abort fails safe — the held operation does not run — and is never
  // mistaken for a transient poll failure and retried.
  const aborted = () =>
    new GovernanceHaltError(
      `Approval wait aborted for activity ${activityType} (workflow_id=${turn.workflowId}, run_id=${turn.runId}, activity_id=${activityId}) — not running it`,
    );
  const sleep = async (ms: number) => {
    try {
      await sleepUnlessAborted(ms, abortSignal);
    } catch (err) {
      if (err instanceof ApprovalWaitAbortedError) throw aborted();
      throw err;
    }
  };

  const startedAt = Date.now();
  while (timeoutMs == null || Date.now() - startedAt <= timeoutMs) {
    if (abortSignal?.aborted) throw aborted();
    let response;
    try {
      response = await mw._client.pollApproval(
        turn.workflowId,
        turn.runId,
        activityId,
        approvalId,
        mw._config.onApiError,
        abortSignal,
      );
    } catch (err) {
      if (abortSignal?.aborted) throw aborted();
      throw err;
    }
    if (abortSignal?.aborted) throw aborted();
    if (response == null) {
      await sleep(pollIntervalMs);
      continue;
    }

    if (response.expired) {
      throw new GovernanceHaltError(
        `Approval expired for activity ${activityType} (workflow_id=${turn.workflowId}, run_id=${turn.runId}, activity_id=${activityId})`,
      );
    }

    // A response body with no arm/verdict/action field at all means Core
    // hasn't recorded a human decision yet (still pending) — NOT "allow".
    // verdictFromString(undefined) defaults to 'allow' (the correct default
    // for the initial governance-evaluate response, where an unset field
    // means "no restriction stated"), but reusing that default here would
    // resolve the poll loop on its very first tick, before anyone approved
    // anything. Only interpret a verdict once Core actually sent one.
    const rawVerdict = response.arm ?? response.verdict ?? response.action;
    if (typeof rawVerdict !== 'string' || rawVerdict.trim() === '') {
      await sleep(pollIntervalMs);
      continue;
    }

    const verdict = verdictFromString(rawVerdict);

    if (verdict === 'allow') return;
    if (verdict === 'block' || verdict === 'halt') {
      // A rejection stays terminal — a human said no, and that is not
      // something to retry around. The directive is still carried in the
      // message, because "denied, but this would have been allowed" is the
      // useful half of the answer for whoever reads the trail.
      throw new GovernanceHaltError(
        withPatchHint(formatActivityRejectedMessage(response.reason), patchFrom(response)),
      );
    }

    await sleep(pollIntervalMs);
  }

  throw new GovernanceHaltError(
    `Approval timed out for activity ${activityType} (workflow_id=${turn.workflowId}, run_id=${turn.runId}, activity_id=${activityId})`,
  );
}
