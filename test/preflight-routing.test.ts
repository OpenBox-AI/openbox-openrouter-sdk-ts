/**
 * Routing to the model — deciding where a prompt may go before it goes there.
 *
 * The provenance record answers "who served this call", and can only answer it
 * afterwards. These tests cover the half that exists BEFORE the request: where
 * the call is routed, governed as its own activity so a policy can redirect it,
 * refuse it, or let it through — while refusing still means the prompt was
 * never transmitted.
 *
 * Two things are worth being strict about, and both are asserted here:
 *
 *   - a directive may only ever REMOVE destinations, never add one;
 *   - a directive that cannot be applied is refused, not ignored. Silently
 *     dropping a routing constraint is the exact failure this feature exists
 *     to make impossible.
 */

import { describe, expect, it } from 'vitest';

import { createOpenBoxGovernance } from '../src/openrouter';
import {
  applyRoutingToRequest,
  describeResolution,
  narrowRouting,
  readRoutingDirective,
  routingIntentAttributes,
} from '../src/preflight_routing';
import type { OpenBoxRequestOptions, OpenBoxTransport } from '../src/transport';
import type { GovernanceVerdictResponse, OpenBoxGovernanceEvent } from '../src/types';

// ── the directive a policy sends ────────────────────────────────────────────

describe('reading a routing directive off a verdict', () => {
  it('reads the flat spelling', () => {
    expect(
      readRoutingDirective({
        arm: 'constrain',
        patch: { routing: { only: ['openai'], allow_fallbacks: false } },
      }),
    ).toEqual({ only: ['openai'], allowFallbacks: false });
  });

  it('reads the nested spelling, and the patch itself', () => {
    expect(
      readRoutingDirective({ arm: 'constrain', patch: { routing: { provider: { only: ['azure'] } } } }),
    ).toEqual({ only: ['azure'] });
    expect(
      readRoutingDirective({ arm: 'constrain', patch: { provider: { only: ['azure'] } } }),
    ).toEqual({ only: ['azure'] });
  });

  it('reads one off a block, which is the arm Core carries a patch on', () => {
    expect(
      readRoutingDirective({ arm: 'block', patch: { routing: { only: ['openai'] } } }),
    ).toEqual({ only: ['openai'] });
  });

  it('does not read one off an allow', () => {
    // A directive on `allow` would be a policy that says yes and rewrites the
    // request anyway — indistinguishable, from the caller's side, from the SDK
    // changing their request on its own initiative.
    for (const arm of ['allow', 'monitor']) {
      expect(readRoutingDirective({ arm, patch: { routing: { only: ['openai'] } } })).toBeNull();
    }
  });

  it('ignores a patch that is about something else', () => {
    expect(
      readRoutingDirective({ arm: 'constrain', patch: { new_input: { amount: 5 } } }),
    ).toBeNull();
    expect(readRoutingDirective({ arm: 'constrain' })).toBeNull();
    expect(readRoutingDirective(null)).toBeNull();
  });
});

// ── narrowing ───────────────────────────────────────────────────────────────

describe('a directive may only narrow', () => {
  it('intersects the allowlists', () => {
    const result = narrowRouting(
      { only: ['openai', 'azure', 'together'] },
      { only: ['openai', 'azure', 'anthropic'] },
    );
    expect(result.routing.only).toEqual(['openai', 'azure']);
    expect(result.satisfiable).toBe(true);
    expect(result.changed).toBe(true);
    // `anthropic` was never the caller's to grant, so it is not in the result.
    expect(result.routing.only).not.toContain('anthropic');
    expect(result.removed).toEqual(['together']);
  });

  it('constrains a request that declared nothing', () => {
    const result = narrowRouting(null, { only: ['openai'] });
    expect(result.routing.only).toEqual(['openai']);
    expect(result.changed).toBe(true);
    expect(result.satisfiable).toBe(true);
  });

  it('is unsatisfiable when the two allowlists are disjoint', () => {
    // Nowhere left to send the prompt. Resolving it either way would mean
    // silently overruling the policy or the caller.
    const result = narrowRouting({ only: ['azure'] }, { only: ['openai'] });
    expect(result.satisfiable).toBe(false);
    expect(result.routing.only).toEqual([]);
  });

  it('cannot switch fallbacks back on', () => {
    expect(
      narrowRouting({ only: ['openai'], allowFallbacks: false }, { allowFallbacks: true })
        .routing.allowFallbacks,
    ).toBe(false);
    // …but can turn them off for a caller who left them on.
    expect(
      narrowRouting({ only: ['openai'] }, { allowFallbacks: false }).routing.allowFallbacks,
    ).toBe(false);
  });

  it('reports no change when the request already complies', () => {
    // This is what keeps a multi-turn run alive under a routing policy: once
    // the pre-flight turn is narrowed, later turns state the narrowed
    // constraint and the same directive becomes a no-op.
    const result = narrowRouting({ only: ['OpenAI'] }, { only: ['openai'] });
    expect(result.changed).toBe(false);
    expect(result.satisfiable).toBe(true);
  });

  it('compares model fallback chains the same way', () => {
    expect(
      narrowRouting({ models: ['a', 'b'] }, { models: ['b', 'c'] }).routing.models,
    ).toEqual(['b']);
    expect(narrowRouting({ models: ['a'] }, { models: ['c'] }).satisfiable).toBe(false);
  });
});

