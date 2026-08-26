/**
 * Behavioral tests for the OpenRouter binding.
 *
 * The real `@openrouter/agent` engine is not driven here — a fake `callModel`
 * plays its part by invoking the hook entries the binding registers, in the
 * order the engine emits them. That keeps the tests about OUR contract (which
 * governance events go on the wire, with which ids, in which order) rather
 * than about the engine's internals, and it means the suite runs with no
 * network and no API key.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { createOpenBoxGovernance } from '../src/openrouter';
import type {
  OpenBoxRequestOptions,
  OpenBoxTransport,
} from '../src/transport';
import type { OpenBoxGovernanceEvent } from '../src/types';

interface Sent {
  path: string;
  body: Record<string, unknown>;
}

/**
 * Records every governance call and replies with whatever `verdicts` says for
 * the event type in question. `evaluate` and `approval` are kept separate so a
 * test can make the first poll pending and the second approving.
 */
class FakeTransport implements OpenBoxTransport {
  readonly sent: Sent[] = [];
  verdictFor: (event: OpenBoxGovernanceEvent) => unknown = () => ({ arm: 'allow' });
  approvalReplies: unknown[] = [];

  async request<T>(options: OpenBoxRequestOptions): Promise<T> {
    const body = (options.body ?? {}) as Record<string, unknown>;
    this.sent.push({ path: options.path, body });
    if (options.path.endsWith('/approval')) {
      return (this.approvalReplies.shift() ?? {}) as T;
    }
    return this.verdictFor(body as unknown as OpenBoxGovernanceEvent) as T;
  }

  /** Governance events only (hook spans carry `hook_trigger`). */
  events(): OpenBoxGovernanceEvent[] {
    return this.sent
      .filter((s) => s.path.endsWith('/evaluate') && s.body.hook_trigger !== true)
      .map((s) => s.body as unknown as OpenBoxGovernanceEvent);
  }

  eventTypes(): string[] {
    return this.events().map((e) => String(e.metadata != null && typeof e.metadata === 'object'
      ? ((e.metadata as Record<string, unknown>).sdk_event_type ?? e.event_type)
      : e.event_type));
  }
}

/** Options that keep a test hermetic: no HTTP/DB patching, no real polling. */
function baseOptions(transport: OpenBoxTransport) {
  return {
    transport,
    agentName: 'test-agent',
    instrumentHttp: false,
    instrumentDatabases: false,
    instrumentFileIo: false,
    hitl: { pollIntervalMs: 1, timeoutMs: 2000 },
    logger: { warn: () => undefined },
  };
}

/**
 * Stand-in for `callModel`. Replays the hook sequence a single-tool-round run
 * produces, in the engine's real order: the model response lands first
 * (`PostModelCall`, emitted by `emitPostModelCall` for a completed response),
 * then the tool round it asked for, then the run ends.
 */
function fakeEngine(opts: { toolRound?: boolean; toolName?: string } = {}) {
  return async (_client: unknown, request: Record<string, unknown>) => {
    const hooks = request.hooks as Record<string, Array<{ handler: Function }>>;
    const ctx = { signal: new AbortController().signal, hookName: '', sessionId: 's1' };
    const fire = async (name: string, payload: unknown) => {
      const results = [];
      for (const entry of hooks[name] ?? []) results.push(await entry.handler(payload, ctx));
      return results;
    };

    const modelCall = (turnNumber: number) =>
      fire('PostModelCall', {
        sessionId: 's1',
        responseId: `resp_${turnNumber}`,
        model: 'anthropic/claude-sonnet-5',
        durationMs: 250,
        turnType: turnNumber === 1 ? 'initial' : 'final',
        turnNumber,
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          totalTokens: 14,
          cachedTokens: 0,
          reasoningTokens: 0,
        },
      });

    await modelCall(1);
    if (opts.toolRound) {
      await fire('PreToolUse', { toolName: opts.toolName ?? 'search', toolInput: { q: 'x' } });
      await fire('PostToolUse', {
        toolName: opts.toolName ?? 'search',
        toolInput: { q: 'x' },
        toolOutput: 'result text',
        durationMs: 12,
      });
      // The tool round's results go back to the model — the second turn.
      await modelCall(2);
    }
    await fire('SessionEnd', { reason: 'complete' });
    return { ok: true, hooks };
  };
}

