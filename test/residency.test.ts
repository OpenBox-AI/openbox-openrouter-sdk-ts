/**
 * Data residency: where the call was processed, against the regions approved.
 *
 * The comparison this covers is the one the provider check already has and the
 * region fields never did — and the cases that matter most are the ones where
 * the honest answer is "unchecked", because a residency claim that quietly
 * reports approval for a region nobody reported is worse than no claim at all.
 */

import { describe, expect, it } from 'vitest';

import {
  describeResidency,
  describeResidencyOutcome,
  isOwnKeyHonored,
  isRegionApproved,
  narrowResidency,
  readResidency,
  readResidencyDirective,
  residencyAttributes,
} from '../src/residency';
import { normalizeGenerationRecord, provenanceAttributes } from '../src/provenance';
import { routingIntentAttributes, routingSpan } from '../src/preflight_routing';

describe('reading a residency constraint', () => {
  it('reads the nested spelling a policy author writes', () => {
    expect(readResidency({ residency: { regions: ['eu'], require_own_key: true } })).toEqual({
      regions: ['eu'],
      requireOwnKey: true,
    });
  });

  it('reads the flat spelling, and the attribute name it was copied from', () => {
    expect(readResidency({ regions: ['eu', 'us'] })).toEqual({ regions: ['eu', 'us'] });
    expect(readResidency({ approved_regions: ['eu'] })).toEqual({ regions: ['eu'] });
  });

  it('is null for an object that says nothing about residency', () => {
    expect(readResidency({ orderId: 'A-1003', amount: 5 })).toBeNull();
    expect(readResidency(null)).toBeNull();
  });

  it('takes a directive off a refusing arm only', () => {
    const patch = { new_input: { residency: { regions: ['eu'] } } };
    expect(readResidencyDirective({ verdict: 'BLOCK', patch })).toEqual({ regions: ['eu'] });
    expect(readResidencyDirective({ verdict: 'CONSTRAIN', patch })).toEqual({ regions: ['eu'] });
    // A policy that says yes and rewrites the run's constraints anyway is
    // indistinguishable from the SDK inventing them.
    expect(readResidencyDirective({ verdict: 'ALLOW', patch })).toBeNull();
  });

  it('reads a residency directive that rides alongside a routing one', () => {
    const response = {
      verdict: 'BLOCK',
      patch: {
        new_input: { provider: { only: ['openai'] }, residency: { regions: ['us'] } },
      },
    };
    expect(readResidencyDirective(response)).toEqual({ regions: ['us'] });
  });
});

describe('narrowing', () => {
  it('intersects regions and never widens them', () => {
    const first = narrowResidency(null, { regions: ['eu', 'us'] });
    expect(first.residency.regions).toEqual(['eu', 'us']);
    const second = narrowResidency(first.residency, { regions: ['us', 'apac'] });
    expect(second.residency.regions).toEqual(['us']);
    expect(second.satisfiable).toBe(true);
  });

  it('reports an empty intersection rather than resolving it', () => {
    const narrowed = narrowResidency({ regions: ['eu'] }, { regions: ['us'] });
    expect(narrowed.residency.regions).toEqual([]);
    expect(narrowed.satisfiable).toBe(false);
  });

  it('cannot switch an own-key requirement back off', () => {
    const narrowed = narrowResidency({ requireOwnKey: true }, { requireOwnKey: false });
    expect(narrowed.residency.requireOwnKey).toBe(true);
  });

  it('reports no change when the directive restates what is already in force', () => {
    expect(narrowResidency({ regions: ['EU'] }, { regions: ['eu'] }).changed).toBe(false);
  });
});

