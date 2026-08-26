/**
 * node-redis v4 produced no database spans at all.
 *
 * The patch hooked the client's public `sendCommand`, but a typed command
 * (`client.set(…)`) goes through `commandsExecutor` → a PRIVATE `#sendCommand`,
 * and `attachCommands` captures the executor in a closure when the class is
 * defined, so replacing it on the prototype afterwards changes nothing either.
 * Measured against a live Redis: identical ioredis code produced spans and
 * node-redis produced none — a whole driver silently ungoverned.
 *
 * The generated command methods are wrapped directly instead, using the
 * driver's own command map so nothing else on the prototype is touched.
 */

import { describe, expect, it } from 'vitest';

import { patchNodeRedisCommands } from '../src/node_instrumentation';
import { registerActivity, runWithActivity, unregisterActivity } from '../src/span_processor';
import type { OpenBoxRequestOptions, OpenBoxTransport } from '../src/transport';

class SpanRecorder implements OpenBoxTransport {
  readonly spans: Array<{ statement: string; operation: string; stage: string; host: string | null }> = [];
  async request<T>(options: OpenBoxRequestOptions): Promise<T> {
    const body = (options.body ?? {}) as Record<string, unknown>;
    for (const span of (body.spans ?? []) as Array<Record<string, unknown>>) {
      if (span.db_system === 'redis') {
        this.spans.push({
          statement: String(span.db_statement ?? ''),
          operation: String(span.db_operation ?? ''),
          stage: String(span.stage ?? ''),
          host: (span.server_address as string | null) ?? null,
        });
      }
    }
    return { arm: 'allow' } as unknown as T;
  }
}

/**
 * A client shaped like node-redis v4: commands attached to the prototype with
 * the executor CAPTURED, exactly as `attachCommands` does — which is what made
 * patching the executor useless.
 */
function fakeV4Client(calls: string[]) {
  class RedisClient {
    options = { socket: { host: 'cache.internal', port: 6379 } };
    async commandsExecutor(command: unknown, args: unknown[], name: string) {
      calls.push(`${name}:${JSON.stringify(args)}`);
      return 'OK';
    }
    async connect() { calls.push('connect'); return this; }
  }
  const captured = RedisClient.prototype.commandsExecutor;
  for (const name of ['set', 'SET', 'get', 'GET']) {
    (RedisClient.prototype as unknown as Record<string, unknown>)[name] = function (
      this: unknown,
      ...args: unknown[]
    ) {
      return captured.call(this as RedisClient, {}, args, name);
    };
  }
  // The per-client subclass node-redis builds for module namespaces.
  class Commander extends RedisClient {}
  return new Commander();
}

const NAMES = ['set', 'SET', 'get', 'GET'];

async function withActivity(recorder: SpanRecorder, id: string, fn: () => Promise<void>) {
  registerActivity(
    id,
    { source: 'workflow-telemetry', event_type: 'ActivityStarted', activity_id: id, activity_type: 'tool', workflow_id: 'wf' } as never,
    recorder,
    'wf',
    { hitl: { enabled: false, pollIntervalMs: 1, timeoutMs: 1 }, onApiError: 'fail_open', logger: { warn: () => undefined }, requestTimeoutMs: 1_000 },
  );
  await runWithActivity(id, fn);
  await unregisterActivity(id);
}

describe('node-redis v4 typed commands', () => {
  it('produces a span pair, and still runs the command', async () => {
    const calls: string[] = [];
    const client = fakeV4Client(calls);
    const recorder = new SpanRecorder();
    expect(patchNodeRedisCommands(client as unknown as Record<string, unknown>, NAMES)).toBe(true);

    await withActivity(recorder, 'act-redis-v4', async () => {
      const reply = await (client as unknown as { set(k: string, v: string): Promise<string> }).set('status', 'green');
      expect(reply).toBe('OK');
    });

    expect(calls).toEqual(['set:["status","green"]']);
    expect(recorder.spans.map((s) => `${s.stage}:${s.statement}`)).toEqual([
      'started:SET status green',
      'completed:SET status green',
    ]);
    // Connection details come from the client, not the command.
    expect(recorder.spans[0].host).toBe('cache.internal');
  });

  it('leaves methods outside the command map alone', async () => {
    const calls: string[] = [];
    const client = fakeV4Client(calls);
    const recorder = new SpanRecorder();
    patchNodeRedisCommands(client as unknown as Record<string, unknown>, NAMES);

    await withActivity(recorder, 'act-redis-lifecycle', async () => {
      await (client as unknown as { connect(): Promise<unknown> }).connect();
    });

    expect(calls).toEqual(['connect']);
    expect(recorder.spans).toHaveLength(0);
  });

  it('does not put payloads in the statement', async () => {
    const calls: string[] = [];
    const client = fakeV4Client(calls);
    const recorder = new SpanRecorder();
    patchNodeRedisCommands(client as unknown as Record<string, unknown>, NAMES);

    await withActivity(recorder, 'act-redis-payload', async () => {
      await (client as unknown as { set(k: string, v: unknown): Promise<string> }).set(
        'blob',
        Buffer.from('0123456789'),
      );
    });

    expect(recorder.spans[0].statement).toBe('SET blob <10B>');
  });

  it('patches a prototype once, however many clients are created', () => {
    const calls: string[] = [];
    const client = fakeV4Client(calls);
    const proto = Object.getPrototypeOf(Object.getPrototypeOf(client)) as Record<string, unknown>;
    patchNodeRedisCommands(client as unknown as Record<string, unknown>, NAMES);
    const wrapped = proto.set;
    patchNodeRedisCommands(client as unknown as Record<string, unknown>, NAMES);
    expect(proto.set).toBe(wrapped);
  });

  it('reports nothing rather than guessing when the driver map is unavailable', () => {
    const client = fakeV4Client([]);
    expect(patchNodeRedisCommands(client as unknown as Record<string, unknown>, null)).toBe(false);
  });
});
