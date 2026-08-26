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
  extractRequestedRouting,
  isRoutingHonored,
  normalizeGenerationRecord,
  provenanceAttributes,
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
