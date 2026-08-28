/**
 * Data residency: where a prompt was processed, and whose key paid for it —
 * against the regions the operator approved.
 *
 * `provenance.ts` already reads two fields out of OpenRouter's generation
 * record that nothing compares against anything: `data_region`, the region the
 * serving provider processed the call in, and `is_byok`, whether it ran on a
 * key you supplied rather than on OpenRouter's own credit. Both are collected,
 * attested, and then left as trivia. "It ran in `us`" is not an answer to
 * "did any of our prompts leave the EU" — that question needs the other half
 * of the comparison, and the other half does not exist on the request.
 *
 * It cannot exist on the request. A provider allowlist is something the caller
 * can state, because OpenRouter accepts `provider.only` and honours it; there
 * is no `provider.region` to send. Region is decided upstream, reported after
 * the fact, and the only place an approved list can live is in the policy that
 * governs the agent. That is the whole shape of this module: the approved list
 * arrives from Core as a directive, is stamped onto the routing span before the
 * call so it is sealed under the signed session root, and is compared to the
 * record that lands after it.
 *
 * So the enforcement story here is deliberately weaker than the provider one,
 * and saying so is the point:
 *
 *   - **Provider** can be refused before the prompt is sent, because the SDK
 *     can narrow `provider.only` on the outgoing request (`narrowRouting`).
 *   - **Region** cannot. Nothing the SDK writes into the request influences
 *     where the call lands, so a residency directive is never applied to a
 *     request — applying one would be theatre. It is recorded as a claim, and
 *     the breach shows up on the provenance span as
 *     `openbox.residency.region_honored = false`, which a policy refuses the
 *     NEXT call on and halts the session. Same mechanism as a provider that
 *     served outside its allowlist, one call later.
 *
 * A checker that quietly reported "approved" for a call whose region OpenRouter
 * never told us about would be worse than no checker, so an unreported region
 * is `null` — unchecked — exactly as `openrouter/auto` is unchecked for the
 * model comparison. Coverage is a number the reader is shown, not one they are
 * spared.
 *
 * On the vocabulary, measured rather than assumed: `data_region` is a coarse
 * routing-zone label, not a country. A plain `openai/gpt-4o-mini` call comes
 * back as `"global"` — and, in the same record, `provider_name: "Azure"`. So
 * `global` means "no regional endpoint was used", which is precisely the answer
 * an operator who approved `["eu"]` needs to see as a FAILURE. It is treated as
 * an ordinary region name and compared literally: approving `["eu"]` and being
 * served `global` is not approved, and nothing here quietly widens `global`
 * into "wherever you allowed". Approving `["global"]` is the honest way to say
 * "any zone is fine".
 */

import type { GovernanceVerdictResponse } from './types';
import { patchFrom, verdictFromString } from './verdict';

/**
 * The residency constraint: the regions a prompt may be processed in, and
 * whether it must run on the operator's own provider key.
 *
 * Both are optional and independent. A policy that cares only about billing
 * (`requireOwnKey`) states no regions and every region check stays unchecked,
 * rather than an empty list being read as "nowhere is approved".
 */
export interface DataResidency {
  /** Regions the operator approved, as OpenRouter spells them (`us`, `eu`, …). */
  regions?: string[];
  /** True when the call must run against a key the operator supplied. */
  requireOwnKey?: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String) : undefined;
}

