/**
 * Pre-flight routing enforcement: deciding where a prompt may go *before* it
 * goes there.
 *
 * `provenance.ts` collects the record of who actually served each call. That
 * record exists only after the call, which leaves one honest gap: a prompt
 * already sent cannot be unsent. A policy reading provenance can refuse the
 * NEXT call and halt the session — good, and often exactly right when a router
 * silently fails over — but it cannot stop the first prompt from reaching a
 * provider your contract excludes.
 *
 * This module closes that gap by governing the other half of the comparison:
 * the routing constraint the caller DECLARED, which exists before the request
 * is built. It is stated on the model call itself, as a span, in the same
 * attribute vocabulary the post-hoc record uses, so one policy shape covers
 * both ends:
 *
 *   openbox.routing.requested_only      what the caller will allow
 *   openbox.routing.declared            whether they constrained it at all
 *   gen_ai.upstream.provider            who served it, after the fact
 *
 * A policy can then do three things it could not before:
 *
 *   1. **Refuse an unconstrained prompt.** `declared: false` is a decidable
 *      fact — "no prompt leaves this agent without a provider allowlist" is a
 *      rule, not a code review note.
 *   2. **Narrow the allowlist.** A `constrain` verdict may carry
 *      `patch.routing`, and the SDK applies it to the outgoing request. Only
 *      ever narrower: see `narrowRouting`.
 *   3. **Fail closed on a contradiction.** When the policy's allowlist and the
 *      caller's are disjoint there is nowhere left to send the prompt, and the
 *      call is refused rather than resolved in either party's favour.
 *
 * On applying a directive at all: the SDK deliberately does NOT apply a
 * `patch.new_input` to a tool call (see `withPatchHint` — silently re-running a
 * money-moving tool with arguments the caller never wrote is not an
 * observability layer's decision). A routing directive is a different kind of
 * thing. It does not change what is asked, only where it may be answered, and
 * it can only ever remove destinations. Narrowing where a prompt may go is the
 * one rewrite that cannot make the request do something the caller did not ask
 * for.
 */

import type { RequestedRouting } from './provenance';
import { readRequestedRouting } from './provenance';
import type { DataResidency } from './residency';
import { residencyAttributes } from './residency';
import { stableSpanId, type GovernanceVerdictResponse } from './types';
import { patchFrom, verdictFromString } from './verdict';

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String) : undefined;
}

/**
 * Read a routing constraint written flat — `{only, order, allow_fallbacks,
 * models}` — which is the shape a policy author reaches for when the directive
 * is about routing and nothing else.
 */
function flatRouting(source: Record<string, unknown>): RequestedRouting | null {
  const routing: RequestedRouting = {};
  const only = stringArray(source.only);
  const order = stringArray(source.order);
  const models = stringArray(source.models);
  if (only != null) routing.only = only;
  if (order != null) routing.order = order;
  if (models != null) routing.models = models;
  const fallbacks = source.allow_fallbacks ?? source.allowFallbacks;
  if (typeof fallbacks === 'boolean') routing.allowFallbacks = fallbacks;
  return Object.keys(routing).length > 0 ? routing : null;
}

/**
 * Read a routing directive off a verdict, if it carries one.
 *
 * Only a refusing arm does. Core attaches a remediation directive to a
 * **block** — that is the arm its verdict contract carries `patch` on — so
 * "not to those providers, to these" arrives as a block plus a directive, and
 * the block is what makes it a directive rather than a suggestion. `constrain`
 * is accepted too, for a policy that spells it that way.
 *
 * `allow` deliberately is not. A directive on `allow` would mean a policy that
 * says yes and rewrites the request anyway — indistinguishable, from the
 * caller's side, from the SDK changing their request on its own initiative.
 *
 * The directive is looked for under `patch.new_input` first, because that is the
 * key Core validates and forwards — a patch of any other shape is dropped
 * before it reaches the SDK (measured against Core, not assumed). `new_input`
 * means "the input a policy suggests instead", and for a model call the request's
 * routing is part of its input, so this is the same mechanism a blocked tool's
 * suggested arguments use rather than a second one bolted alongside.
 * `patch.routing` and the patch itself are read too, for a Core that grows a
 * dedicated key.
 *
 * Both the nested (`{"provider": {"only": [...]}}`) and flat
 * (`{"only": [...]}`) spellings are accepted, because both are what a policy
 * author actually writes. A `new_input` that says nothing about routing — a
 * blocked tool's suggested arguments, say — matches neither and is ignored.
 */
