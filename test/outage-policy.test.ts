/**
 * `onApiError: 'fail_closed_destructive'` — when Core cannot be reached, stop
 * only operations that change something; let reads, idempotent requests, model
 * calls and span-less events carry on. 401/403 hard-fail under every policy.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { GovernanceClient } from '../src/client';
import { mergeConfig } from '../src/config';
import { buildDbSpanData } from '../src/node_instrumentation';
import { isDestructiveSpan, type OnApiError } from '../src/outage';
import {
  buildHttpSpanData,
  evaluateActivitySpan,
  registerActivity,
  unregisterActivity,
} from '../src/span_processor';
import {
  GovernanceAuthError,
  SoftGovernanceError,
  type OpenBoxRequestOptions,
  type OpenBoxTransport,
} from '../src/transport';
import type { OpenBoxGovernanceEvent } from '../src/types';

/** A Core that is down: every request fails as an outage (or as a 401). */
class DownTransport implements OpenBoxTransport {
  constructor(private readonly failure: 'outage' | 'auth' = 'outage') {}
  async request<T>(_options: OpenBoxRequestOptions): Promise<T> {
    if (this.failure === 'auth') throw new GovernanceAuthError('OpenBox governance auth failed (401)', 401, null);
    throw new SoftGovernanceError('OpenBox governance request failed (503): unavailable', null);
  }
}

const http = (method: string, url: string) =>
  buildHttpSpanData({
    activityId: 'act-1',
    method,
    url,
    stage: 'started',
    requestBody: null,
    responseBody: null,
    statusCode: null,
    startMs: 1_000,
  });

const db = (statement: string, operation?: string) =>
  buildDbSpanData('act-1', {
    dbSystem: operation ? 'mongodb' : 'postgresql',
    statement,
    stage: 'started',
    startMs: 1_000,
    ...(operation ? { operation } : {}),
  });

const file = (fileOperation: string, fileMode: string) => ({
  hook_type: 'file_operation',
  file_path: '/tmp/x',
  file_operation: fileOperation,
  file_mode: fileMode,
});

describe('isDestructiveSpan', () => {
  it.each([
    ['DB INSERT', db('INSERT INTO refunds VALUES (1)'), true],
    ['DB UPDATE', db('UPDATE orders SET paid = true'), true],
    ['DB DELETE', db('DELETE FROM orders'), true],
    ['DB DROP', db('DROP TABLE orders'), true],
    ['DB SELECT', db('SELECT * FROM orders'), false],
    ['Mongo insertOne', db('{}', 'INSERTONE'), true],
    ['Mongo findOneAndUpdate', db('{}', 'FINDONEANDUPDATE'), true],
    ['Mongo find', db('{}', 'FIND'), false],
    ['file writeFile', file('writeFile', 'w'), true],
    ['file appendFile', file('appendFile', 'a'), true],
    ['file open r+', file('open', 'r+'), true],
    ['file readFile', file('readFile', 'r'), false],
    ['HTTP POST to an API', http('POST', 'https://api.example.com/charges'), true],
    ['HTTP DELETE', http('DELETE', 'https://api.example.com/charges/1'), true],
    ['HTTP PUT', http('PUT', 'https://api.example.com/charges/1'), true],
    ['HTTP GET', http('GET', 'https://api.example.com/charges'), false],
    ['HTTP HEAD', http('HEAD', 'https://api.example.com/charges'), false],
    ['OpenRouter model call (POST)', http('POST', 'https://openrouter.ai/api/v1/chat/completions'), false],
    ['direct provider model call (POST)', http('POST', 'https://api.openai.com/v1/responses'), false],
    ['routing record', { hook_type: 'llm_routing_request' }, false],
    ['span with no hook type', {}, false],
  ])('%s', (_label, span, destructive) => {
    expect(isDestructiveSpan(span as Record<string, unknown>)).toBe(destructive);
  });
});

