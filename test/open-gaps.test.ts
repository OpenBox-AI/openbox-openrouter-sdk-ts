/**
 * Behaviour that was silently wrong until it was exercised against a real
 * OpenBox Core: the completion text, the multi-turn input, and the mysql2
 * promise API's connection failures.
 *
 *   C — `completion` was always null on LLMCompleted, because PostModelCall
 *       carries no response text.
 *   D — turn 2+ reported the run's ORIGINAL prompt as its input rather than
 *       the conversation that was actually sent.
 *   B — mysql2's promise API surfaces a refused connection as an 'error'
 *       event, not through connect(), so the failure produced no span.
 */

import { describe, expect, it } from 'vitest';

import { createOpenBoxGovernance } from '../src/openrouter';
import { patchConnectMethod, patchMysql2Exports } from '../src/node_instrumentation';
import {
  awaitAssistantText,
  buildHttpSpanData,
  extractAssistantText,
  takeAssistantText,
} from '../src/span_processor';
import type { OpenBoxRequestOptions, OpenBoxTransport } from '../src/transport';
import type { OpenBoxGovernanceEvent } from '../src/types';

class Recorder implements OpenBoxTransport {
  readonly events: OpenBoxGovernanceEvent[] = [];
  async request<T>(options: OpenBoxRequestOptions): Promise<T> {
    const body = (options.body ?? {}) as Record<string, unknown>;
    if (options.path.endsWith('/evaluate') && body.hook_trigger !== true) {
      this.events.push(body as unknown as OpenBoxGovernanceEvent);
    }
    return { arm: 'allow' } as unknown as T;
  }
  /**
   * LLMStarted reaches the wire as Core's own vocabulary (ActivityStarted on
   * an llm_call activity) — see the event-type translation in client.ts.
   */
  llmStarts() {
    return this.events.filter(
      (e) => e.event_type === 'ActivityStarted' && e.activity_type === 'llm_call',
    ) as unknown as Array<Record<string, unknown>>;
  }
}

const base = (transport: OpenBoxTransport) => ({
  transport,
  agentName: 'open-gaps',
  instrumentHttp: false,
  instrumentDatabases: false,
  instrumentFileIo: false,
  logger: { warn: () => undefined },
});

/** Emits a hook sequence against the registered handlers. */
function engineFiring(script: Array<[string, unknown]>) {
  return async (_c: unknown, request: Record<string, unknown>) => {
    const hooks = request.hooks as Record<string, Array<{ handler: Function }>>;
    const ctx = { signal: new AbortController().signal, hookName: '', sessionId: 's1' };
    for (const [name, payload] of script) {
      for (const e of hooks[name] ?? []) await e.handler(payload, ctx);
    }
    return { async getText() { return 'final'; } };
  };
}

const postModelCall = (turnNumber: number) => ({
  sessionId: 's1',
  responseId: `r${turnNumber}`,
  model: 'openai/gpt-4o-mini',
  durationMs: 12,
  turnType: turnNumber === 1 ? 'initial' : 'tool_round',
  turnNumber,
});

// ── C. completion text ───────────────────────────────────────────────────────

describe('assistant text is recovered from the model response body', () => {
  it('reads the Responses API shape the Agent SDK streams', () => {
    const body = JSON.stringify({
      model: 'openai/gpt-4o-mini',
      output: [
        { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'thinking' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The answer is 4.' }] },
      ],
    });
    expect(extractAssistantText(body)).toBe('The answer is 4.');
  });

  it('reads chat-completions bodies too', () => {
    const body = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hello' } }] });
    expect(extractAssistantText(body)).toBe('hello');
  });

  it('returns null rather than guessing on a body it cannot read', () => {
    expect(extractAssistantText('not json')).toBeNull();
    expect(extractAssistantText(null)).toBeNull();
    // A tool call is not an answer.
    expect(
      extractAssistantText(JSON.stringify({ output: [{ type: 'function_call', name: 'lookup', arguments: '{}' }] })),
    ).toBeNull();
  });

  it('is captured off the completed LLM span and taken once', () => {
    const activityId = 'act-completion';
    const sse = [
      'data: {"type":"response.completed","response":{"model":"openai/gpt-4o-mini","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3},"output":[{"type":"message","content":[{"type":"output_text","text":"captured"}]}]}}',
      'data: [DONE]',
      '',
    ].join('\n');

    buildHttpSpanData({
      activityId,
      method: 'POST',
      url: 'https://openrouter.ai/api/v1/responses',
      stage: 'completed',
      requestBody: null,
      responseBody: sse,
      statusCode: 200,
      startMs: 1,
      endMs: 2,
    });

    expect(takeAssistantText(activityId)).toBe('captured');
    expect(takeAssistantText(activityId)).toBeNull();
  });

  it('is waited for, because the span completes after the activity closes', async () => {
    // The response body is teed, so the completed span is built once the
    // engine has finished reading the stream — measured at ~1ms AFTER
    // PostModelCall, i.e. after the SDK closes the activity. Reading the text
    // at close time therefore always got null; the close waits for the span.
    const activityId = 'act-late';
    const spanArgs = {
      activityId,
      method: 'POST',
      url: 'https://openrouter.ai/api/v1/responses',
      requestBody: null,
      statusCode: 200,
      startMs: 1,
    };
    buildHttpSpanData({ ...spanArgs, stage: 'started', responseBody: null, statusCode: null });

    const pending = awaitAssistantText(activityId, 1_000);
    setTimeout(() => {
      buildHttpSpanData({
        ...spanArgs,
        stage: 'completed',
        endMs: 2,
        responseBody: JSON.stringify({
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'late answer' }] }],
        }),
      });
    }, 5);

    await expect(pending).resolves.toBe('late answer');
  });

  it('does not wait out the cap on a turn that only called tools', async () => {
    const activityId = 'act-tools-only';
    const spanArgs = {
      activityId,
      method: 'POST',
      url: 'https://openrouter.ai/api/v1/responses',
      requestBody: null,
      startMs: 1,
    };
    buildHttpSpanData({ ...spanArgs, stage: 'started', responseBody: null, statusCode: null });

    const startedAt = Date.now();
    const pending = awaitAssistantText(activityId, 5_000);
    buildHttpSpanData({
      ...spanArgs,
      stage: 'completed',
      statusCode: 200,
      endMs: 2,
      responseBody: JSON.stringify({
        output: [{ type: 'function_call', name: 'lookup_order', arguments: '{}' }],
      }),
    });

    await expect(pending).resolves.toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('waits for nothing when no LLM span is in flight', async () => {
    await expect(awaitAssistantText('act-no-span', 5_000)).resolves.toBeNull();
  });

  it('is not captured from an ordinary HTTP tool call', () => {
    const activityId = 'act-not-llm';
    buildHttpSpanData({
      activityId,
      method: 'GET',
      url: 'https://example.com/items',
      stage: 'completed',
      requestBody: null,
      responseBody: JSON.stringify({ choices: [{ message: { content: 'not an assistant' } }] }),
      statusCode: 200,
      startMs: 1,
      endMs: 2,
    });
    expect(takeAssistantText(activityId)).toBeNull();
  });
});

