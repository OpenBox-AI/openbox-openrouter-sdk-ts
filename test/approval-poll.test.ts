/**
 * Approval polling is keyed on (workflow_id, run_id, activity_id).
 *
 * Core finds a pending approval by those three ids and nothing else; an
 * `approval_id` on the verdict is metadata only. Polling with it in place of
 * the ids matches nothing, so the wait could never resolve.
 */

import { describe, expect, it } from 'vitest';

import { GovernanceClient, missingApprovalIds } from '../src/client';
import type { OpenBoxRequestOptions, OpenBoxTransport } from '../src/transport';

class RecordingTransport implements OpenBoxTransport {
  readonly bodies: unknown[] = [];

  async request<T>(options: OpenBoxRequestOptions): Promise<T> {
    this.bodies.push(options.body);
    return {} as T;
  }
}

describe('GovernanceClient.pollApproval', () => {
  it('polls with the correlation ids even when an approval_id is given', async () => {
    const transport = new RecordingTransport();
    const client = new GovernanceClient(transport, 'trace-1');

    await client.pollApproval('wf-1', 'run-1', 'act-1', 'appr_1');

    expect(transport.bodies).toEqual([
      { workflow_id: 'wf-1', run_id: 'run-1', activity_id: 'act-1' },
    ]);
  });

  it('polls with the same ids when no approval_id is given', async () => {
    const transport = new RecordingTransport();
    const client = new GovernanceClient(transport, 'trace-1');

    await client.pollApproval('wf-1', 'run-1', 'act-1');

    expect(transport.bodies).toEqual([
      { workflow_id: 'wf-1', run_id: 'run-1', activity_id: 'act-1' },
    ]);
  });
});

describe('missingApprovalIds', () => {
  it('is empty when all three ids are present', () => {
    expect(missingApprovalIds({ workflowId: 'wf', runId: 'run', activityId: 'act' })).toEqual([]);
  });

  it('names every id that is missing or empty', () => {
    expect(missingApprovalIds({ workflowId: '', runId: null, activityId: undefined })).toEqual([
      'workflow_id',
      'run_id',
      'activity_id',
    ]);
    expect(missingApprovalIds({ workflowId: 'wf', runId: 'run', activityId: '' })).toEqual([
      'activity_id',
    ]);
  });
});
