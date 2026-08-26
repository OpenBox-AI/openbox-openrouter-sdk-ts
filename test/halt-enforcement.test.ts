/**
 * A halt must actually stop the run.
 *
 * Found by running the SDK against a real Core with an OPA policy returning
 * STOP for a money-moving tool: the tool was stopped, but `@openrouter/agent`
 * caught the halt thrown from the tool body and reported it to the model as an
 * ordinary failed tool call, then logged (and ignored) the halt thrown from
 * the next hook — `HooksManager` runs handlers with `throwOnHandlerError`
 * false. The run continued and handed the caller a normal answer. Halt is the
 * arm that means "stop the agent", so that is the opposite of the contract.
 *
 * Enforcement therefore lives where the engine cannot swallow it: the
 * consumption boundary, the next provider request, and the run's closure.
 */

import { describe, expect, it } from 'vitest';

import { createOpenBoxGovernance } from '../src/openrouter';
import { GovernanceHaltError } from '../src/verdict';
import type { OpenBoxRequestOptions, OpenBoxTransport } from '../src/transport';
import type { OpenBoxGovernanceEvent } from '../src/types';

class Recorder implements OpenBoxTransport {
  readonly events: OpenBoxGovernanceEvent[] = [];
  /** Halt the named tool's start event; allow everything else. */
  haltTool: string | null = null;
  async request<T>(options: OpenBoxRequestOptions): Promise<T> {
    const body = (options.body ?? {}) as Record<string, unknown>;
    if (options.path.endsWith('/evaluate') && body.hook_trigger !== true) {
      this.events.push(body as unknown as OpenBoxGovernanceEvent);
      if (
        this.haltTool != null &&
        body.activity_type === this.haltTool &&
        body.event_type === 'ActivityStarted'
      ) {
        return { arm: 'halt', reason: `${this.haltTool} halts the run` } as unknown as T;
      }
    }
    return { arm: 'allow' } as unknown as T;
  }
  toolStarts(name: string) {
    return this.events.filter(
      (e) => e.activity_type === name && e.event_type === 'ActivityStarted',
    );
  }
  closings() {
    return this.events.filter((e) => e.event_type === 'WorkflowCompleted') as unknown as Array<
      Record<string, unknown>
    >;
  }
}

const base = (transport: OpenBoxTransport) => ({
  transport,
  agentName: 'halt-test',
  instrumentHttp: false,
  instrumentDatabases: false,
  instrumentFileIo: false,
  logger: { warn: () => undefined },
});

/** A tool in the wire shape `tool()` produces. */
function makeTool(name: string, onRun: () => void) {
  return {
    type: 'function',
    function: {
      name,
      execute: async () => {
        onRun();
        return { ok: true };
      },
    },
  };
}

/**
 * Engine stand-in: runs the wrapped tool the way the real engine does —
 * catching whatever the body throws and carrying on — then hands back a
 * ModelResult that resolves to a perfectly good answer.
 */
function engineThatSwallowsToolErrors(
  onToolError: (err: unknown) => void,
  finalText = 'refund processed',
) {
  return async (_c: unknown, request: Record<string, unknown>) => {
    const hooks = request.hooks as Record<string, Array<{ handler: Function }>>;
    const ctx = { signal: new AbortController().signal, hookName: '', sessionId: 's1' };
    const fire = async (name: string, payload: unknown) => {
      for (const e of hooks[name] ?? []) {
        // The engine logs a throwing handler and continues.
        try {
          await e.handler(payload, ctx);
        } catch { /* throwOnHandlerError is false */ }
      }
    };

    const tools = request.tools as Array<{ function: { name: string; execute: Function } }>;
    await fire('PostModelCall', {
      sessionId: 's1', responseId: 'r1', model: 'm', durationMs: 1,
      turnType: 'initial', turnNumber: 1,
    });
    for (const t of tools) {
      await fire('PreToolUse', { toolName: t.function.name, toolInput: {} });
      try {
        await t.function.execute({});
        await fire('PostToolUse', {
          toolName: t.function.name, toolInput: {}, toolOutput: 'ok', durationMs: 1,
        });
      } catch (err) {
        onToolError(err);
        await fire('PostToolUseFailure', { toolName: t.function.name, toolInput: {}, error: err });
      }
    }
    await fire('SessionEnd', { reason: 'completed' });
    return {
      async getText() { return finalText; },
      async *getTextStream() { yield finalText; },
    };
  };
}

describe('a halted run cannot hand the caller an answer', () => {
  it('rejects getText() with the halt instead of returning the model text', async () => {
    const transport = new Recorder();
    transport.haltTool = 'refund';
    const openbox = createOpenBoxGovernance(base(transport));

    let ran = false;
    const tools = openbox.tools([makeTool('refund', () => { ran = true; })]);

    const result = await openbox.callModel(
      engineThatSwallowsToolErrors(() => undefined),
      {},
      { model: 'm', input: 'refund it', tools },
    );

    await expect((result as { getText(): Promise<string> }).getText()).rejects.toThrow(
      GovernanceHaltError,
    );
    // The tool body itself never ran.
    expect(ran).toBe(false);
    await openbox.close();
  });

  it('stops a stream at the next pull rather than yielding the answer', async () => {
    const transport = new Recorder();
    transport.haltTool = 'refund';
    const openbox = createOpenBoxGovernance(base(transport));
    const tools = openbox.tools([makeTool('refund', () => undefined)]);

    const result = await openbox.callModel(
      engineThatSwallowsToolErrors(() => undefined),
      {},
      { model: 'm', input: 'refund it', tools },
    );

    const chunks: string[] = [];
    await expect(
      (async () => {
        for await (const c of (result as { getTextStream(): AsyncIterable<string> }).getTextStream()) {
          chunks.push(c);
        }
      })(),
    ).rejects.toThrow(GovernanceHaltError);
    expect(chunks).toEqual([]);
    await openbox.close();
  });

  it('closes the run as failed, carrying the halt reason', async () => {
    const transport = new Recorder();
    transport.haltTool = 'refund';
    const openbox = createOpenBoxGovernance(base(transport));
    const tools = openbox.tools([makeTool('refund', () => undefined)]);

    const result = await openbox.callModel(
      engineThatSwallowsToolErrors(() => undefined),
      {},
      { model: 'm', input: 'refund it', tools },
    );
    await (result as { getText(): Promise<string> }).getText().catch(() => undefined);
    await openbox.close();

    const closing = transport.closings().at(-1);
    expect(closing?.status).toBe('failed');
    expect(JSON.stringify(closing?.error)).toContain('halts the run');
  });

  it('asks Core once, however many times the engine retries the tool', async () => {
    const transport = new Recorder();
    transport.haltTool = 'refund';
    const openbox = createOpenBoxGovernance(base(transport));
    const tools = openbox.tools([makeTool('refund', () => undefined)]);

    // Three attempts at the same tool, as the engine does after a failure.
    const engine = async (_c: unknown, request: Record<string, unknown>) => {
      const inner = engineThatSwallowsToolErrors(() => undefined);
      for (let i = 0; i < 3; i++) await inner(_c, request);
      return { async getText() { return 'refund processed'; } };
    };

    const result = await openbox.callModel(engine, {}, { model: 'm', input: 'refund it', tools });
    await (result as { getText(): Promise<string> }).getText().catch(() => undefined);
    await openbox.close();

    // A retry after the halt must not raise a second approval request — on a
    // require_approval policy that asked a human three times for one refund.
    expect(transport.toolStarts('refund')).toHaveLength(1);
  });
});
