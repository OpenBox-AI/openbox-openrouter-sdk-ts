/**
 * Core's patch directive: the remediation hint carried on a BLOCK.
 *
 * Verified against a real Core with an OPA policy returning
 * `{"decision": "BLOCK", "patch": {"new_input": …}}`. Core validated it,
 * stored it, and sent it on the verdict — and the SDK read it with nothing at
 * all. An agent blocked with "retry with the capped amount" told its user to
 * contact support, because the only part of the verdict that reached the model
 * was the reason.
 *
 * The SDK still never applies a patch itself: it surfaces the directive on the
 * error and in the message the model sees, and a retry the model chooses to
 * make is governed again like any other call.
 */

import { describe, expect, it } from 'vitest';

import { createOpenBoxGovernance } from '../src/openrouter';
import { GovernanceBlockedError, enforceVerdict, patchFrom, withPatchHint } from '../src/verdict';
import type { OpenBoxRequestOptions, OpenBoxTransport } from '../src/transport';
import type { GovernanceVerdictResponse } from '../src/types';

const blockWith = (patch: unknown): GovernanceVerdictResponse =>
  ({ arm: 'block', reason: 'over the limit', patch } as unknown as GovernanceVerdictResponse);

describe('a block carries its remediation directive', () => {
  it('puts the directive on the error and the suggestion in the message', () => {
    try {
      enforceVerdict(blockWith({ new_input: { orderId: 'A-1003', amount: 5 } }), 'tool_start');
      throw new Error('should have thrown');
    } catch (err) {
      const e = err as GovernanceBlockedError;
      expect(e).toBeInstanceOf(GovernanceBlockedError);
      expect(e.patch).toEqual({ new_input: { orderId: 'A-1003', amount: 5 } });
      // The model reads the message; this is what lets it retry.
      expect(e.message).toContain('over the limit');
      expect(e.message).toContain('policy suggests retrying with');
      expect(e.message).toContain('"amount":5');
    }
  });

  it('leaves a plain block exactly as it was', () => {
    try {
      enforceVerdict({ arm: 'block', reason: 'no' } as GovernanceVerdictResponse, 'tool_start');
      throw new Error('should have thrown');
    } catch (err) {
      const e = err as GovernanceBlockedError;
      expect(e.patch).toBeNull();
      expect(e.message).not.toContain('policy suggests');
    }
  });

  it('carries `new_input: null` as the directive it is — retry unchanged', () => {
    // Core distinguishes an absent field from a literal null: null means
    // "retry with the original input", so it is a directive, not a no-op.
    const patch = patchFrom({ patch: { new_input: null } });
    expect(patch).toEqual({ new_input: null });
    expect(withPatchHint('blocked', patch)).toContain('retrying with: null');
  });

  it('degrades to no directive when the field is not an object', () => {
    for (const bad of ['new_input', ['new_input'], 42, null, undefined]) {
      expect(patchFrom({ patch: bad })).toBeNull();
    }
    expect(withPatchHint('blocked', patchFrom({ patch: 'nope' }))).toBe('blocked');
  });

  it('adds nothing when the object carries no new_input at all', () => {
    expect(withPatchHint('blocked', { other: 1 })).toBe('blocked');
  });

  it('survives an unserializable suggestion rather than throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(withPatchHint('blocked', { new_input: cyclic })).toBe('blocked');
  });
});

describe('the directive reaches the model through a governed tool', () => {
  it('is in the error the tool body throws', async () => {
    const transport: OpenBoxTransport = {
      async request<T>(options: OpenBoxRequestOptions): Promise<T> {
        const body = (options.body ?? {}) as Record<string, unknown>;
        if (
          options.path.endsWith('/evaluate') &&
          body.event_type === 'ActivityStarted' &&
          body.activity_type === 'refund'
        ) {
          return {
            arm: 'block',
            reason: 'refund of 12 exceeds the limit of 5',
            patch: { new_input: { orderId: 'A-1003', amount: 5 } },
          } as unknown as T;
        }
        return { arm: 'allow' } as unknown as T;
      },
    };

    const openbox = createOpenBoxGovernance({
      transport,
      agentName: 'patch-test',
      instrumentHttp: false,
      instrumentDatabases: false,
      instrumentFileIo: false,
      logger: { warn: () => undefined },
    });

    let ran = false;
    const tools = openbox.tools([
      {
        type: 'function',
        function: {
          name: 'refund',
          execute: async () => { ran = true; return { ok: true }; },
        },
      },
    ]);

    let seen: unknown = null;
    await openbox.callModel(
      async (_c: unknown, request: Record<string, unknown>) => {
        const t = (request.tools as Array<{ function: { execute: Function } }>)[0];
        try {
          await t.function.execute({ orderId: 'A-1003', amount: 12 });
        } catch (err) {
          seen = err;
        }
        return { async getText() { return 'done'; } };
      },
      {},
      { model: 'm', input: 'refund it', tools },
    );
    await openbox.close();

    expect(ran).toBe(false);
    expect((seen as GovernanceBlockedError).patch).toEqual({
      new_input: { orderId: 'A-1003', amount: 5 },
    });
    expect((seen as Error).message).toContain('policy suggests retrying with');
  });
});
