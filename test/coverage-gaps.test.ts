/**
 * Gaps found by auditing the SDK against its own config surface and against
 * the hooks `@openrouter/agent` actually emits. Each of these was silently
 * wrong or silently absent — none of them failed loudly.
 */

import { describe, expect, it } from 'vitest';

import { createOpenBoxGovernance } from '../src/openrouter';
import type { OpenBoxRequestOptions, OpenBoxTransport } from '../src/transport';
import type { OpenBoxGovernanceEvent } from '../src/types';

class Recorder implements OpenBoxTransport {
  readonly events: OpenBoxGovernanceEvent[] = [];
  /** Per-event verdict; defaults to allow so only the event under test gates. */
  verdictFor: (e: OpenBoxGovernanceEvent) => unknown = () => ({ arm: 'allow' });
  async request<T>(options: OpenBoxRequestOptions): Promise<T> {
    const body = (options.body ?? {}) as Record<string, unknown>;
    if (options.path.endsWith('/evaluate') && body.hook_trigger !== true) {
      this.events.push(body as unknown as OpenBoxGovernanceEvent);
    }
    return this.verdictFor(body as unknown as OpenBoxGovernanceEvent) as T;
  }
  named(name: string) {
    return this.events.filter((e) => e.tool_name === name || e.activity_type === name);
  }
}

const base = (transport: OpenBoxTransport, extra: Record<string, unknown> = {}) => ({
  transport,
  agentName: 'gaps',
  instrumentHttp: false,
  instrumentDatabases: false,
  instrumentFileIo: false,
  logger: { warn: () => undefined },
  ...extra,
});

/** Emits a hook sequence against the registered handlers. */
function engineFiring(script: Array<[string, unknown]>) {
  return async (_c: unknown, request: Record<string, unknown>) => {
    const hooks = request.hooks as Record<string, Array<{ handler: Function }>>;
    const ctx = { signal: new AbortController().signal, hookName: '', sessionId: 's1' };
    const results: unknown[] = [];
    for (const [name, payload] of script) {
      for (const e of hooks[name] ?? []) results.push(await e.handler(payload, ctx));
    }
    return { results };
  };
}

describe('config is honored on the hook path, not just for wrapped tools', () => {
  it('skipToolTypes suppresses events for an unwrapped tool', async () => {
    const transport = new Recorder();
    const openbox = createOpenBoxGovernance(
      base(transport, { skipToolTypes: new Set(['noisy']) }),
    );

    await openbox.callModel(
      engineFiring([
        ['PreToolUse', { toolName: 'noisy', toolInput: {} }],
        ['PostToolUse', { toolName: 'noisy', toolInput: {}, toolOutput: 'x', durationMs: 3 }],
        ['SessionEnd', { reason: 'complete' }],
      ]),
      {},
      { model: 'm', input: 'hi' },
    );

    expect(transport.named('noisy')).toHaveLength(0);
  });

  it('sendToolStartEvent:false suppresses ToolStarted but keeps the completion', async () => {
    const transport = new Recorder();
    const openbox = createOpenBoxGovernance(base(transport, { sendToolStartEvent: false }));

    await openbox.callModel(
      engineFiring([
        ['PreToolUse', { toolName: 'search', toolInput: {} }],
        ['PostToolUse', { toolName: 'search', toolInput: {}, toolOutput: 'x', durationMs: 3 }],
        ['SessionEnd', { reason: 'complete' }],
      ]),
      {},
      { model: 'm', input: 'hi' },
    );

    const events = transport.named('search');
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('completed');
  });
});

describe('parallel calls to the same tool', () => {
  it('matches start times FIFO instead of overwriting a single slot', async () => {
    const transport = new Recorder();
    const openbox = createOpenBoxGovernance(base(transport));

    await openbox.callModel(
      engineFiring([
        // Both calls enter before either completes — one shared slot would
        // give the second completion the first call's start time.
        ['PreToolUse', { toolName: 'fetch', toolInput: { n: 1 } }],
        ['PreToolUse', { toolName: 'fetch', toolInput: { n: 2 } }],
        ['PostToolUseFailure', { toolName: 'fetch', toolInput: { n: 1 }, error: new Error('boom') }],
        ['PostToolUseFailure', { toolName: 'fetch', toolInput: { n: 2 }, error: new Error('boom') }],
        ['SessionEnd', { reason: 'complete' }],
      ]),
      {},
      { model: 'm', input: 'hi' },
    );

    const failures = transport.events.filter((e) => e.status === 'failed' && e.tool_name === 'fetch');
    expect(failures).toHaveLength(2);
    // Both got a duration from their own queued start, not undefined.
    for (const f of failures) expect(typeof f.duration_ms).toBe('number');
  });
});