// ── D. turn 2+ input ─────────────────────────────────────────────────────────

describe('LLMStarted reports the conversation that was actually sent', () => {
  it('sends the prompt alone on turn 1 and the conversation on turn 2', async () => {
    const transport = new Recorder();
    const openbox = createOpenBoxGovernance(base(transport));

    const result = await openbox.callModel(
      engineFiring([
        ['PostModelCall', postModelCall(1)],
        ['PreToolUse', { toolName: 'lookup', toolInput: { id: 7 } }],
        ['PostToolUse', { toolName: 'lookup', toolInput: { id: 7 }, toolOutput: 'row-7', durationMs: 3 }],
        ['PostModelCall', postModelCall(2)],
      ]),
      {},
      { model: 'm', input: 'find record 7' },
    );
    await (result as { getText(): Promise<string> }).getText();
    await openbox.close();

    const starts = transport.llmStarts();
    expect(starts.length).toBeGreaterThanOrEqual(2);

    const first = starts[0];
    expect(first.activity_input).toEqual([{ prompt: 'find record 7' }]);
    expect(first.prompt).toBe('find record 7');

    const second = starts[1];
    const input = second.activity_input as Array<Record<string, unknown>>;
    // The user prompt, the model's tool call, and the tool's result — not the
    // original prompt repeated.
    expect(input[0]).toEqual({ role: 'user', content: 'find record 7' });
    expect(input.some((m) => m.role === 'assistant' && String(m.content).includes('lookup'))).toBe(true);
    expect(input.some((m) => m.role === 'tool' && m.name === 'lookup' && m.content === 'row-7')).toBe(true);
    expect(String(second.prompt)).toContain('row-7');
  });

  it('records a tool failure on the conversation as well', async () => {
    const transport = new Recorder();
    const openbox = createOpenBoxGovernance(base(transport));

    const result = await openbox.callModel(
      engineFiring([
        ['PostModelCall', postModelCall(1)],
        ['PreToolUse', { toolName: 'lookup', toolInput: {} }],
        ['PostToolUseFailure', { toolName: 'lookup', toolInput: {}, error: new Error('boom') }],
        ['PostModelCall', postModelCall(2)],
      ]),
      {},
      { model: 'm', input: 'go' },
    );
    await (result as { getText(): Promise<string> }).getText();
    await openbox.close();

    const second = transport.llmStarts()[1];
    const input = second.activity_input as Array<Record<string, unknown>>;
    expect(input.some((m) => m.role === 'tool' && String(m.content).includes('boom'))).toBe(true);
  });
});

// ── B. mysql2 connection failure via the 'error' event ───────────────────────

describe('mysql2 promise-api connection failures', () => {
  it('reports a failed-connection span from the error event', () => {
    class FakeConnection {
      config = { host: 'db.internal', port: 3306, database: 'app' };
      authorized: boolean | undefined;
      emitted: unknown[] = [];
      emit(event: string, ...rest: unknown[]) {
        this.emitted.push([event, ...rest]);
        return true;
      }
      connect() { /* the promise API never calls this */ }
      query() { return undefined; }
    }

    patchMysql2Exports({ Connection: FakeConnection } as unknown as Record<string, unknown>);

    const conn = new FakeConnection();
    const err = Object.assign(new Error('connect ECONNREFUSED'), { fatal: true });
    // The driver's own listeners must still see the event.
    expect(conn.emit('error', err)).toBe(true);
    expect(conn.emitted).toHaveLength(1);
    // Reported at most once per connection.
    conn.emit('error', err);
    expect((conn as unknown as Record<string, unknown>)._openboxConnectErrorReported).toBe(true);
  });

  it('leaves connect() patching in place', () => {
    // patchConnectMethod is idempotent — the emit patch must not disturb it.
    const proto: Record<string, unknown> = { connect() { return 'ok'; } };
    patchConnectMethod(proto, 'connect', 'mysql', () => ({}));
    expect((proto.connect as () => string)()).toBe('ok');
  });
});