describe('createOpenBoxGovernance — event lifecycle', () => {
  let transport: FakeTransport;

  beforeEach(() => {
    transport = new FakeTransport();
  });

  it('emits the full workflow lifecycle in execution order', async () => {
    const openbox = createOpenBoxGovernance(baseOptions(transport));
    await openbox.callModel(fakeEngine(), {}, { model: 'm', input: 'hello there' });

    expect(transport.eventTypes()).toEqual([
      'WorkflowStarted',
      'SignalReceived',
      'LLMStarted',
      'LLMCompleted',
      'WorkflowCompleted',
    ]);
  });

  it('pairs LLMCompleted to LLMStarted by activity_id', async () => {
    const openbox = createOpenBoxGovernance(baseOptions(transport));
    await openbox.callModel(fakeEngine(), {}, { model: 'm', input: 'hi' });

    const events = transport.events();
    const started = events.find((e) => e.activity_type === 'llm_call' && e.duration_ms == null);
    const completed = events.find((e) => e.activity_type === 'llm_call' && e.duration_ms != null);
    expect(started?.activity_id).toBeTruthy();
    expect(completed?.activity_id).toBe(started?.activity_id);
  });

  it('maps OpenRouter camelCase usage onto the wire fields', async () => {
    const openbox = createOpenBoxGovernance(baseOptions(transport));
    await openbox.callModel(fakeEngine(), {}, { model: 'm', input: 'hi' });

    const completed = transport
      .events()
      .find((e) => e.activity_type === 'llm_call' && e.status === 'completed');
    expect(completed).toMatchObject({
      llm_model: 'anthropic/claude-sonnet-5',
      input_tokens: 10,
      output_tokens: 4,
      total_tokens: 14,
      duration_ms: 250,
    });
  });

  it('opens the next llm_call at the tool round, since a tool round always precedes one', async () => {
    const openbox = createOpenBoxGovernance(baseOptions(transport));
    await openbox.callModel(fakeEngine({ toolRound: true }), {}, { model: 'm', input: 'hi' });

    // Two LLMStarted: the pre-flight one, plus the one opened at PreToolUse
    // for the turn that follows the tool round. Both are closed by their own
    // PostModelCall, so the run leaves no orphaned llm_call row on Core.
    const types = transport.eventTypes();
    expect(types.filter((t) => t === 'LLMStarted')).toHaveLength(2);
    expect(types.filter((t) => t === 'LLMCompleted')).toHaveLength(2);
    const llmEvents = transport.events().filter((e) => e.activity_type === 'llm_call');
    expect(llmEvents.filter((e) => e.status === 'failed')).toHaveLength(0);
  });

  it('closes the workflow even when the opening gate rejects the run', async () => {
    transport.verdictFor = (e) =>
      e.event_type === 'SignalReceived'
        ? { arm: 'block', reason: 'prompt violates policy' }
        : { arm: 'allow' };

    const openbox = createOpenBoxGovernance(baseOptions(transport));
    await expect(
      openbox.callModel(fakeEngine(), {}, { model: 'm', input: 'bad prompt' }),
    ).rejects.toThrow(/prompt violates policy/);

    const types = transport.eventTypes();
    expect(types).toContain('WorkflowCompleted');
    // The rejected SignalReceived row is closed rather than left "started".
    const closure = transport
      .events()
      .find((e) => e.activity_type === 'user_prompt' && e.status === 'failed');
    expect(closure).toBeTruthy();
  });
});

