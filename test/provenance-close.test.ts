/**
 * A run whose routing provenance is still being collected.
 *
 * The close drains provenance before WorkflowCompleted, because Core refuses
 * events for a session that has closed. With OpenRouter taking minutes to
 * publish the record, that drain must not sit between the caller and the
 * answer: the read resolves, the session stays open, and `close()` is what
 * waits for the evidence and then closes it.
 */

import { describe, expect, it, vi } from 'vitest';

import type { OpenBoxRequestOptions, OpenBoxTransport } from '../src/transport';
import type { OpenBoxGovernanceEvent } from '../src/types';

const evidence = vi.hoisted(() => {
  let release: () => void = () => undefined;
  const state = {
    pending: false,
    drained: Promise.resolve(),
    hold() {
      state.pending = true;
      state.drained = new Promise<void>((resolve) => {
        release = () => {
          state.pending = false;
          resolve();
        };
      });
    },
    release: () => release(),
  };
  return state;
});

vi.mock('../src/span_processor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/span_processor')>();
  return {
    ...actual,
    routingAttestationsPending: () => evidence.pending,
    drainRoutingAttestations: async () => {
      await evidence.drained;
      return [];
    },
  };
});

const { createOpenBoxGovernance } = await import('../src/openrouter');

class RecordingTransport implements OpenBoxTransport {
  readonly events: OpenBoxGovernanceEvent[] = [];
  async request<T>(options: OpenBoxRequestOptions): Promise<T> {
    const body = (options.body ?? {}) as Record<string, unknown>;
    if (options.path.endsWith('/evaluate') && body.hook_trigger !== true) {
      this.events.push(body as unknown as OpenBoxGovernanceEvent);
    }
    return { arm: 'allow' } as never;
  }
  completed(): OpenBoxGovernanceEvent | undefined {
    return this.events.find((e) => e.event_type === 'WorkflowCompleted');
  }
}

function engine(answer: string) {
  return async (_c: unknown, request: Record<string, unknown>) => {
    const hooks = request.hooks as Record<string, Array<{ handler: Function }>>;
    const ctx = { signal: new AbortController().signal, hookName: '', sessionId: 's1' };
    const fire = async (n: string, p: unknown) => {
      for (const e of hooks[n] ?? []) await e.handler(p, ctx);
    };
    return {
      async getText() {
        await fire('PostModelCall', {
          sessionId: 's1', responseId: 'r1', model: 'm',
          durationMs: 5, turnType: 'final', turnNumber: 1,
        });
        // The model call is done; its generation record is not published yet.
        evidence.hold();
        await fire('SessionEnd', { reason: 'complete' });
        return answer;
      },
    };
  };
}

describe('closing a run while its provenance is pending', () => {
  it('hands the caller the answer without waiting for the record', async () => {
    const transport = new RecordingTransport();
    const openbox = createOpenBoxGovernance({
      transport,
      agentName: 'provenance-close-test',
      instrumentHttp: false,
      instrumentDatabases: false,
      instrumentFileIo: false,
      logger: { warn: () => undefined },
    });

    const result = await openbox.callModel(engine('order shipped'), {}, { model: 'm', input: 'x' });
    const text = await (result as { getText(): Promise<string> }).getText();

    // The read resolved; the session is still open, waiting on the evidence.
    expect(text).toBe('order shipped');
    expect(transport.completed()).toBeUndefined();

    const closing = openbox.close();
    await new Promise((r) => setTimeout(r, 10));
    expect(transport.completed()).toBeUndefined();

    // The record lands: the session closes, with the answer.
    evidence.release();
    await closing;
    expect(transport.completed()?.workflow_output).toEqual({ result: 'order shipped' });
  });
});
