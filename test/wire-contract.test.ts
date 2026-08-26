/**
 * Three defects found by reading OpenBox Core's ingestion code
 * (internal/content/governance.go, storage_event.go, observability/model.go)
 * against what this SDK actually puts on the wire.
 */

import { describe, expect, it } from 'vitest';

import { createOpenBoxGovernance } from '../src/openrouter';
import { extractResponseMetadata } from '../src/hooks';
import { buildHttpSpanData } from '../src/span_processor';
import type { OpenBoxRequestOptions, OpenBoxTransport } from '../src/transport';
import type { OpenBoxGovernanceEvent } from '../src/types';

class Recorder implements OpenBoxTransport {
  readonly events: OpenBoxGovernanceEvent[] = [];
  async request<T>(options: OpenBoxRequestOptions): Promise<T> {
    const body = (options.body ?? {}) as Record<string, unknown>;
    if (options.path.endsWith('/evaluate') && body.hook_trigger !== true) {
      this.events.push(body as unknown as OpenBoxGovernanceEvent);
    }
    return { arm: 'allow' } as never;
  }
}

describe('has_tool_calls is never a fabricated determination', () => {
  it('is undefined for a PostModelCall payload, which carries no tool-call list', () => {
    const meta = extractResponseMetadata({
      sessionId: 's', responseId: 'r', model: 'openai/gpt-4o-mini',
      durationMs: 10, turnType: 'initial', turnNumber: 1,
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    });
    // NOT false: a turn that called tools reported false, which is a wrong
    // claim rather than a missing one.
    expect(meta.has_tool_calls).toBeUndefined();
    // The fields that ARE in the payload still come through.
    expect(meta.llm_model).toBe('openai/gpt-4o-mini');
    expect(meta.input_tokens).toBe(5);
  });

  it('is a real boolean when the payload does carry tool calls', () => {
    expect(extractResponseMetadata({ model: 'm', turnNumber: 1, toolCalls: [{ id: '1' }] }).has_tool_calls).toBe(true);
    expect(extractResponseMetadata({ model: 'm', turnNumber: 1, toolCalls: [] }).has_tool_calls).toBe(false);
  });

  it('omits the field from the event rather than sending a false negative', async () => {
    const transport = new Recorder();
    const openbox = createOpenBoxGovernance({
      transport, agentName: 'wire', instrumentHttp: false,
      instrumentDatabases: false, instrumentFileIo: false,
      logger: { warn: () => undefined },
    });

    await openbox.callModel(
      async (_c: unknown, request: Record<string, unknown>) => {
        const hooks = request.hooks as Record<string, Array<{ handler: Function }>>;
        const ctx = { signal: new AbortController().signal, hookName: '', sessionId: 's' };
        for (const e of hooks.PostModelCall ?? []) {
          await e.handler({ sessionId: 's', responseId: 'r', model: 'm', durationMs: 1, turnType: 'final', turnNumber: 1 }, ctx);
        }
        for (const e of hooks.SessionEnd ?? []) await e.handler({ reason: 'complete' }, ctx);
        return {};
      },
      {}, { model: 'm', input: 'hi' },
    );

    const completed = transport.events.find((e) => e.activity_type === 'llm_call' && e.status === 'completed');
    expect(completed).toBeDefined();
    expect('has_tool_calls' in (completed as object)).toBe(false);
  });
});

describe('WorkflowCompleted uses the key Core binds', () => {
  it('sends activity_output, which is what lands in the output column', async () => {
    const transport = new Recorder();
    const openbox = createOpenBoxGovernance({
      transport, agentName: 'wire', instrumentHttp: false,
      instrumentDatabases: false, instrumentFileIo: false,
      logger: { warn: () => undefined },
    });

    const result = await openbox.callModel(
      async (_c: unknown, request: Record<string, unknown>) => ({
        async getText() {
          const hooks = request.hooks as Record<string, Array<{ handler: Function }>>;
          const ctx = { signal: new AbortController().signal, hookName: '', sessionId: 's' };
          for (const e of hooks.SessionEnd ?? []) await e.handler({ reason: 'complete' }, ctx);
          return 'the final answer';
        },
      }),
      {}, { model: 'm', input: 'hi' },
    );
    await (result as { getText(): Promise<string> }).getText();

    const completed = transport.events.find((e) => e.event_type === 'WorkflowCompleted');
    // Core's GovernanceEventPayload has ActivityOutput and no workflow_output
    // field, so only this key survives unmarshal.
    expect(completed?.activity_output).toEqual({ result: 'the final answer' });
    // Still emitted for consumers reading the raw event stream.
    expect(completed?.workflow_output).toEqual({ result: 'the final answer' });
  });
});

describe('a span keeps one trace_id across both stages', () => {
  it('matches trace_id and span_id between started and completed', () => {
    const common = {
      activityId: 'act-1',
      method: 'POST',
      url: 'https://openrouter.ai/api/v1/responses',
      requestBody: null,
      startMs: 1_700_000_000_000,
    };
    const started = buildHttpSpanData({ ...common, stage: 'started', responseBody: null, statusCode: null });
    const completed = buildHttpSpanData({
      ...common, stage: 'completed', responseBody: '{}', statusCode: 200,
      endMs: common.startMs + 1200,
    });

    expect(started.span_id).toBe(completed.span_id);
    // Was `hexId(32)` per call, so these differed on every span and the two
    // halves could never be correlated by trace.
    expect(started.trace_id).toBe(completed.trace_id);
    expect(String(started.trace_id)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('gives different HTTP calls different traces', () => {
    const mk = (startMs: number) =>
      buildHttpSpanData({
        activityId: 'act-1', method: 'POST', url: 'https://openrouter.ai/api/v1/responses',
        stage: 'started', requestBody: null, responseBody: null, statusCode: null, startMs,
      });
    expect(mk(1).trace_id).not.toBe(mk(2).trace_id);
  });
});