describe('writing the constraint into the request', () => {
  it('reaches the request body as OpenRouter reads it', () => {
    const request = { model: 'openai/gpt-4o-mini', input: 'hi' };
    const routed = applyRoutingToRequest(request, {
      only: ['openai'],
      allowFallbacks: false,
    }) as Record<string, unknown>;
    expect(routed.provider).toEqual({ only: ['openai'], allow_fallbacks: false });
    // The caller's object is not mutated — the engine gets a copy.
    expect((request as Record<string, unknown>).provider).toBeUndefined();
  });

  it('keeps provider fields it does not govern', () => {
    const routed = applyRoutingToRequest(
      { provider: { sort: 'throughput', only: ['azure'] } },
      { only: ['openai'] },
    ) as Record<string, unknown>;
    expect(routed.provider).toEqual({ sort: 'throughput', only: ['openai'] });
  });
});

describe('what the completed half says', () => {
  it('names where the call went, and who decided', () => {
    expect(describeResolution({ only: ['openai'] }, null)).toBe('routed via openai');
    expect(describeResolution({ only: ['openai'] }, 'openai only')).toBe(
      'routed via openai — narrowed by policy: openai only',
    );
    // An unconstrained call is stated as such rather than left blank: "any
    // provider may serve it" is the fact a reader needs, not an empty field.
    expect(describeResolution(null, null)).toContain('no provider constraint');
  });
});

describe('the pre-flight claim', () => {
  it('states that nothing was constrained, rather than staying silent', () => {
    // An absent attribute and an attribute asserting "this caller constrained
    // nothing" are different claims, and only the second one is refusable.
    const attrs = routingIntentAttributes('openai/gpt-4o-mini', null);
    expect(attrs['openbox.routing.declared']).toBe(false);
    expect(attrs['gen_ai.request.model']).toBe('openai/gpt-4o-mini');
  });

  it('uses the same vocabulary as the provenance record', () => {
    const attrs = routingIntentAttributes('x', { only: ['openai'], allowFallbacks: false });
    expect(attrs['openbox.routing.declared']).toBe(true);
    expect(attrs['openbox.routing.requested_only']).toEqual(['openai']);
    expect(attrs['openbox.routing.allow_fallbacks']).toBe(false);
    expect(attrs['openbox.routing.stage']).toBe('preflight');
  });
});

// ── the gate, end to end ────────────────────────────────────────────────────

interface Sent {
  path: string;
  body: Record<string, unknown>;
}

/** The routing span on an event body, whichever event carries it. */
function routingSpanOf(body: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(body.spans)) return null;
  const span = body.spans[0] as Record<string, unknown> | undefined;
  return span?.hook_type === 'llm_routing_request' ? span : null;
}

/**
 * Replies `allow` to everything except the routing activity's own start, which
 * is answered by `routingVerdict` — that event is the gate.
 */
class FakeTransport implements OpenBoxTransport {
  readonly sent: Sent[] = [];
  routingVerdict: (span: Record<string, unknown>) => GovernanceVerdictResponse = () => ({
    arm: 'allow',
  });
  private answered = false;