/** Regions are compared case-insensitively; OpenRouter mixes casing. */
function sameRegion(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Read a residency constraint out of one object, accepting the spellings a
 * policy author actually writes.
 *
 * Nested (`{"residency": {"regions": [...]}}`) and flat (`{"regions": [...]}`)
 * both work, and `approved_regions` is accepted alongside `regions` because
 * that is the name the attribute carries — a policy author who copies the key
 * they saw on the span should not have to discover it is spelled differently
 * on the way in.
 */
export function readResidency(source: unknown): DataResidency | null {
  if (!isObject(source)) return null;
  const nested = isObject(source.residency) ? source.residency : source;

  const residency: DataResidency = {};
  const regions =
    stringArray(nested.regions) ??
    stringArray(nested.approved_regions) ??
    stringArray(nested.approvedRegions) ??
    stringArray(nested.data_regions);
  if (regions != null) residency.regions = regions;

  const ownKey =
    nested.require_own_key ?? nested.requireOwnKey ?? nested.require_byok ?? nested.byok;
  if (typeof ownKey === 'boolean') residency.requireOwnKey = ownKey;

  return Object.keys(residency).length > 0 ? residency : null;
}

/**
 * Read a residency directive off a verdict, if it carries one.
 *
 * Same arms and same patch keys as `readRoutingDirective`, for the same
 * reasons: Core validates and forwards `patch.new_input` on a refusing arm and
 * strips a patch from `allow`, so that is where a directive can actually
 * arrive. A residency constraint is read out of the same directive a routing
 * one is — "openai only, in the EU" is one policy statement, not two.
 */
export function readResidencyDirective(
  response: GovernanceVerdictResponse | null | undefined,
): DataResidency | null {
  if (response == null) return null;
  const arm = verdictFromString(response.arm ?? response.verdict ?? response.action);
  if (arm !== 'constrain' && arm !== 'block') return null;
  const patch = patchFrom(response);
  if (patch == null) return null;

  for (const candidate of [patch.new_input, patch.residency, patch.routing, patch]) {
    const residency = readResidency(candidate);
    if (residency != null) return residency;
  }
  return null;
}

/**
 * Combine a residency constraint already in force with one a policy states.
 *
 * The rule is the one `narrowRouting` follows: a directive may only ever
 * REMOVE permission.
 *
 *   - `regions` intersects. Two policies that approve overlapping sets leave
 *     only what both approve, never a region only one of them named. When the
 *     intersection is empty there is no region left where this agent may be
 *     served, and `satisfiable` is false.
 *   - `requireOwnKey` is true if EITHER says true. Requiring your own key is a
 *     restriction, so it survives; a directive cannot switch it back off.
 *
 * Unlike routing, an unsatisfiable residency cannot be refused before the call
 * — there is no request field to check it against, and refusing every call an
 * agent makes because two policies disagree would be a governance layer taking
 * the agent down over its own bookkeeping. The caller decides what to do with
 * it; `resolveResidency` in the SDK records it and lets the post-hoc check
 * fail, which is the outcome that carries evidence.
 */
export function narrowResidency(
  declared: DataResidency | null,
  directive: DataResidency,
): { residency: DataResidency; changed: boolean; satisfiable: boolean } {
  const result: DataResidency = {};
  let satisfiable = true;

  if (directive.regions != null) {
    if (declared?.regions != null) {
      result.regions = declared.regions.filter((r) =>
        directive.regions!.some((allowed) => sameRegion(allowed, r)),
      );
      if (result.regions.length === 0) satisfiable = false;
    } else {
      result.regions = [...directive.regions];
    }
  } else if (declared?.regions != null) {
    result.regions = [...declared.regions];
  }

  const ownKey = [declared?.requireOwnKey, directive.requireOwnKey].filter(
    (v): v is boolean => typeof v === 'boolean',
  );
  if (ownKey.length > 0) result.requireOwnKey = ownKey.includes(true);

  const sameRegions =
    (result.regions == null && declared?.regions == null) ||
    (result.regions != null &&
      declared?.regions != null &&
      result.regions.length === declared.regions.length &&
      result.regions.every((r, i) => sameRegion(r, declared.regions![i])));
  const changed =
    !sameRegions || result.requireOwnKey !== (declared?.requireOwnKey ?? undefined);

  return { residency: result, changed, satisfiable };
}

/**
 * Was this call processed in a region the operator approved?
 *
 * `null` — unchecked — in the two cases where a boolean would be a lie: the
 * policy approved no particular regions, so nothing was promised; or OpenRouter
 * reported no region for the call, so nothing is known. Only a region that was
 * reported AND measured against a stated list yields true or false.
 */
export function isRegionApproved(
  dataRegion: string | null,
  residency: DataResidency | null,
): boolean | null {
  if (residency?.regions == null || residency.regions.length === 0) return null;
  if (dataRegion == null) return null;
  return residency.regions.some((approved) => sameRegion(approved, dataRegion));
}

/**
 * Did this call run on the operator's own key, when the policy required it?
 *
 * `null` when own-key usage was never required — a call billed to OpenRouter
 * credit is not a breach of a promise nobody made — and when OpenRouter did not
 * report `is_byok` at all.
 */
export function isOwnKeyHonored(
  isByok: boolean | null,
  residency: DataResidency | null,
): boolean | null {
  if (residency?.requireOwnKey !== true) return null;
  if (isByok == null) return null;
  return isByok;
}

/**
 * The residency constraint as span attributes.
 *
 * Stamped on the routing span before the call and on the provenance span after
 * it, so both halves of the comparison are hashed into the session's Merkle
 * tree. A policy reading `openbox.residency.approved_regions` gets the same
 * answer at either end, which is what lets one rule cover both.
 *
 * `declared` is sent even when false, for the reason `openbox.routing.declared`
 * is: "this agent has no approved region list" is a refusable fact, and an
 * absent attribute is not.
 */
export function residencyAttributes(
  residency: DataResidency | null,
): Record<string, unknown> {
  const attrs: Record<string, unknown> = {
    'openbox.residency.declared':
      residency?.regions != null && residency.regions.length > 0,
  };
  if (residency?.regions != null) attrs['openbox.residency.approved_regions'] = residency.regions;
  if (residency?.requireOwnKey != null) {
    attrs['openbox.residency.require_own_key'] = residency.requireOwnKey;
  }
  return attrs;
}

/** How a residency constraint reads in a log line and on the wire. */
export function describeResidency(residency: DataResidency | null): string {
  if (residency == null) return 'no approved region list';
  const parts: string[] = [];
  if (residency.regions != null) {
    parts.push(
      residency.regions.length > 0
        ? `regions=[${residency.regions.join(', ')}]`
        : 'regions=[] — no region is approved',
    );
  }
  if (residency.requireOwnKey != null) {
    parts.push(`require_own_key=${residency.requireOwnKey}`);
  }
  return parts.length > 0 ? parts.join(' ') : 'no approved region list';
}

/**
 * Where this call was processed, in words — the sentence the dashboard row and
 * the demo page both read.
 *
 * Deliberately says "unchecked" rather than staying silent when the region was
 * not reported: a residency claim with a silent hole in it is the failure mode
 * this whole module exists to avoid.
 */
export function describeResidencyOutcome(
  dataRegion: string | null,
  isByok: boolean | null,
  residency: DataResidency | null,
): string {
  const approved = isRegionApproved(dataRegion, residency);
  const where =
    dataRegion != null
      ? `processed in ${dataRegion}`
      : 'processed in a region OpenRouter did not report';
  const verdict =
    approved === true
      ? ` — approved (${(residency?.regions ?? []).join(', ')})`
      : approved === false
        ? ` — NOT approved; the policy allows ${(residency?.regions ?? []).join(', ')}`
        : residency?.regions == null || residency.regions.length === 0
          ? ' — no approved region list, so nothing was promised'
          : ' — unchecked, no region was reported';
  const key =
    isByok == null
      ? ''
      : isByok
        ? ', on your own provider key'
        : ", on OpenRouter's credit";
  const keyBreach =
    isOwnKeyHonored(isByok, residency) === false
      ? ' — the policy requires your own key'
      : '';
  return `${where}${verdict}${key}${keyBreach}`;
}

/**
 * A residency breach, as the sentence a refusal carries.
 *
 * Separate from the description above because a refusal has to name the call it
 * is about: by the time a policy acts on this, the offending prompt has already
 * been processed, and the honest message says so rather than implying it was
 * stopped.
 */
export function describeResidencyBreach(
  generationId: string,
  dataRegion: string | null,
  residency: DataResidency | null,
): string {
  return (
    `generation ${generationId} was processed in ${dataRegion ?? 'an unreported region'}, ` +
    `outside the approved ${describeResidency(residency)} — the prompt had already been sent, ` +
    `so this is evidence of a breach rather than prevention of one`
  );
}
