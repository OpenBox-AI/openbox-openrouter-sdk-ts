/**
 * Routing provenance — the record of which provider actually served a call.
 *
 * OpenRouter promises its users that prompts "only go to the models and
 * providers you trust", and separately that it will fall back across 80+
 * providers when one is down. Both cannot be verified by the caller: the
 * serving provider is chosen per request and never appears in the response.
 * These are the pure parts of turning that into evidence — reading the
 * routing the caller asked for, normalizing OpenRouter's generation record,
 * and flattening it into span attributes, which are what Core hashes into the
 * session's Merkle tree.
 */

import { describe, expect, it } from 'vitest';

import {
  extractRequestedModel,
  extractRequestedRouting,
  isModelHonored,
  isRoutingHonored,
  normalizeGenerationRecord,
  provenanceAttributes,
  readRequestedModel,
  readRequestedRouting,
} from '../src/provenance';

describe('requested routing', () => {
  it('reads the constraints a caller put on the request', () => {
    const body = JSON.stringify({
      model: 'anthropic/claude-sonnet-5',
      provider: { only: ['anthropic'], order: ['anthropic', 'bedrock'], allow_fallbacks: false },
      models: ['anthropic/claude-sonnet-5', 'openai/gpt-4o-mini'],
    });
    expect(extractRequestedRouting(body)).toEqual({
      only: ['anthropic'],
      order: ['anthropic', 'bedrock'],
      allowFallbacks: false,
      models: ['anthropic/claude-sonnet-5', 'openai/gpt-4o-mini'],
    });
  });

  it('returns null when the caller constrained nothing', () => {
    expect(extractRequestedRouting(JSON.stringify({ model: 'x', input: 'hi' }))).toBeNull();
    expect(extractRequestedRouting('not json')).toBeNull();
    expect(extractRequestedRouting(null)).toBeNull();
  });
});

describe('was the promise kept', () => {
  it('holds when the serving provider is in the allowlist, case aside', () => {
    expect(isRoutingHonored('Anthropic', { only: ['anthropic'] })).toBe(true);
    expect(isRoutingHonored('anthropic', { only: ['Anthropic', 'Bedrock'] })).toBe(true);
  });

  it('fails when it is not', () => {
    expect(isRoutingHonored('OpenAI', { only: ['anthropic'] })).toBe(false);
  });

  it('says nothing when nothing was promised', () => {
    // `order` is a preference, not a constraint — being served outside it is
    // not a broken promise, and reporting it as one would be a false claim.
    expect(isRoutingHonored('OpenAI', { order: ['anthropic'] })).toBeNull();
    expect(isRoutingHonored('OpenAI', null)).toBeNull();
    expect(isRoutingHonored(null, { only: ['anthropic'] })).toBeNull();
  });
});

describe('the generation record', () => {
  const raw = {
    data: {
      provider_name: 'OpenAI',
      model: 'openai/gpt-4o-mini',
      data_region: 'global',
      total_cost: 0.00003675,
      upstream_inference_cost: 0,
      tokens_prompt: 339,
      tokens_completion: 19,
      latency: 655,
      finish_reason: 'tool_calls',
      is_byok: false,
      provider_responses: [
        { provider_name: 'Azure', status: 503, error: 'upstream unavailable' },
        { provider_name: 'OpenAI', status: 200 },
      ],
    },
  };

  it('normalizes what OpenRouter returns, unwrapping `data`', () => {
    const p = normalizeGenerationRecord('gen-1', raw, { only: ['openai'] });
    expect(p.provider).toBe('OpenAI');
    expect(p.dataRegion).toBe('global');
    expect(p.totalCost).toBeCloseTo(0.00003675);
    expect(p.latencyMs).toBe(655);
    expect(p.isByok).toBe(false);
    expect(p.honored).toBe(true);
  });

  it('keeps the failover trail — which providers were tried first', () => {
    const p = normalizeGenerationRecord('gen-1', raw, null);
    expect(p.attempts.map((a) => a.provider)).toEqual(['Azure', 'OpenAI']);
    expect(p.attempts[0].error).toBe('upstream unavailable');
  });

  it('survives a record with fields missing', () => {
    const p = normalizeGenerationRecord('gen-2', { data: {} }, null);
    expect(p.generationId).toBe('gen-2');
    expect(p.provider).toBeNull();
    expect(p.totalCost).toBeNull();
    expect(p.attempts).toEqual([]);
    expect(p.honored).toBeNull();
  });
});