describe('GovernanceClient.evaluateEvent with Core down', () => {
  const lifecycle = { event_type: 'ActivityStarted', activity_type: 'refund_order' } as OpenBoxGovernanceEvent;
  const withSpans = (...spans: unknown[]) => ({ ...lifecycle, spans }) as unknown as OpenBoxGovernanceEvent;
  const client = new GovernanceClient(new DownTransport(), 'trace-1');

  it('lets an event without spans (tool, model, lifecycle) carry on', async () => {
    await expect(client.evaluateEvent(lifecycle, 'fail_closed_destructive')).resolves.toBeNull();
  });

  it('stops an event carrying a write', async () => {
    await expect(
      client.evaluateEvent(withSpans(db('SELECT 1'), db('INSERT INTO t VALUES (1)')), 'fail_closed_destructive'),
    ).rejects.toBeInstanceOf(SoftGovernanceError);
  });

  it('lets an event carrying only reads carry on', async () => {
    await expect(
      client.evaluateEvent(withSpans(db('SELECT 1'), http('GET', 'https://api.example.com')), 'fail_closed_destructive'),
    ).resolves.toBeNull();
  });

  it('leaves fail_open and fail_closed as they were', async () => {
    const write = withSpans(db('INSERT INTO t VALUES (1)'));
    await expect(client.evaluateEvent(write, 'fail_open')).resolves.toBeNull();
    await expect(client.evaluateEvent(lifecycle, 'fail_closed')).rejects.toBeInstanceOf(SoftGovernanceError);
  });

  it.each(['fail_open', 'fail_closed', 'fail_closed_destructive'] as OnApiError[])(
    'hard-fails a 401 under %s',
    async (onApiError) => {
      const authClient = new GovernanceClient(new DownTransport('auth'), 'trace-1');
      await expect(authClient.evaluateEvent(lifecycle, onApiError)).rejects.toBeInstanceOf(GovernanceAuthError);
    },
  );

  it('treats a failed approval poll as still pending, so the held operation keeps waiting', async () => {
    await expect(
      client.pollApproval('wf', 'run', 'act', undefined, 'fail_closed_destructive'),
    ).resolves.toBeNull();
    await expect(client.pollApproval('wf', 'run', 'act', undefined, 'fail_closed')).rejects.toBeInstanceOf(
      SoftGovernanceError,
    );
  });
});

describe('hook spans with Core down under fail_closed_destructive', () => {
  const registered: string[] = [];
  afterEach(async () => {
    await Promise.all(registered.splice(0).map((id) => unregisterActivity(id)));
  });

  function activity(onApiError: OnApiError): string {
    const activityId = `act-${registered.length}-${onApiError}`;
    registered.push(activityId);
    registerActivity(
      activityId,
      {
        workflow_id: 'wf',
        run_id: 'run',
        activity_id: activityId,
        activity_type: 'refund_order',
        event_type: 'ActivityStarted',
      } as never,
      new DownTransport(),
      'trace-1',
      {
        hitl: { enabled: true, pollIntervalMs: 1, timeoutMs: 1_000 },
        onApiError,
        logger: { warn: () => undefined },
      } as never,
    );
    return activityId;
  }

  it.each([
    ['a DB write', 'blocks', db('INSERT INTO refunds VALUES (1)')],
    ['a DB read', 'runs', db('SELECT * FROM refunds')],
    ['an HTTP GET', 'runs', http('GET', 'https://api.example.com/orders')],
    ['an HTTP POST to a non-model host', 'blocks', http('POST', 'https://api.example.com/refunds')],
    ['the OpenRouter model call', 'runs', http('POST', 'https://openrouter.ai/api/v1/chat/completions')],
  ])('%s %s', async (_label, outcome, span) => {
    const id = activity('fail_closed_destructive');
    const evaluation = evaluateActivitySpan(id, { ...span, activity_id: id });
    if (outcome === 'blocks') await expect(evaluation).rejects.toBeInstanceOf(SoftGovernanceError);
    else await expect(evaluation).resolves.toBeUndefined();
  });

  it('keeps fail_open and fail_closed as they were for the same write', async () => {
    const write = db('INSERT INTO refunds VALUES (1)');
    const open = activity('fail_open');
    await expect(evaluateActivitySpan(open, { ...write, activity_id: open })).resolves.toBeUndefined();
    const closed = activity('fail_closed');
    await expect(evaluateActivitySpan(closed, { ...db('SELECT 1'), activity_id: closed })).rejects.toBeInstanceOf(
      SoftGovernanceError,
    );
  });
});

describe('mergeConfig onApiError', () => {
  it('accepts fail_closed_destructive', () => {
    expect(mergeConfig({ onApiError: 'fail_closed_destructive' }).onApiError).toBe('fail_closed_destructive');
  });

  it('rejects an unknown value instead of treating it as fail_open', () => {
    expect(() => mergeConfig({ onApiError: 'fail_shut' as OnApiError })).toThrow(/onApiError must be/);
  });
});