describe('the comparison', () => {
  it('approves a region on the list, case-insensitively', () => {
    expect(isRegionApproved('EU', { regions: ['eu'] })).toBe(true);
  });

  it('fails a region off the list', () => {
    expect(isRegionApproved('us', { regions: ['eu'] })).toBe(false);
  });

  it('is unchecked when no region was reported — never a pass', () => {
    expect(isRegionApproved(null, { regions: ['eu'] })).toBeNull();
  });

  it('is unchecked when the policy approved nothing in particular', () => {
    expect(isRegionApproved('us', null)).toBeNull();
    expect(isRegionApproved('us', { requireOwnKey: true })).toBeNull();
  });

  it('checks own-key usage only when the policy required it', () => {
    expect(isOwnKeyHonored(false, { requireOwnKey: true })).toBe(false);
    expect(isOwnKeyHonored(true, { requireOwnKey: true })).toBe(true);
    expect(isOwnKeyHonored(false, { regions: ['eu'] })).toBeNull();
    expect(isOwnKeyHonored(null, { requireOwnKey: true })).toBeNull();
  });
});

describe('the record', () => {
  const raw = {
    data: {
      provider_name: 'OpenAI',
      model: 'openai/gpt-4o-mini',
      data_region: 'us',
      is_byok: false,
      total_cost: 0.0001,
    },
  };

  it('judges the served region against the approved list', () => {
    const record = normalizeGenerationRecord('gen-1', raw, null, null, { regions: ['eu'] });
    expect(record.dataRegion).toBe('us');
    expect(record.regionHonored).toBe(false);
    expect(record.residency).toEqual({ regions: ['eu'] });
  });

  it('leaves the comparison unchecked with no approved list', () => {
    const record = normalizeGenerationRecord('gen-1', raw, null);
    expect(record.regionHonored).toBeNull();
    expect(record.ownKeyHonored).toBeNull();
  });

  it('carries both halves into the attested attributes', () => {
    const record = normalizeGenerationRecord('gen-1', raw, null, null, {
      regions: ['eu'],
      requireOwnKey: true,
    });
    const attrs = provenanceAttributes(record);
    expect(attrs['gen_ai.upstream.data_region']).toBe('us');
    expect(attrs['openbox.residency.approved_regions']).toEqual(['eu']);
    expect(attrs['openbox.residency.region_honored']).toBe(false);
    expect(attrs['openbox.residency.own_key_honored']).toBe(false);
  });

  it('omits the verdict keys it could not decide, rather than asserting null', () => {
    const record = normalizeGenerationRecord('gen-1', raw, null);
    const attrs = provenanceAttributes(record);
    expect('openbox.residency.region_honored' in attrs).toBe(false);
    expect('openbox.residency.own_key_honored' in attrs).toBe(false);
  });
});

describe('the pre-flight claim', () => {
  it('states the approved list before the call, so it cannot be chosen to fit', () => {
    const attrs = routingIntentAttributes('openai/gpt-4o-mini', null, { regions: ['eu'] });
    expect(attrs['openbox.residency.approved_regions']).toEqual(['eu']);
    expect(attrs['openbox.residency.declared']).toBe(true);
  });

  it('says so explicitly when there is no approved list — a refusable fact', () => {
    expect(residencyAttributes(null)['openbox.residency.declared']).toBe(false);
    expect(residencyAttributes({ requireOwnKey: true })['openbox.residency.declared']).toBe(false);
  });

  it('rides on the routing span, which is what Core hashes', () => {
    const span = routingSpan('act-1', 'started', 'openai/gpt-4o-mini', null, undefined, undefined, {
      regions: ['eu'],
    });
    const attrs = span.attributes as Record<string, unknown>;
    expect(attrs['openbox.residency.approved_regions']).toEqual(['eu']);
  });
});

describe('how it reads', () => {
  it('names the breach rather than staying silent', () => {
    expect(describeResidencyOutcome('us', false, { regions: ['eu'] })).toContain('NOT approved');
  });

  it('says unchecked when the region was never reported', () => {
    expect(describeResidencyOutcome(null, null, { regions: ['eu'] })).toContain('unchecked');
  });

  it('says nothing was promised when no list was stated', () => {
    expect(describeResidencyOutcome('us', null, null)).toContain('nothing was promised');
  });

  it('calls out a call billed to OpenRouter when your own key was required', () => {
    const line = describeResidencyOutcome('eu', false, { regions: ['eu'], requireOwnKey: true });
    expect(line).toContain('requires your own key');
  });

  it('describes an empty approved list as approving nowhere', () => {
    expect(describeResidency({ regions: [] })).toContain('no region is approved');
  });
});