export function readRoutingDirective(
  response: GovernanceVerdictResponse | null | undefined,
): RequestedRouting | null {
  if (response == null) return null;
  const arm = verdictFromString(response.arm ?? response.verdict ?? response.action);
  if (arm !== 'constrain' && arm !== 'block') return null;
  const patch = patchFrom(response);
  if (patch == null) return null;

  for (const candidate of [patch.new_input, patch.routing, patch]) {
    if (!isObject(candidate)) continue;
    const routing = readRequestedRouting(candidate) ?? flatRouting(candidate);
    if (routing != null) return routing;
  }
  return null;
}

/**
 * Has this request already been narrowed to what the directive asks for?
 *
 * A block carrying a routing directive means "not as it was, but as I say". Once
 * the request says exactly that, the block has nothing left to refuse — and
 * enforcing it anyway is self-defeating: a policy is stateless, so it fires
 * again on the very call it just redirected, and on the HTTP span inside that
 * call. Measured before this existed: the routed call was refused at the wire
 * and the run died with no answer and no error.
 *
 * Only the constraint being ALREADY satisfied justifies ignoring a block. A
 * directive that would still change the request is a real refusal.
 */
export function isDirectiveSatisfied(
  response: GovernanceVerdictResponse | null | undefined,
  declared: RequestedRouting | null,
): boolean {
  const directive = readRoutingDirective(response);
  if (directive == null) return false;
  const narrowed = narrowRouting(declared, directive);
  return narrowed.satisfiable && !narrowed.changed;
}

/**
 * Where this call is being routed, as a name: the provider the policy allows,
 * and the model it is serving.
 */
export function routingTarget(
  model: string | null,
  routing: RequestedRouting | null,
): string {
  const providers = routing?.only != null && routing.only.length > 0
    ? routing.only.join(', ')
    : 'any available provider';
  return model != null ? `routing to ${providers} (${model})` : `routing to ${providers}`;
}

/** Case-insensitive provider/model comparison — OpenRouter mixes casing. */
function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Entries of `declared` that also appear in `directive` — keeping the caller's
 * own spelling, which is the one already known to be accepted upstream.
 */
function intersect(declared: string[], directive: string[]): string[] {
  return declared.filter((entry) => directive.some((allowed) => same(entry, allowed)));
}

function sameList(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a == null || b == null) return a == null && b == null;
  return a.length === b.length && a.every((entry, i) => same(entry, b[i]));
}

export interface NarrowedRouting {
  /** The constraint to send, once the directive is applied. */
  routing: RequestedRouting;
  /** True when this differs from what the caller declared. */
  changed: boolean;
  /**
   * False when the policy's allowlist and the caller's have nothing in common.
   * There is no routing that satisfies both, so the call must be refused —
   * resolving it either way would mean overruling one of them silently.
   */
  satisfiable: boolean;
  /** Providers the caller asked for that the directive removed, for the record. */
  removed: string[];
}

/**
 * Apply a policy's routing directive to what the caller declared.
 *
 * The rule is one-directional: a directive may only ever REMOVE destinations.
 *
 *   - `only` intersects. A caller who allowed three providers and a policy that
 *     allows two ends up with what both accept — never a provider only one of
 *     them named.
 *   - `allow_fallbacks` is false if EITHER says false. "These providers or
 *     fail" is a restriction, so it survives; a directive cannot switch
 *     fallbacks back on for a caller who turned them off.
 *   - `models` intersects, on the same reasoning as `only`.
 *   - `order` is a preference, not a constraint, so the directive's order
 *     simply wins when it states one. It cannot widen anything.
 *
 * A directive is never widened into permission the caller did not grant, which
 * is what makes applying it automatically defensible at all.
 */
export function narrowRouting(
  declared: RequestedRouting | null,
  directive: RequestedRouting,
): NarrowedRouting {
  const result: RequestedRouting = {};
  let satisfiable = true;
  const removed: string[] = [];

  if (directive.only != null) {
    if (declared?.only != null) {
      result.only = intersect(declared.only, directive.only);
      removed.push(...declared.only.filter((p) => !result.only!.some((kept) => same(kept, p))));
      // Disjoint: the caller allowed only providers the policy forbids.
      if (result.only.length === 0) satisfiable = false;
    } else {
      result.only = [...directive.only];
    }
  } else if (declared?.only != null) {
    result.only = [...declared.only];
  }

  if (directive.models != null) {
    if (declared?.models != null) {
      result.models = intersect(declared.models, directive.models);
      if (result.models.length === 0) satisfiable = false;
    } else {
      result.models = [...directive.models];
    }
  } else if (declared?.models != null) {
    result.models = [...declared.models];
  }

  const fallbacks = [declared?.allowFallbacks, directive.allowFallbacks].filter(
    (v): v is boolean => typeof v === 'boolean',
  );
  if (fallbacks.length > 0) result.allowFallbacks = !fallbacks.includes(false);

  const order = directive.order ?? declared?.order;
  if (order != null) result.order = [...order];

  const changed =
    !sameList(result.only, declared?.only ?? undefined) ||
    !sameList(result.models, declared?.models ?? undefined) ||
    !sameList(result.order, declared?.order ?? undefined) ||
    result.allowFallbacks !== (declared?.allowFallbacks ?? undefined);

  return { routing: result, changed, satisfiable, removed };
}

