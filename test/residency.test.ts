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