describe('engine safety signals', () => {
  it('reports Stop as a signal without overriding the caller stop condition', async () => {
    const transport = new Recorder();
    const openbox = createOpenBoxGovernance(base(transport));

    const out = await openbox.callModel(
      engineFiring([
        ['Stop', { reason: 'max_turns' }],
        ['SessionEnd', { reason: 'max_turns' }],
      ]),
      {},
      { model: 'm', input: 'hi' },
    );

    const stop = transport.events.find((e) => e.signal_name === 'stop');
    expect(stop).toBeDefined();
    expect(stop?.signal_args).toEqual(['max_turns']);
    // No StopResult returned — resuming is the caller's decision.
    expect((out as { results: unknown[] }).results[0]).toBeUndefined();
  });

  it('reports a doom loop and escalates to stop when Core blocks', async () => {
    const transport = new Recorder();
    // Only the doom-loop event is blocked — a blanket block would reject the
    // opening prompt gate and the run would never reach the hook under test.
    transport.verdictFor = (e) =>
      e.signal_name === 'doom_loop'
        ? { arm: 'block', reason: 'looping on the same call' }
        : { arm: 'allow' };
    const openbox = createOpenBoxGovernance(base(transport));

    const out = await openbox.callModel(
      engineFiring([
        ['DoomLoopDetected', {
          detector: 'tool-fingerprint',
          action: 'observe',
          streak: 5,
          fingerprint: 'abc123def456',
          toolName: 'search',
          message: 'repeated identical call',
        }],
      ]),
      {},
      { model: 'm', input: 'hi' },
    );

    const loop = transport.events.find((e) => e.signal_name === 'doom_loop');
    expect(loop).toBeDefined();
    expect(loop?.tool_name).toBe('search');
    expect((loop?.extra as Record<string, unknown>)?.streak).toBe(5);
    expect((out as { results: unknown[] }).results[0]).toEqual({ overrideAction: 'stop' });
  });

  it('leaves the engine ladder alone when Core allows', async () => {
    const transport = new Recorder();
    const openbox = createOpenBoxGovernance(base(transport));

    const out = await openbox.callModel(
      engineFiring([
        ['DoomLoopDetected', {
          detector: 'text-repetition', action: 'steer', streak: 3,
          fingerprint: 'zzz', message: 'repeating text',
        }],
      ]),
      {},
      { model: 'm', input: 'hi' },
    );

    expect((out as { results: unknown[] }).results[0]).toBeUndefined();
  });
});

describe('concurrent runs', () => {
  it('attributes each run\'s tool to its own workflow', async () => {
    const transport = new Recorder();
    const openbox = createOpenBoxGovernance(base(transport));

    // Two tools, each belonging to a different callModel invocation. With the
    // old "most recent open run" heuristic, run A's tool was billed to run B.
    const makeTool = (name: string) => ({
      name,
      execute: async () => `${name}-done`,
    });
    const [toolA] = openbox.tools([makeTool('alpha')]);
    const [toolB] = openbox.tools([makeTool('beta')]);

    const runner = (t: { execute: unknown }) => async (_c: unknown, request: Record<string, unknown>) => {
      // Yield so both runs are open simultaneously before either tool fires.
      await new Promise((r) => setImmediate(r));
      await (t.execute as Function)({});
      const hooks = request.hooks as Record<string, Array<{ handler: Function }>>;
      const ctx = { signal: new AbortController().signal, hookName: '', sessionId: 's' };
      for (const e of hooks.SessionEnd ?? []) await e.handler({ reason: 'complete' }, ctx);
      return {};
    };

    await Promise.all([
      openbox.callModel(runner(toolA as { execute: unknown }), {}, { model: 'm', input: 'a' }),
      openbox.callModel(runner(toolB as { execute: unknown }), {}, { model: 'm', input: 'b' }),
    ]);

    const alpha = transport.events.find((e) => e.tool_name === 'alpha');
    const beta = transport.events.find((e) => e.tool_name === 'beta');
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();
    // The decisive assertion: different runs, so different workflow ids.
    expect(alpha!.workflow_id).not.toBe(beta!.workflow_id);
  });
});