describe('attested attributes', () => {
  it('flattens the record into the keys that get hashed', () => {
    const p = normalizeGenerationRecord('gen-1', raw(), { only: ['anthropic'] });
    const attrs = provenanceAttributes(p);
    expect(attrs['gen_ai.generation.id']).toBe('gen-1');
    expect(attrs['gen_ai.upstream.provider']).toBe('OpenAI');
    expect(attrs['gen_ai.upstream.data_region']).toBe('global');
    expect(attrs['gen_ai.usage.total_cost']).toBeCloseTo(0.00003675);
    // The caller asked for anthropic and got OpenAI: the discrepancy itself is
    // part of the sealed record, which is the whole point.
    expect(attrs['openbox.routing.requested_only']).toEqual(['anthropic']);
    expect(attrs['openbox.routing.honored']).toBe(false);
    expect(attrs['gen_ai.routing.fallback_attempts']).toBe(2);
  });

  it('omits what OpenRouter did not tell us rather than asserting null', () => {
    const attrs = provenanceAttributes(normalizeGenerationRecord('gen-3', { data: {} }, null));
    expect(Object.keys(attrs)).toEqual(['gen_ai.generation.id']);
  });

  function raw() {
    return {
      data: {
        provider_name: 'OpenAI',
        data_region: 'global',
        total_cost: 0.00003675,
        provider_responses: [{ provider_name: 'Azure' }, { provider_name: 'OpenAI' }],
      },
    };
  }
});

// ── readRequestedRouting: the object-based path ──────────────────────────────
//
// Added because the body-based reader is only fed when
// `captureRequestObjectBody` is on, and it defaults to OFF (cloning a Request
// broke the OpenRouter client's retries). With it off, a constrained call was
// recorded as `unconstrained`: the constraint was sent and obeyed, and the
// evidence disagreed. Reading the caller's request object needs no capture.

describe('readRequestedRouting', () => {
  it('reads provider.only off the request object', () => {
    const routing = readRequestedRouting({
      model: 'openai/gpt-4o-mini',
      provider: { only: ['openai'], allow_fallbacks: false },
    });
    expect(routing).toEqual({ only: ['openai'], allowFallbacks: false });
  });

  it('reads order and models too', () => {
    const routing = readRequestedRouting({
      provider: { order: ['azure', 'openai'] },
      models: ['openai/gpt-4o-mini', 'anthropic/claude-3-haiku'],
    });
    expect(routing?.order).toEqual(['azure', 'openai']);
    expect(routing?.models).toHaveLength(2);
  });

  it('returns null when the request states no routing at all', () => {
    expect(readRequestedRouting({ model: 'openai/gpt-4o-mini' })).toBeNull();
  });

  it('tolerates junk without throwing', () => {
    expect(readRequestedRouting(null)).toBeNull();
    expect(readRequestedRouting('nope')).toBeNull();
    expect(readRequestedRouting({ provider: 'openai' })).toBeNull();
    expect(readRequestedRouting({ provider: { only: 'openai' } })).toBeNull();
  });

  it('agrees with the body reader on the same content', () => {
    const request = { provider: { only: ['openai'], allow_fallbacks: false } };
    expect(readRequestedRouting(request)).toEqual(
      extractRequestedRouting(JSON.stringify(request)),
    );
  });

  it('makes the honored check decidable without a captured body', () => {
    // The whole point: a constraint the body reader cannot see must still
    // produce a true/false verdict rather than null.
    const declared = readRequestedRouting({ provider: { only: ['openai'] } });
    expect(isRoutingHonored('OpenAI', declared)).toBe(true);
    expect(isRoutingHonored('Anthropic', declared)).toBe(false);
    // And with nothing captured and nothing declared it stays null — an
    // unconstrained call must never be reported as a pass.
    expect(isRoutingHonored('OpenAI', extractRequestedRouting(null))).toBeNull();
  });
});