describe('createOpenBoxGovernance — prompt redaction', () => {
  it("rewrites a string input with Core's redacted text before the engine sees it", async () => {
    const transport = new FakeTransport();
    // LLM/Tool events reach the wire as ActivityStarted with the SDK-level
    // name preserved in metadata.sdk_event_type (see toServerEventType), so
    // match on that rather than on event_type.
    transport.verdictFor = (e) =>
      (e.metadata as Record<string, unknown> | undefined)?.sdk_event_type === 'LLMStarted'
        ? {
            arm: 'allow',
            guardrails_result: {
              input_type: 'activity_input',
              redacted_input: ['my card is [REDACTED]'],
            },
          }
        : { arm: 'allow' };

    // Redaction is applied by handleWrapModelCall in the n8n port; here the
    // binding owns `request.input`, so assert on what the engine received.
    const openbox = createOpenBoxGovernance(baseOptions(transport));
    let seenInput: unknown;
    const engine = async (_c: unknown, request: Record<string, unknown>) => {
      seenInput = request.input;
      return fakeEngine()(_c, request);
    };
    await openbox.callModel(engine, {}, { model: 'm', input: 'my card is 4111111111111111' });

    // The LLMStarted redaction lands on the messages array, which the binding
    // writes back into `input` in the shape the caller used (a bare string).
    expect(seenInput).toBe('my card is [REDACTED]');
  });
});

describe('createOpenBoxGovernance — tools()', () => {
  it('wraps a plain execute and reports ToolStarted/ToolCompleted on one activity id', async () => {
    const transport = new FakeTransport();
    const openbox = createOpenBoxGovernance(baseOptions(transport));

    const [wrapped] = openbox.tools([
      { name: 'search', execute: async (args: { q: string }) => `hits for ${args.q}` },
    ]);

    let toolOut: unknown;
    const engine = async (_c: unknown, request: Record<string, unknown>) => {
      toolOut = await (wrapped.execute as Function)({ q: 'openbox' });
      return fakeEngine()(_c, request);
    };
    await openbox.callModel(engine, {}, { model: 'm', input: 'hi' });

    expect(toolOut).toBe('hits for openbox');
    const toolEvents = transport.events().filter((e) => e.tool_name === 'search');
    expect(toolEvents.map((e) => e.status)).toEqual([undefined, 'completed']);
    expect(toolEvents[0].activity_id).toBe(toolEvents[1].activity_id);
  });

  it('blocks the tool body when Core blocks at tool_start', async () => {
    const transport = new FakeTransport();
    transport.verdictFor = (e) =>
      e.tool_name === 'danger' && e.status == null
        ? { arm: 'block', reason: 'not allowed' }
        : { arm: 'allow' };

    const openbox = createOpenBoxGovernance(baseOptions(transport));
    let ran = false;
    const [wrapped] = openbox.tools([
      {
        name: 'danger',
        execute: async () => {
          ran = true;
          return 'done';
        },
      },
    ]);

    const engine = async (_c: unknown, request: Record<string, unknown>) => {
      await expect((wrapped.execute as Function)({})).rejects.toThrow(/not allowed/);
      return fakeEngine()(_c, request);
    };
    await openbox.callModel(engine, {}, { model: 'm', input: 'hi' });
    expect(ran).toBe(false);
  });

  it('holds the tool call open across a human approval', async () => {
    const transport = new FakeTransport();
    transport.verdictFor = (e) =>
      e.tool_name === 'payment' && e.status == null
        ? { arm: 'require_approval', approval_id: 'appr_1' }
        : { arm: 'allow' };
    // First poll: Core has recorded no decision yet. Second: approved.
    transport.approvalReplies = [{}, { arm: 'allow' }];

    const openbox = createOpenBoxGovernance(baseOptions(transport));
    const [wrapped] = openbox.tools([
      { name: 'payment', execute: async () => 'charged' },
    ]);

    const engine = async (_c: unknown, request: Record<string, unknown>) => {
      await expect((wrapped.execute as Function)({ amount: 10 })).resolves.toBe('charged');
      return fakeEngine()(_c, request);
    };
    await openbox.callModel(engine, {}, { model: 'm', input: 'hi' });

    const polls = transport.sent.filter((s) => s.path.endsWith('/approval'));
    expect(polls).toHaveLength(2);
    expect(polls[0].body).toMatchObject({ activity_id: 'appr_1' });
  });

  it('leaves an async-generator tool untouched so streaming survives', async () => {
    const transport = new FakeTransport();
    const openbox = createOpenBoxGovernance(baseOptions(transport));

    const streaming = {
      name: 'stream',
      execute: async function* () {
        yield 'a';
        yield 'b';
      },
    };
    const [wrapped] = openbox.tools([streaming]);
    expect(wrapped.execute).toBe(streaming.execute);
  });

  it('governs an unwrapped tool through the hook path instead, without doubling', async () => {
    const transport = new FakeTransport();
    const openbox = createOpenBoxGovernance(baseOptions(transport));

    // 'search' is never passed through tools(), so PreToolUse/PostToolUse own it.
    await openbox.callModel(
      fakeEngine({ toolRound: true, toolName: 'search' }),
      {},
      { model: 'm', input: 'hi' },
    );

    const toolEvents = transport.events().filter((e) => e.tool_name === 'search');
    expect(toolEvents).toHaveLength(2);
    expect(toolEvents[1]).toMatchObject({ status: 'completed', duration_ms: 12 });
  });
});

