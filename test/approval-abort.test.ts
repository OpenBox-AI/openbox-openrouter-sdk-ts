/**
 * An approval wait can be aborted through `hitl.abortSignal`.
 *
 * An abort fails safe (the held operation does not run), ends the pause
 * between polls at once, cancels the poll request in flight, and is never
 * retried as if it were a transient poll failure.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { GovernanceClient } from '../src/client';
import { createOpenBoxGovernance } from '../src/openrouter';
import { FetchTransport, type OpenBoxRequestOptions, type OpenBoxTransport } from '../src/transport';
import type { OpenBoxGovernanceEvent } from '../src/types';
import { ApprovalWaitAbortedError, sleepUnlessAborted } from '../src/wait';

/** Holds the `payment` tool for approval; every poll answers "still pending". */
class PendingApprovalTransport implements OpenBoxTransport {
  polls = 0;
  /** Resolves when the first poll arrives, so a test can abort mid-wait. */
  firstPoll: Promise<void>;
  private markFirstPoll!: () => void;

  constructor(private readonly hangPolls = false) {
    this.firstPoll = new Promise((resolve) => (this.markFirstPoll = resolve));
  }

  async request<T>(options: OpenBoxRequestOptions): Promise<T> {
    if (options.path.endsWith('/approval')) {
      this.polls += 1;
      this.markFirstPoll();
      if (this.hangPolls) {
        // A poll that only ends when its signal aborts.
        await new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      return {} as T;
    }
    const event = (options.body ?? {}) as OpenBoxGovernanceEvent;
    return (
      event.tool_name === 'payment' && event.status == null
        ? { arm: 'require_approval' }
        : { arm: 'allow' }
    ) as T;
  }
}

function governed(transport: OpenBoxTransport, abortSignal: AbortSignal, onApiError?: 'fail_open' | 'fail_closed') {
  return createOpenBoxGovernance({
    transport,
    agentName: 'test-agent',
    instrumentHttp: false,
    instrumentDatabases: false,
    instrumentFileIo: false,
    onApiError,
    // A long interval: if the abort did not end the pause, the test would time out.
    hitl: { pollIntervalMs: 60_000, timeoutMs: 600_000, abortSignal },
    logger: { warn: () => undefined },
  });
}

/** Run the held `payment` tool inside a model call; returns the tool's outcome. */
async function runPayment(transport: PendingApprovalTransport, controller: AbortController, onApiError?: 'fail_open' | 'fail_closed') {
  const openbox = governed(transport, controller.signal, onApiError);
  let ran = false;
  const [payment] = openbox.tools([
    {
      name: 'payment',
      execute: async () => {
        ran = true;
        return 'charged';
      },
    },
  ]);
  let outcome: unknown;
  const engine = async () => {
    outcome = await (payment.execute as (input: unknown) => Promise<unknown>)({ amount: 10 }).catch(
      (err: unknown) => err,
    );
    return { ok: true };
  };
  await openbox.callModel(engine, {}, { model: 'm', input: 'pay' });
  return { outcome, ran: () => ran };
}

describe('approval wait abort', () => {
  it('ends the pause between polls at once and does not run the tool', async () => {
    const transport = new PendingApprovalTransport();
    const controller = new AbortController();
    void transport.firstPoll.then(() => setTimeout(() => controller.abort(), 20));

    const started = Date.now();
    const { outcome, ran } = await runPayment(transport, controller);

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(String(outcome)).toMatch(/Approval wait aborted for activity payment/);
    expect(ran()).toBe(false);
    expect(transport.polls).toBe(1);
  });

  it.each(['fail_open', 'fail_closed'] as const)(
    'cancels the poll in flight and fails safe under %s, without retrying',
    async (onApiError) => {
      const transport = new PendingApprovalTransport(true);
      const controller = new AbortController();
      void transport.firstPoll.then(() => controller.abort());

      const { outcome, ran } = await runPayment(transport, controller, onApiError);

      expect(String(outcome)).toMatch(/Approval wait aborted/);
      expect(ran()).toBe(false);
      expect(transport.polls).toBe(1);
    },
  );

  it('does not poll at all when the signal is already aborted', async () => {
    const transport = new PendingApprovalTransport();
    const controller = new AbortController();
    controller.abort();

    const { outcome, ran } = await runPayment(transport, controller);

    expect(String(outcome)).toMatch(/Approval wait aborted/);
    expect(ran()).toBe(false);
    expect(transport.polls).toBe(0);
  });
});

describe('sleepUnlessAborted', () => {
  it('resolves after the interval when nothing aborts', async () => {
    await expect(sleepUnlessAborted(5, new AbortController().signal)).resolves.toBeUndefined();
    await expect(sleepUnlessAborted(5)).resolves.toBeUndefined();
  });

  it('rejects as soon as the signal aborts', async () => {
    const controller = new AbortController();
    const pause = sleepUnlessAborted(60_000, controller.signal);
    controller.abort();
    await expect(pause).rejects.toBeInstanceOf(ApprovalWaitAbortedError);
  });
});

describe('FetchTransport cancellation', () => {
  let server: Server | undefined;
  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  it('cancels an in-flight approval poll when the caller aborts', async () => {
    // A Core that accepts the request and never answers.
    server = createServer(() => undefined);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const client = new GovernanceClient(new FetchTransport({ openboxUrl: url, apiKey: 'obx_test' }), 't');

    const controller = new AbortController();
    const poll = client.pollApproval('wf', 'run', 'act', undefined, 'fail_closed', controller.signal);
    setTimeout(() => controller.abort(), 20);

    const started = Date.now();
    await expect(poll).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
