import type { OpenBoxOpenRouterMiddleware } from './middleware';
import type { Turn } from './hooks';
import {
  GovernanceHaltError,
  formatActivityRejectedMessage,
  patchFrom,
  verdictFromString,
  withPatchHint,
} from './verdict';

const _timersMod = 'timers';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setTimeout: _setTimeout } = require(_timersMod) as typeof import('timers');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => _setTimeout(resolve, ms));
}

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

  const timeoutMs = mw._config.hitl.timeoutMs;
  const startedAt = Date.now();
  while (timeoutMs == null || Date.now() - startedAt <= timeoutMs) {
    const response = await mw._client.pollApproval(
      turn.workflowId,
      turn.runId,
      activityId,
      approvalId,
      mw._config.onApiError,
    );
    if (response == null) {
      await sleep(mw._config.hitl.pollIntervalMs);
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
      await sleep(mw._config.hitl.pollIntervalMs);
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

    await sleep(mw._config.hitl.pollIntervalMs);
  }

  throw new GovernanceHaltError(
    `Approval timed out for activity ${activityType} (workflow_id=${turn.workflowId}, run_id=${turn.runId}, activity_id=${activityId})`,
  );
}