// ── the gate, end to end ────────────────────────────────────────────────────

/**
 * The hole this covers, found by watching a real run on the dashboard: an
 * approved-region list can only reach the SDK on a BLOCK, and the SDK was
 * binding it and then letting the call proceed under the very activity Core
 * had just recorded as blocked. The dashboard showed an `llm_call` stamped
 * BLOCK with a 200 from OpenRouter nested inside it — a row contradicting
 * itself. Downgrading the verdict in-process does not unsay what Core wrote
 * down; the refused attempt has to be closed and a new one evaluated.
 */

import { createOpenBoxGovernance } from '../src/openrouter';
import type { GovernanceVerdictResponse, OpenBoxGovernanceEvent } from '../src/types';
import type { OpenBoxRequestOptions, OpenBoxTransport } from '../src/transport';

function routingSpanOf(body: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(body.spans)) return null;
  const span = body.spans[0] as Record<string, unknown> | undefined;
  return span?.hook_type === 'llm_routing_request' ? span : null;
}

/** Answers the model call's own verdict once — that event is the gate. */
class FakeTransport implements OpenBoxTransport {
  readonly sent: Array<{ path: string; body: Record<string, unknown> }> = [];
  verdict: (span: Record<string, unknown>) => GovernanceVerdictResponse = () => ({ arm: 'allow' });
  /** Answer every model call, not just the first — for the looping case. */
  alwaysAnswer = false;
  private answered = false;

  async request<T>(options: OpenBoxRequestOptions): Promise<T> {
    const body = (options.body ?? {}) as Record<string, unknown>;
    this.sent.push({ path: options.path, body });
    const span = routingSpanOf(body);
    if (span != null && body.hook_trigger !== true && (this.alwaysAnswer || !this.answered)) {
      this.answered = true;
      return this.verdict(span) as T;
    }
    return { arm: 'allow' } as T;
  }

  events(): OpenBoxGovernanceEvent[] {
    return this.sent
      .filter((s) => s.path.endsWith('/evaluate') && s.body.hook_trigger !== true)
      .map((s) => s.body as unknown as OpenBoxGovernanceEvent);
  }

  eventTypes(): string[] {
    return this.events().map((e) => {
      const meta = e.metadata as Record<string, unknown> | undefined;
      return String(meta?.sdk_event_type ?? e.event_type);
    });
  }

  /** The claims a policy decides on, in order — one per model-call attempt. */
  claims(): Record<string, unknown>[] {
    return this.sent
      .filter((s) => s.body.hook_trigger !== true)
      .map((s) => routingSpanOf(s.body))
      .filter((span): span is Record<string, unknown> => span != null);
  }

