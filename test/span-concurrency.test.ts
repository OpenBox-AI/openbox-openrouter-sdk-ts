/**
 * Span delivery: ordered per operation, concurrent across operations.
 *
 * Every span evaluation is a ~1s round-trip — Core starts a Temporal workflow
 * and waits for it — so how these are queued decides what a governed tool
 * costs. Chaining an activity's spans one behind the next serialized work that
 * has no ordering requirement: measured against a real Core, four INDEPENDENT
 * Postgres queries issued with `Promise.all` took 8.4s, exactly as long as
 * running them one at a time. The SDK was undoing the application's own
 * concurrency. Ordered per operation instead, the same tool takes 2.7s, with
 * both gates (pre-query and post-query) still applied to every query.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  evaluateActivitySpan,
  registerActivity,
  setSpanConcurrency,
  unregisterActivity,
} from '../src/span_processor';
import type { OpenBoxRequestOptions, OpenBoxTransport } from '../src/transport';

/** Transport that holds each evaluate open until released, recording overlap. */
class SlowTransport implements OpenBoxTransport {
  readonly started: string[] = [];
  readonly finished: string[] = [];
  inFlight = 0;
  maxInFlight = 0;
  private readonly gates: Array<() => void> = [];
  /** Fails any span whose name contains this. */
  failOn: string | null = null;

  async request<T>(options: OpenBoxRequestOptions): Promise<T> {
    const body = (options.body ?? {}) as Record<string, unknown>;
    const spans = (body.spans ?? []) as Array<Record<string, unknown>>;
    const label = String(spans[0]?.name ?? 'unknown');

    this.started.push(label);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise<void>((resolve) => this.gates.push(resolve));
    this.inFlight--;
    this.finished.push(label);

    if (this.failOn != null && label.includes(this.failOn)) throw new Error(`send failed: ${label}`);
    return { arm: 'allow' } as unknown as T;
  }

  /** Let every currently-held send complete. */
  releaseAll(): void {
    const gates = this.gates.splice(0, this.gates.length);
    for (const open of gates) open();
  }
}

/**
 * A fresh activity id per test: the duplicate-span cache and the send chains
 * are module state keyed by activity, so sharing one id would let a test
 * suppress its neighbour's spans.
 */
let ACTIVITY = 'act-spans';
let current: SlowTransport | null = null;
let counter = 0;

function register(transport: SlowTransport): void {
  ACTIVITY = `act-spans-${++counter}`;
  current = transport;
  registerActivity(
    ACTIVITY,
    {
      source: 'workflow-telemetry',
      event_type: 'ActivityStarted',
      activity_id: ACTIVITY,
      activity_type: 'tool',
      workflow_id: 'wf',
    } as never,
    transport,
    'wf',
    { hitl: { enabled: false, pollIntervalMs: 1, timeoutMs: 1 }, onApiError: 'fail_open', logger: { warn: () => undefined }, requestTimeoutMs: 1_000 },
  );
}

/** A db span for one operation, in the shape buildDbSpanData produces. */
const span = (spanId: string, stage: 'started' | 'completed') => ({
  span_id: spanId,
  trace_id: `${spanId}${spanId}`,
  name: `${spanId}:${stage}`,
  stage,
  hook_type: 'db_query',
  db_system: 'postgres',
  db_statement: `SELECT ${spanId} FROM ${ACTIVITY}`,
  activity_id: ACTIVITY,
});

/** Yield until `predicate` holds, so we assert on settled state, not timing. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`timed out waiting for ${label}`);
}

afterEach(async () => {
  // Release anything still held, or unregisterActivity would wait on a send
  // this test never let finish and take the whole file down with it.
  for (let i = 0; i < 10; i++) {
    current?.releaseAll();
    await new Promise((r) => setTimeout(r, 1));
  }
  current = null;
  setSpanConcurrency(4);
  await unregisterActivity(ACTIVITY).catch(() => undefined);
});

describe('span delivery', () => {
  it('evaluates different operations concurrently', async () => {
    const transport = new SlowTransport();
    register(transport);

    const sends = [
      evaluateActivitySpan(ACTIVITY, span('q1', 'started')),
      evaluateActivitySpan(ACTIVITY, span('q2', 'started')),
      evaluateActivitySpan(ACTIVITY, span('q3', 'started')),
    ];

    await until(() => transport.started.length === 3, 'three concurrent sends');
    expect(transport.maxInFlight).toBe(3);

    transport.releaseAll();
    await Promise.all(sends);
  });

  it('keeps one operation\'s stages in order', async () => {
    const transport = new SlowTransport();
    register(transport);

    const first = evaluateActivitySpan(ACTIVITY, span('q1', 'started'));
    const second = evaluateActivitySpan(ACTIVITY, span('q1', 'completed'));

    await until(() => transport.started.length === 1, 'the first stage to start');
    // The completed stage must NOT have been sent while started is in flight.
    expect(transport.started).toEqual(['q1:started']);

    transport.releaseAll();
    await until(() => transport.started.length === 2, 'the second stage to start');
    expect(transport.started).toEqual(['q1:started', 'q1:completed']);

    transport.releaseAll();
    await Promise.all([first, second]);
  });

  it('never exceeds the configured concurrency', async () => {
    const transport = new SlowTransport();
    setSpanConcurrency(2);
    register(transport);

    const sends = ['q1', 'q2', 'q3', 'q4', 'q5'].map((id) =>
      evaluateActivitySpan(ACTIVITY, span(id, 'started')),
    );

    await until(() => transport.started.length === 2, 'the first two sends');
    await new Promise((r) => setTimeout(r, 5));
    expect(transport.maxInFlight).toBe(2);

    // Drain: each release frees slots for the queued sends.
    for (let i = 0; i < 5; i++) {
      transport.releaseAll();
      await new Promise((r) => setTimeout(r, 2));
    }
    await Promise.all(sends);
    expect(transport.started).toHaveLength(5);
    expect(transport.maxInFlight).toBe(2);
  });

  it('restores strictly serial delivery at concurrency 1', async () => {
    const transport = new SlowTransport();
    setSpanConcurrency(1);
    register(transport);

    const sends = ['q1', 'q2', 'q3'].map((id) =>
      evaluateActivitySpan(ACTIVITY, span(id, 'started')),
    );

    await until(() => transport.started.length === 1, 'the first send');
    await new Promise((r) => setTimeout(r, 5));
    expect(transport.maxInFlight).toBe(1);

    for (let i = 0; i < 3; i++) {
      transport.releaseAll();
      await new Promise((r) => setTimeout(r, 2));
    }
    await Promise.all(sends);
    expect(transport.started).toEqual(['q1:started', 'q2:started', 'q3:started']);
  });

  it('does not let one failed send stall the operations beside it', async () => {
    const transport = new SlowTransport();
    transport.failOn = 'q1';
    register(transport);

    const failing = evaluateActivitySpan(ACTIVITY, span('q1', 'started'));
    const healthy = evaluateActivitySpan(ACTIVITY, span('q2', 'started'));

    await until(() => transport.started.length === 2, 'both sends');
    transport.releaseAll();

    // fail_open: the SDK swallows a transport failure rather than breaking the
    // tool, but the neighbour must complete either way.
    await Promise.allSettled([failing]);
    await expect(healthy).resolves.toBeUndefined();
  });
});