  async request<T>(options: OpenBoxRequestOptions): Promise<T> {
    const body = (options.body ?? {}) as Record<string, unknown>;
    this.sent.push({ path: options.path, body });
    const span = routingSpanOf(body);
    // The gate is the model call's own verdict: a policy refuses the call AS
    // ROUTED and says where it may go instead. Answered once, and never on a
    // hook span — those are the record of what the SDK did, not the question.
    if (span != null && body.hook_trigger !== true && !this.answered) {
      this.answered = true;
      return this.routingVerdict(span) as T;
    }
    return { arm: 'allow' } as T;
  }

  /** The claim a policy decides on, carried by the model call's own event. */
  routingClaims(): Record<string, unknown>[] {
    return this.sent
      .filter((s) => s.body.hook_trigger !== true)
      .map((s) => routingSpanOf(s.body))
      .filter((span): span is Record<string, unknown> => span != null);
  }

  /** The record of where the call was routed — the rows inside the call. */
  routingRecord(): Record<string, unknown>[] {
    return this.sent
      .filter((s) => s.body.hook_trigger === true)
      .map((s) => routingSpanOf(s.body))
      .filter((span): span is Record<string, unknown> => span != null);
  }

  /** Events of the routing activity, in order. */
  routingEvents(): OpenBoxGovernanceEvent[] {
    return this.events().filter((e) => e.activity_type === 'llm_routing');
  }

  events(): OpenBoxGovernanceEvent[] {
    return this.sent
      .filter((s) => s.path.endsWith('/evaluate') && s.body.hook_trigger !== true)
      .map((s) => s.body as unknown as OpenBoxGovernanceEvent);
  }

  /** The SDK's own event names — the wire form collapses LLM* to Activity*. */
  eventTypes(): string[] {
    return this.events().map((e) => {
      const meta = e.metadata as Record<string, unknown> | undefined;
      return String(meta?.sdk_event_type ?? e.event_type);
    });
  }
}

function options(transport: OpenBoxTransport) {
  return {
    transport,
    agentName: 'test-agent',
    instrumentHttp: false,
    instrumentDatabases: false,
    instrumentFileIo: false,
    hitl: { pollIntervalMs: 1, timeoutMs: 2000 },
    logger: { warn: () => undefined },
  };
}

/** A `callModel` that records the request it was handed and answers trivially. */
function fakeCallModel(seen: Record<string, unknown>[]) {
  return (_client: unknown, request: Record<string, unknown>) => {
    seen.push(request);
    return { getText: async () => 'ok' };
  };
}

/**
 * A `callModel` that also replays the engine's hooks, so the model call closes
 * the way a real one does. Needed wherever the completion itself is under test
 * — a run torn down mid-flight closes its llm_call as an orphan instead.
 */
function fakeEngine(seen: Record<string, unknown>[]) {
  return async (_client: unknown, request: Record<string, unknown>) => {
    seen.push(request);
    const hooks = request.hooks as Record<string, Array<{ handler: Function }>>;
    const ctx = { signal: new AbortController().signal, hookName: '', sessionId: 's1' };
    const fire = async (name: string, payload: unknown) => {
      for (const entry of hooks[name] ?? []) await entry.handler(payload, ctx);
    };
    await fire('PostModelCall', {
      sessionId: 's1',
      responseId: 'resp_1',
      model: 'openai/gpt-4o-mini',
      durationMs: 250,
      turnType: 'final',
      turnNumber: 1,
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    });
    await fire('SessionEnd', { reason: 'complete' });
    return { getText: async () => 'ok' };
  };
}

