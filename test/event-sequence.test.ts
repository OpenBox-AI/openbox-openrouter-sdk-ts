/**
 * The timeline must be unambiguous. Core orders a session by the timestamp the
 * SDK stamps, so ties (a parallel tool round emitting three ActivityStarted in
 * the same millisecond) or a backwards clock step produce a nonsensical
 * rendering — a tool completing before the one before it started.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EventSequencer,
  findSequenceViolations,
  isMonotonic,
  resetSequencers,
} from '../src/event-sequence';
import { createOpenBoxGovernance } from '../src/openrouter';
import type { OpenBoxRequestOptions, OpenBoxTransport } from '../src/transport';
import type { OpenBoxGovernanceEvent } from '../src/types';

const ev = (event_type: string, activity_id: string, activity_type = 'x') =>
  ({ event_type, activity_id, activity_type }) as OpenBoxGovernanceEvent;

beforeEach(() => resetSequencers());

describe('EventSequencer.stamp', () => {
  it('gives strictly increasing timestamps even when the clock stands still', () => {
    // Three events in the same millisecond — exactly the parallel tool round.
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const s = new EventSequencer();
    const out = [
      s.stamp(ev('ActivityStarted', 'a')),
      s.stamp(ev('ActivityStarted', 'b')),
      s.stamp(ev('ActivityStarted', 'c')),
    ];
    vi.restoreAllMocks();

    const times = out.map((e) => Date.parse(String(e.timestamp)));
    expect(times[1]).toBeGreaterThan(times[0]);
    expect(times[2]).toBeGreaterThan(times[1]);
    expect(out.map((e) => e.sequence)).toEqual([1, 2, 3]);
  });

  it('does not go backwards when the clock does', () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(1_700_000_010_000); // then NTP steps back
    now.mockReturnValueOnce(1_700_000_005_000);
    const s = new EventSequencer();
    const first = s.stamp(ev('ActivityStarted', 'a'));
    const second = s.stamp(ev('ActivityCompleted', 'a'));
    vi.restoreAllMocks();

    expect(Date.parse(String(second.timestamp))).toBeGreaterThan(
      Date.parse(String(first.timestamp)),
    );
  });

  it('numbers concurrent runs independently', () => {
    const a = new EventSequencer();
    const b = new EventSequencer();
    a.stamp(ev('WorkflowStarted', 'wf-a'));
    b.stamp(ev('WorkflowStarted', 'wf-b'));
    expect(a.stamp(ev('ActivityStarted', 'a')).sequence).toBe(2);
    expect(b.stamp(ev('ActivityStarted', 'b')).sequence).toBe(2);
  });
});

describe('EventSequencer.check', () => {
  it('flags a completion with no matching start', () => {
    const s = new EventSequencer();
    s.stamp(ev('WorkflowStarted', 'wf'));
    expect(s.check(ev('ActivityCompleted', 'ghost'))).toMatchObject({
      kind: 'completed_without_started',
    });
  });

  it('flags a second completion for the same activity', () => {
    const s = new EventSequencer();
    s.stamp(ev('WorkflowStarted', 'wf'));
    s.stamp(ev('ActivityStarted', 'a'));
    s.stamp(ev('ActivityCompleted', 'a'));
    expect(s.check(ev('ActivityCompleted', 'a'))).toMatchObject({ kind: 'duplicate_completion' });
  });

  it('flags anything emitted after the workflow closed', () => {
    const s = new EventSequencer();
    s.stamp(ev('WorkflowStarted', 'wf'));
    s.stamp(ev('WorkflowCompleted', 'wf'));
    expect(s.check(ev('ActivityStarted', 'late'))).toMatchObject({
      kind: 'event_after_workflow_completed',
    });
  });

  it('accepts a correct run, including a parallel tool round', () => {
    const s = new EventSequencer();
    const run = [
      ev('WorkflowStarted', 'wf'),
      ev('SignalReceived', 'sig'),
      ev('LLMStarted', 'llm1'),
      ev('LLMCompleted', 'llm1'),
      ev('ToolStarted', 't1'),
      ev('ToolStarted', 't2'),
      ev('ToolCompleted', 't2'), // completes out of start order — legal
      ev('ToolCompleted', 't1'),
      ev('LLMStarted', 'llm2'),
      ev('LLMCompleted', 'llm2'),
      ev('WorkflowCompleted', 'wf'),
    ];
    for (const e of run) {
      expect(s.check(e)).toBeNull();
      s.stamp(e);
    }
  });

  it('reports every dangling activity when a run is cut short', () => {
    const s = new EventSequencer();
    s.stamp(ev('WorkflowStarted', 'wf'));
    s.stamp(ev('ToolStarted', 't1'));
    s.stamp(ev('LLMStarted', 'llm1'));
    s.stamp(ev('ToolCompleted', 't1'));
    expect(s.danglingActivities()).toEqual(['llm1']);
  });
});

describe('findSequenceViolations — for auditing a session read back from Core', () => {
  it('returns nothing for a well-formed run', () => {
    expect(
      findSequenceViolations([
        ev('WorkflowStarted', 'wf'),
        ev('ActivityStarted', 'a'),
        ev('ActivityCompleted', 'a'),
        ev('WorkflowCompleted', 'wf'),
      ]),
    ).toEqual([]);
  });

  it('names the specific defect in a broken one', () => {
    const found = findSequenceViolations([
      ev('WorkflowStarted', 'wf'),
      ev('ActivityCompleted', 'a', 'llm_call'),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: 'completed_without_started', activityType: 'llm_call' });
  });
});

describe('end to end through buildEvent', () => {
  it('stamps every event of a real run monotonically', async () => {
    const events: OpenBoxGovernanceEvent[] = [];
    const transport: OpenBoxTransport = {
      async request(options: OpenBoxRequestOptions) {
        const body = (options.body ?? {}) as Record<string, unknown>;
        if (options.path.endsWith('/evaluate') && body.hook_trigger !== true) {
          events.push(body as unknown as OpenBoxGovernanceEvent);
        }
        return { arm: 'allow' } as never;
      },
    };

    const openbox = createOpenBoxGovernance({
      transport, agentName: 'seq', instrumentHttp: false,
      instrumentDatabases: false, instrumentFileIo: false,
      logger: { warn: () => undefined },
    });

    await openbox.callModel(
      async (_c: unknown, request: Record<string, unknown>) => {
        const hooks = request.hooks as Record<string, Array<{ handler: Function }>>;
        const ctx = { signal: new AbortController().signal, hookName: '', sessionId: 's' };
        const fire = async (n: string, p: unknown) => {
          for (const e of hooks[n] ?? []) await e.handler(p, ctx);
        };
        const model = (turnNumber: number) =>
          fire('PostModelCall', {
            sessionId: 's', responseId: `r${turnNumber}`, model: 'm',
            durationMs: 1, turnType: 'initial', turnNumber,
          });
        await model(1);
        // Parallel round: both starts land in the same tick.
        await fire('PreToolUse', { toolName: 'alpha', toolInput: {} });
        await fire('PreToolUse', { toolName: 'beta', toolInput: {} });
        await fire('PostToolUse', { toolName: 'beta', toolInput: {}, toolOutput: 'b', durationMs: 1 });
        await fire('PostToolUse', { toolName: 'alpha', toolInput: {}, toolOutput: 'a', durationMs: 1 });
        await model(2);
        await fire('SessionEnd', { reason: 'complete' });
        return {};
      },
      {}, { model: 'm', input: 'hi' },
    );

    expect(events.length).toBeGreaterThan(6);
    expect(isMonotonic(events)).toBe(true);
    expect(findSequenceViolations(events)).toEqual([]);
  });
});