// ── Model substitution: "did I get the model I paid for?" ────────────────────
//
// The response body carries the model as the provider ran it, but nobody
// compares it to the model the request asked for. Under a `models` fallback
// chain — or a provider quietly serving a different build — the two can differ
// while the call looks entirely successful.

describe('requested model', () => {
  it('reads the model off a body and off the request object alike', () => {
    const request = { model: 'openai/gpt-4o-mini', input: 'hi' };
    expect(extractRequestedModel(JSON.stringify(request))).toBe('openai/gpt-4o-mini');
    expect(readRequestedModel(request)).toBe('openai/gpt-4o-mini');
  });

  it('has nothing to say about a request that named no model', () => {
    expect(extractRequestedModel(JSON.stringify({ input: 'hi' }))).toBeNull();
    expect(extractRequestedModel('not json')).toBeNull();
    expect(extractRequestedModel(null)).toBeNull();
    expect(readRequestedModel({ model: 42 })).toBeNull();
    expect(readRequestedModel(null)).toBeNull();
  });
});

describe('isModelHonored', () => {
  it('passes when the model that ran is the model that was asked for', () => {
    expect(isModelHonored('openai/gpt-4o-mini', 'openai/gpt-4o-mini')).toBe(true);
    expect(isModelHonored('OpenAI/GPT-4o-Mini', 'openai/gpt-4o-mini')).toBe(true);
  });

  it('fails when a different model ran', () => {
    expect(isModelHonored('openai/gpt-4o', 'openai/gpt-4o-mini')).toBe(false);
  });

  it('treats a variant suffix as routing, not substitution', () => {
    // `:floor` selects how the model is routed; OpenRouter reports the base id
    // back, and the same model ran.
    expect(isModelHonored('openai/gpt-4o-mini', 'openai/gpt-4o-mini:floor')).toBe(true);
    expect(isModelHonored('openai/gpt-4o-mini:nitro', 'openai/gpt-4o-mini')).toBe(true);
  });

  it('accepts a model the caller listed as an acceptable fallback', () => {
    expect(
      isModelHonored('openai/gpt-4o-mini', 'anthropic/claude-sonnet-5', [
        'anthropic/claude-sonnet-5',
        'openai/gpt-4o-mini',
      ]),
    ).toBe(true);
    expect(
      isModelHonored('openai/gpt-4o', 'anthropic/claude-sonnet-5', ['openai/gpt-4o-mini']),
    ).toBe(false);
  });

  it('makes no claim when nothing was promised', () => {
    expect(isModelHonored('openai/gpt-4o-mini', null)).toBeNull();
    expect(isModelHonored('openai/gpt-4o-mini', '  ')).toBeNull();
    expect(isModelHonored(null, 'openai/gpt-4o-mini')).toBeNull();
    // Auto-routing delegates the choice: picking the model IS the promise.
    expect(isModelHonored('openai/gpt-4o-mini', 'openrouter/auto')).toBeNull();
  });
});

describe('model substitution in the sealed record', () => {
  const served = (model: string) => ({ data: { provider_name: 'OpenAI', model } });

  it('records the comparison both ways round', () => {
    const honored = normalizeGenerationRecord(
      'gen-m1',
      served('openai/gpt-4o-mini'),
      null,
      'openai/gpt-4o-mini',
    );
    expect(honored.requestedModel).toBe('openai/gpt-4o-mini');
    expect(honored.modelHonored).toBe(true);
    expect(provenanceAttributes(honored)['openbox.model.honored']).toBe(true);

    const substituted = normalizeGenerationRecord(
      'gen-m2',
      served('openai/gpt-4o'),
      null,
      'openai/gpt-4o-mini',
    );
    expect(substituted.modelHonored).toBe(false);
    const attrs = provenanceAttributes(substituted);
    expect(attrs['openbox.model.requested']).toBe('openai/gpt-4o-mini');
    expect(attrs['gen_ai.response.model']).toBe('openai/gpt-4o');
    expect(attrs['openbox.model.honored']).toBe(false);
  });

  it('honours the caller own fallback chain', () => {
    const record = normalizeGenerationRecord(
      'gen-m3',
      served('openai/gpt-4o-mini'),
      { models: ['anthropic/claude-sonnet-5', 'openai/gpt-4o-mini'] },
      'anthropic/claude-sonnet-5',
    );
    expect(record.modelHonored).toBe(true);
  });

  it('asserts nothing when the request named no model', () => {
    const record = normalizeGenerationRecord('gen-m4', served('openai/gpt-4o-mini'), null);
    expect(record.requestedModel).toBeNull();
    expect(record.modelHonored).toBeNull();
    expect(provenanceAttributes(record)['openbox.model.honored']).toBeUndefined();
  });
});