describe('routing to the model', () => {
  it('states where a call is routed on the call itself', async () => {
    const transport = new FakeTransport();
    const openbox = createOpenBoxGovernance(options(transport));
    const seen: Record<string, unknown>[] = [];

    const result = await openbox.callModel(fakeCallModel(seen) as never, {}, {
      model: 'openai/gpt-4o-mini',
      input: 'hi',
      provider: { only: ['openai'] },
    } as never);
    await (result as { getText(): Promise<string> }).getText();
    await openbox.close();

    const span = transport.routingClaims()[0];
    // The name says where, not what: a row called "routing" under a model call
    // tells a reader nothing they cannot already see.
    expect(span.name).toBe('routing to openai (openai/gpt-4o-mini)');
    expect((span.status as Record<string, unknown>).description).toBe("it's being routed");
    expect(span.attributes).toMatchObject({
      'openbox.routing.declared': true,
      'openbox.routing.requested_only': ['openai'],
      'gen_ai.request.model': 'openai/gpt-4o-mini',
    });

    // Nothing extra on the wire: an ordinary call is one llm_call, the routing
    // claim rides along on the events it already sends, and nothing is recorded
    // because nothing was redirected.
    expect(transport.routingEvents()).toHaveLength(0);
    expect(transport.routingRecord()).toHaveLength(0);
    expect(transport.eventTypes().filter((t) => t === 'LLMStarted')).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });

  it('refuses the call as routed, then runs the corrected one', async () => {
    const transport = new FakeTransport();
    transport.routingVerdict = () => ({
      arm: 'block',
      reason: 'this agent may only use openai',
      patch: { new_input: { provider: { only: ['openai'] } } },
    });
    const openbox = createOpenBoxGovernance(options(transport));
    const seen: Record<string, unknown>[] = [];

    const result = await openbox.callModel(fakeEngine(seen) as never, {}, {
      model: 'openai/gpt-4o-mini',
      input: 'hi',
    } as never);
    await (result as { getText(): Promise<string> }).getText();
    await openbox.close();

    // A blocked activity must not go on to execute, so the refused attempt is
    // closed, the routing happens as its own step, and the corrected call is a
    // new one — evaluated fresh, allowed, and the only one that runs.
    expect(transport.eventTypes()).toEqual([
      'WorkflowStarted',
      'SignalReceived',
      'LLMStarted',       // refused as routed — nothing was sent under this one
      'LLMCompleted',     // …and it is closed, not resumed
      'ActivityStarted',  // llm_routing — where it may go instead
      'ActivityCompleted',
      'LLMStarted',       // the corrected call
      'LLMCompleted',
      'WorkflowCompleted',
    ]);
    expect(transport.routingEvents().map((e) => e.event_type)).toEqual([
      'ActivityStarted',
      'ActivityCompleted',
    ]);

    // The refused pair agrees with itself: a start that says BLOCK and a
    // completion that says ALLOW would be a record contradicting itself.
    const refusedClose = transport
      .events()
      .find((e) => e.activity_type === 'llm_call' && e.status === 'failed');
    expect(refusedClose).toBeDefined();
    expect(routingSpanOf(refusedClose as never)).not.toBeNull();

    // Both halves of the routing, under the routing step — recorded through the
    // hook path, the only one Core persists.
    expect(transport.routingRecord()).toHaveLength(2);
    const [started, completed] = transport.routingRecord();
    expect(started.span_id).toBe(completed.span_id);
    expect(started.stage).toBe('started');
    expect(completed.stage).toBe('completed');
    expect(started.name).toBe('routing to openai (openai/gpt-4o-mini)');
    expect((started.status as Record<string, unknown>).description).toBe("it's being routed");
    expect(started.activity_id).toBe(completed.activity_id);
    expect((completed.status as Record<string, unknown>).description).toBe(
      'routed via openai — narrowed by policy: this agent may only use openai',
    );
    // The completed half carries the routing's own clock, so it sorts before
    // the HTTP spans of the call it preceded rather than after them.
    expect(completed.start_time).toBeLessThanOrEqual(completed.end_time as number);

    // The record keeps what was asked for, as evidence rather than as a claim
    // about where this call may go.
    expect((started.attributes as Record<string, unknown>)['openbox.routing.redirected_from'])
      .toBe('no provider allowlist');
    expect((started.attributes as Record<string, unknown>)['openbox.routing.requested_only'])
      .toEqual(['openai']);

    // And the call that ran was the corrected one.
    expect(seen).toHaveLength(1);
    expect(seen[0].provider).toEqual({ only: ['openai'] });
  });

  it('narrows the request the engine is given', async () => {
    const transport = new FakeTransport();
    transport.routingVerdict = () => ({
      arm: 'constrain',
      reason: 'this agent may only use openai',
      patch: { routing: { only: ['openai'], allow_fallbacks: false } },
    });
    const openbox = createOpenBoxGovernance(options(transport));
    const seen: Record<string, unknown>[] = [];

    const result = await openbox.callModel(fakeCallModel(seen) as never, {}, {
      model: 'openai/gpt-4o-mini',
      input: 'hi',
    } as never);
    await (result as { getText(): Promise<string> }).getText();
    await openbox.close();

    // The constraint reached the request, not just the telemetry.
    expect(seen[0].provider).toEqual({ only: ['openai'], allow_fallbacks: false });
  });

  it('refuses the call when the policy and the request are disjoint', async () => {
    const transport = new FakeTransport();
    transport.routingVerdict = () => ({
      arm: 'constrain',
      patch: { routing: { only: ['openai'] } },
    });
    const openbox = createOpenBoxGovernance(options(transport));
    const seen: Record<string, unknown>[] = [];

    await expect(
      openbox.callModel(fakeCallModel(seen) as never, {}, {
        model: 'openai/gpt-4o-mini',
        input: 'hi',
        provider: { only: ['azure'] },
      } as never),
    ).rejects.toThrow(/no provider in common/);
    await openbox.close();

    // The point of routing before the request exists: the engine was never
    // called, so no prompt was transmitted.
    expect(seen).toHaveLength(0);
    // …the refused llm_call was closed rather than left open on Core, and its
    // routing step never completed, because it was never routed anywhere.
    expect(transport.eventTypes()).toContain('LLMCompleted');
    expect(transport.routingEvents()).toHaveLength(0);
  });

  it('applies a directive carried on a block, and lets the call proceed', async () => {
    // Core attaches a remediation directive to a block, so this is the shape a
    // real routing policy arrives in: refused as routed, here is where instead.
    const transport = new FakeTransport();
    transport.routingVerdict = () => ({
      arm: 'block',
      reason: 'this agent may only use openai',
      patch: { routing: { only: ['openai'] } },
    });
    const openbox = createOpenBoxGovernance(options(transport));
    const seen: Record<string, unknown>[] = [];

    const result = await openbox.callModel(fakeCallModel(seen) as never, {}, {
      model: 'openai/gpt-4o-mini',
      input: 'hi',
    } as never);
    await (result as { getText(): Promise<string> }).getText();
    await openbox.close();

    expect(seen[0].provider).toEqual({ only: ['openai'] });
  });

  it('refuses a block that says no and nothing else', async () => {
    const transport = new FakeTransport();
    transport.routingVerdict = () => ({ arm: 'block', reason: 'routing not declared' });
    const openbox = createOpenBoxGovernance(options(transport));
    const seen: Record<string, unknown>[] = [];

    await expect(
      openbox.callModel(fakeCallModel(seen) as never, {}, {
        model: 'openai/gpt-4o-mini',
        input: 'hi',
      } as never),
    ).rejects.toThrow(/routing not declared/);
    await openbox.close();

    expect(seen).toHaveLength(0);
  });

  it('stops the run on a halt, before anything is sent', async () => {
    const transport = new FakeTransport();
    transport.routingVerdict = () => ({ arm: 'halt', reason: 'routing not attested' });
    const openbox = createOpenBoxGovernance(options(transport));
    const seen: Record<string, unknown>[] = [];

    await expect(
      openbox.callModel(fakeCallModel(seen) as never, {}, {
        model: 'openai/gpt-4o-mini',
        input: 'hi',
      } as never),
    ).rejects.toThrow(/routing not attested/);
    await openbox.close();

    expect(seen).toHaveLength(0);
    // A halt ends the run as failed, not as a clean completion.
    expect(transport.eventTypes()).toContain('WorkflowFailed');
  });

  it('is off when the caller turns it off', async () => {
    const transport = new FakeTransport();
    const openbox = createOpenBoxGovernance({ ...options(transport), preflightRouting: false });
    const seen: Record<string, unknown>[] = [];

    const result = await openbox.callModel(fakeCallModel(seen) as never, {}, {
      model: 'openai/gpt-4o-mini',
      input: 'hi',
    } as never);
    await (result as { getText(): Promise<string> }).getText();
    await openbox.close();

    expect(transport.routingClaims()).toHaveLength(0);
    expect(transport.routingRecord()).toHaveLength(0);
  });
});