  /** The record of the routing step — the rows Core actually persists. */
  record(): Record<string, unknown>[] {
    return this.sent
      .filter((s) => s.body.hook_trigger === true)
      .map((s) => routingSpanOf(s.body))
      .filter((span): span is Record<string, unknown> => span != null);
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

function fakeEngine(seen: Record<string, unknown>[]) {
  return async (_client: unknown, request: Record<string, unknown>) => {
    seen.push(request);
    const hooks = request.hooks as Record<string, Array<{ handler: Function }>>;
    const ctx = { signal: new AbortController().signal, hookName: '', sessionId: 's1' };
    for (const entry of hooks.PostModelCall ?? []) {
      await entry.handler(
        {
          sessionId: 's1',
          responseId: 'resp_1',
          model: 'openai/gpt-4o-mini',
          durationMs: 250,
          turnType: 'final',
          turnNumber: 1,
          usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
        },
        ctx,
      );
    }
    for (const entry of hooks.SessionEnd ?? []) await entry.handler({ reason: 'complete' }, ctx);
    return { getText: async () => 'ok' };
  };
}

async function run(transport: FakeTransport): Promise<Record<string, unknown>[]> {
  const openbox = createOpenBoxGovernance(options(transport));
  const seen: Record<string, unknown>[] = [];
  const result = await openbox.callModel(fakeEngine(seen) as never, {}, {
    model: 'openai/gpt-4o-mini',
    input: 'hi',
  } as never);
  await (result as { getText(): Promise<string> }).getText();
  await openbox.close();
  return seen;
}

describe('a residency directive, end to end', () => {
  const approveEu = (): GovernanceVerdictResponse => ({
    arm: 'block',
    reason: 'this agent may only be processed in the eu',
    patch: { new_input: { residency: { regions: ['eu'] } } },
  });

  it('never executes under the activity Core recorded as blocked', async () => {
    const transport = new FakeTransport();
    transport.verdict = approveEu;
    const seen = await run(transport);

    // The refused attempt is closed, the residency is recorded as its own step,
    // and the call that actually runs is a NEW activity, evaluated fresh.
    expect(transport.eventTypes()).toEqual([
      'WorkflowStarted',
      'SignalReceived',
      'LLMStarted',      // refused — nothing was sent under this one
      'LLMCompleted',    // …closed as failed, not resumed
      'ActivityStarted', // llm_routing — the approved list, recorded
      'ActivityCompleted',
      'LLMStarted',      // the re-opened call
      'LLMCompleted',
      'WorkflowCompleted',
    ]);
    // Exactly one request reached the engine: the corrected one.
    expect(seen).toHaveLength(1);
  });

  it('closes the refused attempt as failed, on the claim it was refused on', async () => {
    const transport = new FakeTransport();
    transport.verdict = approveEu;
    await run(transport);

    const refused = transport
      .events()
      .find((e) => e.activity_type === 'llm_call' && e.status === 'failed');
    expect(refused).toBeDefined();
    expect(routingSpanOf(refused as never)).not.toBeNull();
    expect(
      JSON.stringify((refused as never as Record<string, unknown>).activity_output),
    ).toContain('nothing was sent');
  });

  it('re-opens the call carrying the approved list, so the policy can pass it', async () => {
    const transport = new FakeTransport();
    transport.verdict = approveEu;
    await run(transport);

    const claims = transport.claims();
    expect(claims.length).toBeGreaterThanOrEqual(2);
    // The refused attempt could not have known the list; the re-opened one does.
    const first = claims[0].attributes as Record<string, unknown>;
    const last = claims[claims.length - 1].attributes as Record<string, unknown>;
    expect(first['openbox.residency.approved_regions']).toBeUndefined();
    expect(last['openbox.residency.approved_regions']).toEqual(['eu']);
    expect(last['openbox.residency.declared']).toBe(true);
  });

  it('records the residency step, saying plainly that nothing enforces it', async () => {
    const transport = new FakeTransport();
    transport.verdict = approveEu;
    await run(transport);

    const [started, completed] = transport.record();
    expect(started.span_id).toBe(completed.span_id);
    expect((started.attributes as Record<string, unknown>)['openbox.residency.approved_regions'])
      .toEqual(['eu']);
    const description = String((completed.status as Record<string, unknown>).description);
    expect(description).toContain('to be processed in eu');
    expect(description).toContain('checked after the fact');
  });

  it('does not re-open for a directive the run already complies with', async () => {
    // The policy restates a list identical to what is already in force. There
    // is nothing to correct, so the block is spent rather than acted on — and
    // re-opening on it would loop the call forever.
    const transport = new FakeTransport();
    transport.alwaysAnswer = true;
    let calls = 0;
    transport.verdict = () => {
      calls += 1;
      // Bind on the first attempt, then restate the same list unchanged.
      return approveEu();
    };
    const seen = await run(transport);

    expect(seen).toHaveLength(1);
    expect(transport.eventTypes().filter((t) => t === 'LLMStarted')).toHaveLength(2);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