/**
 * The failover trail is the only evidence a provider let you down, and it was
 * being thrown away: the record was parsed, the per-attempt latency dropped,
 * and only the winning provider's timing survived. A provider that stalled for
 * eight seconds and then lost the call left no trace, so every surviving number
 * flattered the chain it belonged to.
 */
describe('the failover trail', () => {
  const failover = {
    data: {
      provider_name: 'OpenAI',
      model: 'openai/gpt-4o-mini',
      latency: 900,
      provider_responses: [
        { provider_name: 'Azure', status: 503, error: 'upstream unavailable', latency: 8100 },
        { provider_name: 'Together', status: 429, latency: 120 },
        { provider_name: 'OpenAI', status: 200, latency: 640 },
      ],
    },
  };

  it('keeps the latency of every attempt, losers included', () => {
    const p = normalizeGenerationRecord('gen-1', failover, null);

    expect(p.attempts.map((a) => a.latencyMs)).toEqual([8100, 120, 640]);
    // The slowest attempt is one that did NOT serve the call, which is exactly
    // the case the old shape could not represent.
    expect(Math.max(...p.attempts.map((a) => a.latencyMs ?? 0))).toBe(8100);
    expect(p.latencyMs).toBe(900);
  });

  it('seals the whole trail, one object per attempt, in order', () => {
    const attrs = provenanceAttributes(normalizeGenerationRecord('gen-1', failover, null));

    expect(attrs['gen_ai.routing.attempts']).toEqual([
      { provider: 'Azure', status: 503, latency_ms: 8100, error: 'upstream unavailable' },
      { provider: 'Together', status: 429, latency_ms: 120, error: null },
      { provider: 'OpenAI', status: 200, latency_ms: 640, error: null },
    ]);
  });

  it('counts attempts, not failures — the winner is in the array', () => {
    const attrs = provenanceAttributes(normalizeGenerationRecord('gen-1', failover, null));

    // Three attempts means two failures. Reading this as three outages is the
    // mistake the field name invites.
    expect(attrs['gen_ai.routing.fallback_attempts']).toBe(3);
    expect(attrs['gen_ai.routing.providers_tried']).toEqual(['Azure', 'Together', 'OpenAI']);
  });

  it('emits nothing when there was no trail at all', () => {
    const attrs = provenanceAttributes(
      normalizeGenerationRecord('gen-1', { data: { provider_name: 'OpenAI' } }, null),
    );

    expect(attrs['gen_ai.routing.attempts']).toBeUndefined();
    expect(attrs['gen_ai.routing.fallback_attempts']).toBeUndefined();
  });

  it('survives an attempt with no provider name, which providers_tried drops', () => {
    const p = normalizeGenerationRecord(
      'gen-1',
      { data: { provider_name: 'OpenAI', provider_responses: [{ status: 500 }, { provider_name: 'OpenAI', status: 200 }] } },
      null,
    );
    const attrs = provenanceAttributes(p);

    // providers_tried loses the nameless attempt, so it cannot be index-aligned
    // with anything — the reason the trail is a list of objects.
    expect(attrs['gen_ai.routing.providers_tried']).toEqual(['OpenAI']);
    expect((attrs['gen_ai.routing.attempts'] as unknown[]).length).toBe(2);
    expect((attrs['gen_ai.routing.attempts'] as { provider: unknown }[])[0].provider).toBeNull();
  });
});
