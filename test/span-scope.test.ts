/**
 * The activity scope must be active at the moment the engine performs I/O —
 * that is the only thing that makes `span_processor`'s fetch patch attribute a
 * request to an activity and record an http_request span.
 *
 * Consuming a run via `getText()` scoped correctly while `getTextStream()` did
 * not, because an async generator's body resumes in the CONSUMER's context
 * rather than the one it was created in. Against real Core that showed up as
 * 6 spans for a non-streaming run and 0 for the identical streaming one.
 */

import { describe, expect, it } from 'vitest';

import { createOpenBoxGovernance } from '../src/openrouter';
import { getCurrentActivityId } from '../src/span_processor';
import type { OpenBoxTransport } from '../src/transport';

const silentTransport: OpenBoxTransport = {
  async request() {
    return { arm: 'allow' } as never;
  },
};

function makeGovernance() {
  return createOpenBoxGovernance({
    transport: silentTransport,
    agentName: 'scope-test',
    instrumentHttp: false,
    instrumentDatabases: false,
    instrumentFileIo: false,
    logger: { warn: () => undefined },
  });
}

/** Engine stand-in whose "I/O" just records whether a scope was active. */
function engineReturning(result: unknown) {
  return async () => result;
}

describe('activity scope during result consumption', () => {
  it('is active inside a promise-returning method', async () => {
    const openbox = makeGovernance();
    let seen: string | undefined;

    const result = await openbox.callModel(
      engineReturning({
        async getText() {
          seen = getCurrentActivityId();
          return 'done';
        },
      }),
      {},
      { model: 'm', input: 'hi' },
    );

    await (result as { getText(): Promise<string> }).getText();
    expect(seen).toBeTruthy();
  });

  it('is active on every pull of an async iterable, not just its creation', async () => {
    const openbox = makeGovernance();
    const atCreation: Array<string | undefined> = [];
    const atPull: Array<string | undefined> = [];

    const result = await openbox.callModel(
      engineReturning({
        getTextStream() {
          atCreation.push(getCurrentActivityId());
          // An async generator: its body runs on next(), in the consumer's
          // context. This is the shape that silently lost every span.
          return (async function* () {
            for (const chunk of ['a', 'b', 'c']) {
              atPull.push(getCurrentActivityId());
              yield chunk;
            }
          })();
        },
      }),
      {},
      { model: 'm', input: 'hi' },
    );

    const chunks: string[] = [];
    for await (const c of (result as { getTextStream(): AsyncIterable<string> }).getTextStream()) {
      chunks.push(c);
    }

    expect(chunks).toEqual(['a', 'b', 'c']);
    expect(atCreation[0]).toBeTruthy();
    // The real assertion: every pull, not just the first, saw the scope.
    expect(atPull).toHaveLength(3);
    for (const id of atPull) expect(id).toBeTruthy();
  });

  it('does not invent iterator methods the underlying iterator lacks', async () => {
    const openbox = makeGovernance();

    // A hand-rolled next-only iterator. Adding a `return` here would make
    // `for await`'s early-exit cleanup call into something that never existed.
    const result = await openbox.callModel(
      engineReturning({
        stream() {
          let i = 0;
          return {
            [Symbol.asyncIterator]() {
              return { next: async () => (i < 2 ? { value: i++, done: false } : { value: undefined, done: true }) };
            },
          };
        },
      }),
      {},
      { model: 'm', input: 'hi' },
    );

    const it = (result as { stream(): AsyncIterable<number> }).stream()[Symbol.asyncIterator]();
    expect(it.return).toBeUndefined();
    expect(it.throw).toBeUndefined();
    expect(await it.next()).toEqual({ value: 0, done: false });
  });
});