/**
 * Write a routing constraint back into the request the caller passed.
 *
 * `callModel` spreads any field it does not consume itself straight into the
 * request body, so `provider` and `models` reach OpenRouter as written. The
 * caller's object is not mutated — a copy goes to the engine, the same way the
 * redacted input does.
 */
export function applyRoutingToRequest<T>(request: T, routing: RequestedRouting): T {
  const source = request as unknown as Record<string, unknown>;
  const existingProvider = isObject(source.provider) ? source.provider : {};

  const provider: Record<string, unknown> = { ...existingProvider };
  if (routing.only != null) provider.only = routing.only;
  if (routing.order != null) provider.order = routing.order;
  if (routing.allowFallbacks != null) provider.allow_fallbacks = routing.allowFallbacks;

  const next: Record<string, unknown> = { ...source };
  if (Object.keys(provider).length > 0) next.provider = provider;
  if (routing.models != null) next.models = routing.models;
  return next as unknown as T;
}

/**
 * The pre-flight claim, as span attributes.
 *
 * Deliberately the same vocabulary the post-hoc record uses, so a policy that
 * reads `openbox.routing.requested_only` works at both ends of the call, and so
 * both halves of the comparison are hashed into the session's Merkle tree —
 * what was promised as well as what happened.
 *
 * `openbox.routing.declared` is sent even when it is false. An absent attribute
 * and an attribute asserting "this caller constrained nothing" are different
 * claims, and only the second one is refusable.
 */
export function routingIntentAttributes(
  model: string | null,
  declared: RequestedRouting | null,
  residency: DataResidency | null = null,
): Record<string, unknown> {
  return {
    'openbox.routing.stage': 'preflight',
    'openbox.routing.declared': declared?.only != null,
    ...routingConstraintAttributes(model, declared, residency),
  };
}

/**
 * The constraint itself, without the pre-flight framing.
 *
 * Stamped onto every span under a governed model call, so a policy can tell a
 * call that is already routed from one that is not — using the SAME keys as the
 * pre-flight claim. That matters: a routing rule needs one guard expression
 * that holds at both decision points, because a policy is stateless and is
 * asked about the activity and about the HTTP request inside it. Without this,
 * the span evaluation had no routing facts at all and a rule that permitted the
 * corrected call could not be written.
 *
 * `stage` is deliberately not included — these spans are not the routing
 * decision, they are the work done under it.
 */
export function routingConstraintAttributes(
  model: string | null,
  declared: RequestedRouting | null,
  residency: DataResidency | null = null,
): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  // Where the prompt may be PROCESSED, alongside who may serve it. Stated here
  // even though nothing in the request can enforce it, because stating it
  // before the call is what makes the after-the-fact comparison evidence: the
  // approved list is sealed under the session root at a point where the answer
  // is not yet known, so it cannot have been chosen to fit the outcome.
  if (residency != null) Object.assign(attrs, residencyAttributes(residency));
  if (model != null) attrs['gen_ai.request.model'] = model;
  if (declared?.only != null) attrs['openbox.routing.requested_only'] = declared.only;
  if (declared?.order != null) attrs['openbox.routing.requested_order'] = declared.order;
  if (declared?.models != null) attrs['openbox.routing.requested_models'] = declared.models;
  if (declared?.allowFallbacks != null) {
    attrs['openbox.routing.allow_fallbacks'] = declared.allowFallbacks;
  }
  return attrs;
}

/**
 * The routing claim as a span — "routing to the model", and where it may go.
 *
 * A span, because that is the shape a policy already reads routing out of:
 * `input.spans[_].attributes["openbox.routing.requested_only"]` is the same
 * expression whether it is matching this claim or the provenance record that
 * lands after the call. One rule, both ends.
 *
 * Sent twice with the same `span_id`, as a started/completed pair, because
 * routing to the model is something that happens rather than a flag: it starts
 * before the request is built and finishes when the destination is settled.
 * Core creates the span row from the started half and fills its outcome from
 * the completed half, telling them apart by `stage`. `resolution` is what the
 * completed half says — where the prompt is actually going, and why, which is
 * where a policy's reason belongs.
 */
