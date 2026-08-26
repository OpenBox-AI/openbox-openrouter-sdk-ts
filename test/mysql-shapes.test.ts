/**
 * mysql2 has three ways to hand a query its result, and the patch only
 * understood one of them.
 *
 * Verified against a live MySQL 8 (the query path had never been run against a
 * real server): a POOL query produced a started span and no completion —
 * an orphan on Core for the most common way an application talks to MySQL —
 * because `Pool.query` builds the `Commands.Query` itself and passes the
 * connection ONE argument, with the callback inside it as `onResult`. The
 * event-style `conn.query(sql)` emitter had the same hole.
 *
 * The first fix then broke the ordinary callback path: mysql2 emits `end` on
 * the Query even when a callback is in play, and it fires first, so the
 * emitter fallback stole every completion and reported a null rowcount.
 */

import { describe, expect, it, vi } from 'vitest';

import { patchMysql2Exports } from '../src/node_instrumentation';
import { registerActivity, runWithActivity, unregisterActivity } from '../src/span_processor';
import type { OpenBoxRequestOptions, OpenBoxTransport } from '../src/transport';

interface Recorded { statement: string; stage: string; rowcount: unknown; error: unknown }

class SpanRecorder implements OpenBoxTransport {
  readonly spans: Recorded[] = [];
  async request<T>(options: OpenBoxRequestOptions): Promise<T> {
    const body = (options.body ?? {}) as Record<string, unknown>;
    for (const span of (body.spans ?? []) as Array<Record<string, unknown>>) {
      if (span.db_system === 'mysql') {
        this.spans.push({
          statement: String(span.db_statement ?? ''),
          stage: String(span.stage ?? ''),
          rowcount: span.rowcount ?? null,
          error: span.error ?? null,
        });
      }
    }
    return { arm: 'allow' } as unknown as T;
  }
  pairs(statement: string) {
    return this.spans.filter((s) => s.statement === statement);
  }
}

/** Minimal stand-in for mysql2's Connection, with its real query() shapes. */
function fakeMysql2(behaviour: 'callback' | 'onResult' | 'emitter', rows: unknown) {
  class FakeQuery {
    listeners = new Map<string, Array<(...a: unknown[]) => void>>();
    onResult?: (err: unknown, results: unknown, fields: unknown) => void;
    on(event: string, fn: (...a: unknown[]) => void) {
      const list = this.listeners.get(event) ?? [];
      list.push(fn);
      this.listeners.set(event, list);
      return this;
    }
    once(event: string, fn: (...a: unknown[]) => void) { return this.on(event, fn); }
    emit(event: string, ...a: unknown[]) {
      for (const fn of this.listeners.get(event) ?? []) fn(...a);
    }
  }

  class FakeConnection {
    config = { host: 'db.internal', port: 3306, database: 'inventory' };
    query(sql: unknown, ...args: unknown[]) {
      const q = new FakeQuery();
      if (sql instanceof FakeQuery) q.onResult = sql.onResult;
      // Resolve on the next tick, as a real driver does.
      setTimeout(() => {
        if (behaviour === 'callback') {
          const cb = args.find((a) => typeof a === 'function') as
            ((err: unknown, results: unknown, fields: unknown) => void) | undefined;
          // mysql2 emits `end` even when a callback is in play — and first.
          q.emit('end');
          cb?.(null, rows, []);
        } else if (behaviour === 'onResult') {
          const target = sql instanceof FakeQuery ? sql : q;
          q.emit('end');
          target.onResult?.(null, rows, []);
        } else {
          for (const row of rows as unknown[]) q.emit('result', row);
          q.emit('end');
        }
      }, 0);
      return q;
    }
    emit() { return true; }
  }

  patchMysql2Exports({ Connection: FakeConnection } as unknown as Record<string, unknown>);
  return { FakeConnection, FakeQuery };
}

const ROWS = [{ n: 1 }, { n: 2 }, { n: 3 }];

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

describe('mysql2 query result shapes', () => {
  it('reports a completion for query(sql, callback), with the row count', async () => {
    const recorder = new SpanRecorder();
    const { FakeConnection } = fakeMysql2('callback', ROWS);
    const conn = new FakeConnection();

    await withActivity(recorder, 'act-mysql-cb', async () => {
      await new Promise<void>((resolve) => {
        conn.query('SELECT cb FROM items', () => resolve());
      });
      await vi.waitFor(() => expect(recorder.pairs('SELECT cb FROM items')).toHaveLength(2));
    });

    const spans = recorder.pairs('SELECT cb FROM items');
    expect(spans.map((s) => s.stage).sort()).toEqual(['completed', 'started']);
    // The rowcount must come from the callback, not from the `end` event that
    // fires before it — that regression reported null for every query.
    expect(spans.find((s) => s.stage === 'completed')?.rowcount).toBe(3);
  });

  it('reports a completion for a pool-style query(queryObject)', async () => {
    const recorder = new SpanRecorder();
    const { FakeConnection, FakeQuery } = fakeMysql2('onResult', ROWS);
    const conn = new FakeConnection();

    await withActivity(recorder, 'act-mysql-pool', async () => {
      await new Promise<void>((resolve) => {
        // What Pool.query hands the connection: one argument, callback inside.
        const command = new FakeQuery();
        (command as unknown as { sql: string }).sql = 'SELECT pool FROM items';
        command.onResult = () => resolve();
        conn.query(command);
      });
      await vi.waitFor(() => expect(recorder.pairs('SELECT pool FROM items')).toHaveLength(2));
    });

    const spans = recorder.pairs('SELECT pool FROM items');
    expect(spans.map((s) => s.stage).sort()).toEqual(['completed', 'started']);
    expect(spans.find((s) => s.stage === 'completed')?.rowcount).toBe(3);
  });

  it('reports a completion for an event-style query with no callback', async () => {
    const recorder = new SpanRecorder();
    const { FakeConnection } = fakeMysql2('emitter', ROWS);
    const conn = new FakeConnection();

    await withActivity(recorder, 'act-mysql-stream', async () => {
      await new Promise<void>((resolve) => {
        const q = conn.query('SELECT stream FROM items');
        q.on('end', () => resolve());
      });
      await vi.waitFor(() => expect(recorder.pairs('SELECT stream FROM items')).toHaveLength(2));
    });

    const spans = recorder.pairs('SELECT stream FROM items');
    expect(spans.map((s) => s.stage).sort()).toEqual(['completed', 'started']);
    // Streamed rows are counted as they arrive; `end` carries none.
    expect(spans.find((s) => s.stage === 'completed')?.rowcount).toBe(3);
  });
});
