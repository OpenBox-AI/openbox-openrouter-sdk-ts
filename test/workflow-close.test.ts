/**
 * WorkflowCompleted must carry the agent's final answer.
 *
 * SessionEnd fires while the engine is still unwinding — strictly before
 * `getText()` resolves — so closing the workflow there sent `{result: null}`
 * on every run. The close is now driven by whichever finishes last, the
 * engine or the reader.
 */

import { describe, expect, it } from 'vitest';

import { createOpenBoxGovernance } from '../src/openrouter';
import type { OpenBoxRequestOptions, OpenBoxTransport } from '../src/transport';
import type { OpenBoxGovernanceEvent } from '../src/types';

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

function governance(transport: OpenBoxTransport) {
  return createOpenBoxGovernance({
    transport,
    agentName: 'close-test',
    instrumentHttp: false,
    instrumentDatabases: false,
    instrumentFileIo: false,
    logger: { warn: () => undefined },
  });
}

/**
 * Engine stand-in that reproduces the real ordering: SessionEnd is emitted
 * during the run, and the result resolves afterwards.
 */
function engine(answer: string, opts: { stream?: boolean } = {}) {
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
        await fire('SessionEnd', { reason: 'complete' });
        return answer;
      },
      getTextStream() {
        return (async function* () {
          for (const ch of answer.split(' ')) yield `${ch} `;
          await fire('SessionEnd', { reason: 'complete' });
        })();
      },
    };
  };
}

describe('WorkflowCompleted output', () => {
  it('carries the final answer when consumed with getText()', async () => {
    const transport = new RecordingTransport();
    const openbox = governance(transport);

    const result = await openbox.callModel(engine('order A-1003 refunded'), {}, {
      model: 'm', input: 'refund it',
    });
    const text = await (result as { getText(): Promise<string> }).getText();

    expect(text).toBe('order A-1003 refunded');
    expect(transport.completed()?.workflow_output).toEqual({
      result: 'order A-1003 refunded',
    });
  });

  it('is not emitted before the reader has the answer', async () => {
    const transport = new RecordingTransport();
    const openbox = governance(transport);

    const result = await openbox.callModel(engine('done'), {}, { model: 'm', input: 'x' });
    // SessionEnd has not fired yet — nothing consumed the result.
    expect(transport.completed()).toBeUndefined();

    await (result as { getText(): Promise<string> }).getText();
    expect(transport.completed()).toBeDefined();
  });

  it('accumulates a streamed answer', async () => {
    const transport = new RecordingTransport();
    const openbox = governance(transport);

    const result = await openbox.callModel(engine('refund issued', { stream: true }), {}, {
      model: 'm', input: 'x',
    });

    let out = '';
    for await (const c of (result as { getTextStream(): AsyncIterable<string> }).getTextStream()) {
      out += c;
    }

    expect(out).toBe('refund issued ');
    expect(transport.completed()?.workflow_output).toEqual({ result: 'refund issued ' });
  });

  it('closes exactly once, even with close() called after a full read', async () => {
    const transport = new RecordingTransport();
    const openbox = governance(transport);

    const result = await openbox.callModel(engine('hi'), {}, { model: 'm', input: 'x' });
    await (result as { getText(): Promise<string> }).getText();
    await openbox.close();

    const completions = transport.events.filter((e) => e.event_type === 'WorkflowCompleted');
    expect(completions).toHaveLength(1);
  });

  it('close() still closes a run that was never consumed', async () => {
    const transport = new RecordingTransport();
    const openbox = governance(transport);

    await openbox.callModel(engine('never read'), {}, { model: 'm', input: 'x' });
    expect(transport.completed()).toBeUndefined();

    await openbox.close();
    const completed = transport.completed();
    expect(completed).toBeDefined();
    expect(completed?.status).toBe('failed');
  });
});