export function routingSpan(
  activityId: string,
  stage: 'started' | 'completed',
  model: string | null,
  routing: RequestedRouting | null,
  resolution?: string,
  /**
   * When the routing actually happened. The completed half is sent on the event
   * that closes the model call, which is long after the routing was settled, so
   * it carries its own times — otherwise it would sort after the HTTP spans of
   * the call it preceded.
   */
  times?: { startMs: number; endMs: number },
  /**
   * The regions this agent's policy approves, when it states any. Carried on
   * the routing span rather than on the request because there is no request
   * field for it — see `residency.ts`.
   */
  residency?: DataResidency | null,
): Record<string, unknown> {
  const startMs = times?.startMs ?? Date.now();
  const endMs = times?.endMs ?? startMs;
  const attributes = routingIntentAttributes(model, routing, residency ?? null);
  if (resolution != null) attributes['openbox.routing.resolution'] = resolution;
  return {
    span_id: stableSpanId(`${activityId}|routing`),
    trace_id:
      stableSpanId(`${activityId}|routing-trace|1`) +
      stableSpanId(`${activityId}|routing-trace|2`),
    parent_span_id: null,
    // Names the destination, not the act: "routing to the model" told a reader
    // nothing they did not already know from the row it sits under. Where the
    // policy is sending this prompt is the fact worth reading.
    name: routingTarget(model, routing),
    kind: 'CLIENT',
    stage,
    start_time: startMs * 1_000_000,
    end_time: (stage === 'completed' ? endMs : startMs) * 1_000_000,
    duration_ns: stage === 'completed' ? Math.max(0, endMs - startMs) * 1_000_000 : 0,
    attributes,
    status: {
      code: 'OK',
      description: stage === 'started' ? "it's being routed" : (resolution ?? 'routed'),
    },
    events: [],
    hook_type: 'llm_routing_request',
    semantic_type: 'llm_routing',
    gen_ai_system: 'openrouter',
    activity_id: activityId,
  };
}

/**
 * The routing step as it is *recorded* — the pair of rows that appear inside
 * the model call, between its start and its completion.
 *
 * Separate from the claim on the LLMStarted event, which is the question a
 * policy answers. Core binds an event's spans into policy input but only
 * persists spans sent through the hook path, so the question is asked one way
 * and the record is written the other. This is the record: what the call asked
 * for, where it was routed instead, and why.
 *
 * Both halves carry the routing that is now IN FORCE, not the one that was
 * refused — a record restating the refused routing would be re-judged by the
 * same rule that rejected it. What was asked for is kept as
 * `openbox.routing.redirected_from`, which is evidence rather than a claim
 * about where this call may go.
 */
export function routingRecordSpans(
  activityId: string,
  model: string | null,
  from: RequestedRouting | null,
  to: RequestedRouting,
  reason: string | null,
  times: { startMs: number; endMs: number },
  residency?: DataResidency | null,
): [Record<string, unknown>, Record<string, unknown>] {
  const resolution = describeResolution(to, reason, residency);
  const decorate = (span: Record<string, unknown>): Record<string, unknown> => {
    const attributes = span.attributes as Record<string, unknown>;
    attributes['openbox.routing.redirected_from'] =
      from?.only != null && from.only.length > 0 ? from.only : 'no provider allowlist';
    return span;
  };
  return [
    decorate(routingSpan(activityId, 'started', model, to, undefined, times, residency)),
    decorate(routingSpan(activityId, 'completed', model, to, resolution, times, residency)),
  ];
}

/**
 * Where this call ended up going, in words — the completed half's outcome, and
 * what the dashboard shows on the routing row.
 */
export function describeResolution(
  routing: RequestedRouting | null,
  narrowedBy: string | null,
  /**
   * The approved regions, when the policy states any. Appended rather than
   * folded in, because it is a claim of a different strength: the provider
   * clause says where the prompt WILL go, this one says only where it was
   * permitted to be processed — nothing on the request can hold it there.
   */
  residency?: DataResidency | null,
): string {
  const where =
    routing?.only != null && routing.only.length > 0
      ? `routed via ${routing.only.join(', ')}`
      : 'routed with no provider constraint — any provider OpenRouter picks may serve it';
  const region =
    residency?.regions != null && residency.regions.length > 0
      ? `, to be processed in ${residency.regions.join(', ')} (checked after the fact — no request field enforces it)`
      : '';
  return narrowedBy != null
    ? `${where}${region} — narrowed by policy: ${narrowedBy}`
    : `${where}${region}`;
}

/** How an applied directive is described on the wire and in a log line. */
export function describeRouting(routing: RequestedRouting): string {
  const parts: string[] = [];
  if (routing.only != null) parts.push(`provider.only=[${routing.only.join(', ')}]`);
  if (routing.models != null) parts.push(`models=[${routing.models.join(', ')}]`);
  if (routing.allowFallbacks != null) parts.push(`allow_fallbacks=${routing.allowFallbacks}`);
  if (routing.order != null) parts.push(`provider.order=[${routing.order.join(', ')}]`);
  return parts.length > 0 ? parts.join(' ') : 'unconstrained';
}