describe('createOpenBoxGovernance — fail-open policy', () => {
  it('continues the run when Core is unreachable', async () => {
    const transport: OpenBoxTransport = {
      async request() {
        throw new (await import('../src/transport')).SoftGovernanceError('ECONNREFUSED', null);
      },
    };
    const openbox = createOpenBoxGovernance(baseOptions(transport));
    await expect(
      openbox.callModel(fakeEngine(), {}, { model: 'm', input: 'hi' }),
    ).resolves.toBeTruthy();
  });

  it('aborts the run when Core is unreachable and onApiError is fail_closed', async () => {
    const transport: OpenBoxTransport = {
      async request() {
        throw new (await import('../src/transport')).SoftGovernanceError('ECONNREFUSED', null);
      },
    };
    const openbox = createOpenBoxGovernance({
      ...baseOptions(transport),
      onApiError: 'fail_closed',
    });
    await expect(
      openbox.callModel(fakeEngine(), {}, { model: 'm', input: 'hi' }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe('createOpenBoxGovernance — real @openrouter/agent tool shape', () => {
  // `tool()` does not return `{name, execute}`. It returns the OpenAI wire
  // shape, with the body one level down. An earlier version of `tools()` only
  // looked at the top level, so it silently wrapped nothing and every tool ran
  // ungoverned — caught by an end-to-end run, not by this suite. Hence this test.
  const makeSdkShapedTool = (name: string, execute: (args: unknown) => Promise<unknown>) => ({
    type: 'function' as const,
    function: { name, description: 'd', inputSchema: {}, execute },
  });

  it('wraps the body nested under `function`', async () => {
    const transport = new FakeTransport();
    const openbox = createOpenBoxGovernance(baseOptions(transport));

    const [wrapped] = openbox.tools([
      makeSdkShapedTool('lookup_order', async () => ({ status: 'shipped' })),
    ]);

    const engine = async (_c: unknown, request: Record<string, unknown>) => {
      await (wrapped.function!.execute as Function)({ orderId: 'A-1' });
      return fakeEngine()(_c, request);
    };
    await openbox.callModel(engine, {}, { model: 'm', input: 'hi' });

    const toolEvents = transport.events().filter((e) => e.tool_name === 'lookup_order');
    expect(toolEvents.map((e) => e.status)).toEqual([undefined, 'completed']);
  });

  it('preserves the surrounding tool object so the engine still accepts it', async () => {
    const transport = new FakeTransport();
    const openbox = createOpenBoxGovernance(baseOptions(transport));
    const original = makeSdkShapedTool('lookup_order', async () => 'ok');
    const [wrapped] = openbox.tools([original]);

    expect(wrapped.type).toBe('function');
    expect(wrapped.function!.name).toBe('lookup_order');
    expect(wrapped.function!.inputSchema).toBe(original.function.inputSchema);
    // The original is never mutated — callers may reuse it elsewhere.
    expect(original.function.execute).not.toBe(wrapped.function!.execute);
  });
});

describe('createOpenBoxGovernance — engine failure', () => {
  it('closes the open llm_call when the engine throws before emitting any hook', async () => {
    const transport = new FakeTransport();
    const openbox = createOpenBoxGovernance(baseOptions(transport));

    // A malformed tool schema makes the real callModel throw synchronously,
    // so no PostModelCall and no SessionEnd ever arrive. Without an explicit
    // closure the pre-screened llm_call sits on Core as "started, never
    // completed" forever.
    const engine = () => {
      throw new Error('Invalid Zod schema provided');
    };
    await expect(
      openbox.callModel(engine, {}, { model: 'm', input: 'hi' }),
    ).rejects.toThrow(/Invalid Zod schema/);

    const llmEvents = transport.events().filter((e) => e.activity_type === 'llm_call');
    expect(llmEvents).toHaveLength(2);
    expect(llmEvents[1]).toMatchObject({ status: 'failed' });
    expect(llmEvents[1].activity_id).toBe(llmEvents[0].activity_id);
    expect(transport.eventTypes()).toContain('WorkflowCompleted');
  });
});

describe('createOpenBoxGovernance — event ordering', () => {
  /**
   * The session log must be a FLAT sequence — llm_call, tool, llm_call — the
   * same shape the n8n node produces. An earlier version opened the next
   * llm_call at PreToolUse, which nested the tool's activity inside the model
   * call's and made the dashboard read as though the tool had executed
   * mid-call. Caught by reading a real session log, not by this suite.
   */
  const sequenceOf = (transport: FakeTransport) =>
    transport
      .events()
      .filter((e) => e.activity_type === 'llm_call' || e.tool_name != null)
      .map((e) => `${e.activity_type}:${e.status === 'completed' ? 'end' : 'start'}`);

  it('closes a model call before the tool it requested starts', async () => {
    const transport = new FakeTransport();
    const openbox = createOpenBoxGovernance(baseOptions(transport));
    await openbox.callModel(
      fakeEngine({ toolRound: true, toolName: 'search' }),
      {},
      { model: 'm', input: 'hi' },
    );

    expect(sequenceOf(transport)).toEqual([
      'llm_call:start',
      'llm_call:end',
      'search:start',
      'search:end',
      'llm_call:start',
      'llm_call:end',
    ]);
  });

  it('opens the next model call only after the LAST tool of a parallel round', async () => {
    const transport = new FakeTransport();
    const openbox = createOpenBoxGovernance(baseOptions(transport));

    // Two tools in flight at once: both PreToolUse fire before either
    // PostToolUse. Opening the llm_call on the first completion would nest
    // the second tool inside it.
    const engine = async (_c: unknown, request: Record<string, unknown>) => {
      const hooks = request.hooks as Record<string, Array<{ handler: Function }>>;
      const ctx = { signal: new AbortController().signal, hookName: '', sessionId: 's1' };
      const fire = async (n: string, p: unknown) => {
        for (const e of hooks[n] ?? []) await e.handler(p, ctx);
      };
      const post = (turnNumber: number) =>
        fire('PostModelCall', {
          sessionId: 's1', responseId: `r${turnNumber}`, model: 'm',
          durationMs: 1, turnType: 'initial', turnNumber,
        });

      await post(1);
      await fire('PreToolUse', { toolName: 'alpha', toolInput: {} });
      await fire('PreToolUse', { toolName: 'beta', toolInput: {} });
      await fire('PostToolUse', { toolName: 'alpha', toolInput: {}, toolOutput: 'a', durationMs: 1 });
      await fire('PostToolUse', { toolName: 'beta', toolInput: {}, toolOutput: 'b', durationMs: 1 });
      await post(2);
      await fire('SessionEnd', { reason: 'complete' });
      return { ok: true };
    };

    await openbox.callModel(engine, {}, { model: 'm', input: 'hi' });

    expect(sequenceOf(transport)).toEqual([
      'llm_call:start',
      'llm_call:end',
      'alpha:start',
      'beta:start',
      'alpha:end',
      'beta:end',
      'llm_call:start',
      'llm_call:end',
    ]);
  });
});
