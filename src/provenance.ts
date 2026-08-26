/**
 * Routing provenance: which provider actually served each model call.
 *
 * OpenRouter's pitch to its users is two promises that pull against each
 * other. One is trust — "ensure prompts only go to the models and providers
 * you trust". The other is reliability — 80+ providers with automatic
 * fallback when one goes down. Together they mean the provider that serves a
 * given call is decided at request time, per call, and the caller cannot see
 * which one it was. A dashboard aggregate is not evidence, and "we routed it
 * correctly" is exactly the kind of claim a regulated buyer cannot accept on
 * faith.
 *
 * OpenRouter does publish the answer: `GET /api/v1/generation?id=<gen-id>`
 * returns the provider that served the request, the region it was processed
 * in, what it cost, whether a key of yours was used, and — when a provider
 * failed — the fallback attempts that preceded it. This module reads that
 * record for every governed model call so OpenBox can do three things with
 * it that OpenRouter alone cannot:
 *
 *   1. **Enforce** it. The record lands on a span, so a policy can refuse a
 *      call served outside an approved provider set or region.
 *   2. **Attest** it. The record travels in span attributes, which are what
 *      Core hashes into the session's Merkle tree — so it is sealed under the
 *      signed session root and cannot be edited after the fact.
 *   3. **Check the promise.** The routing the caller ASKED for travels with
 *      it, so "only anthropic" versus what actually served the call is a
 *      comparison anyone can make, not a claim they have to believe.
 *
 * Reading the record costs one HTTP call per model call, made after the model
 * call has already returned, so it is never on the critical path of the
 * answer. Without an OpenRouter key it is silently off.
 */

const GENERATION_PATH = '/api/v1/generation';

/** One fallback attempt, as OpenRouter reports it. */
export interface ProviderAttempt {
  provider?: string;
  status?: number | string;
  error?: string;
}

/** The normalized provenance of a single model call. */
export interface RoutingProvenance {
  /** OpenRouter's generation id — the receipt number for this call. */
  generationId: string;
  /** The provider that actually served it. */
  provider: string | null;
  /** The model as the provider ran it. */
  model: string | null;
  /** Where it was processed, when OpenRouter reports a region. */
  dataRegion: string | null;
  /** Total cost in credits, as OpenRouter accounts for it. */
  totalCost: number | null;
  upstreamCost: number | null;
  tokensPrompt: number | null;
  tokensCompletion: number | null;
  latencyMs: number | null;
  finishReason: string | null;
  /** True when the call ran against a key you supplied. */
  isByok: boolean | null;
  /** Providers tried before the one that succeeded — the failover trail. */
  attempts: ProviderAttempt[];
  /** Routing the caller asked for, if the request constrained it. */
  requested: RequestedRouting | null;
  /**
   * Whether the serving provider is inside what the caller asked for.
   * `null` when the request set no constraint — nothing was promised, so
   * nothing is honoured or broken.
   */
  honored: boolean | null;
}

/** The routing constraints carried on the request itself. */
export interface RequestedRouting {
  /** `provider.only` — the caller's allowlist. */
  only?: string[];
  /** `provider.order` — preference order. */
  order?: string[];
  /** `provider.allow_fallbacks` — false means "these providers or fail". */
  allowFallbacks?: boolean;
  /** Model-level fallback chain (`models`). */
  models?: string[];
}

/**
 * Read the routing constraints out of a request body.
 *
 * These are the caller's own words about where their prompt may go, which is
 * the half of the comparison OpenRouter's record cannot supply.
 */
export function extractRequestedRouting(requestBody: string | null): RequestedRouting | null {
  if (requestBody == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestBody);
  } catch {
    return null;
  }
  return readRequestedRouting(parsed);
}

/**
 * Read the routing constraints straight off the request OBJECT.
 *
 * The body-based reader above only sees a request whose body was captured, and
 * capture is opt-in for `Request` objects — cloning one destabilised the
 * OpenRouter client's retry path, so `captureRequestObjectBody` defaults to
 * false. That left the honored comparison silently inert for the very client
 * this SDK exists to govern: the constraint was sent and obeyed, and the
 * evidence recorded `unconstrained`.
 *
 * Reading the object the caller handed to `callModel` needs no clone and no
 * capture, so it works regardless of that setting.
 */
export function readRequestedRouting(request: unknown): RequestedRouting | null {
  if (request == null || typeof request !== 'object') return null;
  const body = request as Record<string, unknown>;

  const routing: RequestedRouting = {};
  const provider = body.provider;
  if (provider != null && typeof provider === 'object') {
    const p = provider as Record<string, unknown>;
    if (Array.isArray(p.only)) routing.only = p.only.map(String);
    if (Array.isArray(p.order)) routing.order = p.order.map(String);
    if (typeof p.allow_fallbacks === 'boolean') routing.allowFallbacks = p.allow_fallbacks;
  }
  if (Array.isArray(body.models)) routing.models = body.models.map(String);

  return Object.keys(routing).length > 0 ? routing : null;
}

/** Provider names are compared case-insensitively; OpenRouter mixes casing. */
function sameProvider(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Was the serving provider inside what the caller asked for?
 *
 * Only `only` is a hard constraint. `order` is a preference — being served by
 * something outside it is not a broken promise, so it does not fail the check.
 */
export function isRoutingHonored(
  provider: string | null,
  requested: RequestedRouting | null,
): boolean | null {
  if (requested?.only == null || requested.only.length === 0) return null;
  if (provider == null) return null;
  return requested.only.some((allowed) => sameProvider(allowed, provider));
}

function asNumber(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Normalize OpenRouter's generation record, tolerating fields it may omit. */
export function normalizeGenerationRecord(
  generationId: string,
  raw: unknown,
  requested: RequestedRouting | null,
): RoutingProvenance {
  const root = (raw != null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  // The endpoint wraps the record in `data`.
  const record = (root.data != null && typeof root.data === 'object'
    ? (root.data as Record<string, unknown>)
    : root);

  const attempts: ProviderAttempt[] = [];
  const responses = record.provider_responses;
  if (Array.isArray(responses)) {
    for (const entry of responses) {
      if (entry == null || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      attempts.push({
        provider: asString(e.provider_name) ?? asString(e.provider) ?? undefined,
        status: (asNumber(e.status) ?? asString(e.status)) ?? undefined,
        error: asString(e.error) ?? undefined,
      });
    }
  }

  const provider = asString(record.provider_name);
  return {
    generationId,
    provider,
    model: asString(record.model),
    dataRegion: asString(record.data_region),
    totalCost: asNumber(record.total_cost),
    upstreamCost: asNumber(record.upstream_inference_cost),
    tokensPrompt: asNumber(record.tokens_prompt),
    tokensCompletion: asNumber(record.tokens_completion),
    latencyMs: asNumber(record.latency),
    finishReason: asString(record.finish_reason),
    isByok: typeof record.is_byok === 'boolean' ? record.is_byok : null,
    attempts,
    requested,
    honored: isRoutingHonored(provider, requested),
  };
}

export interface FetchProvenanceOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Backoff schedule between lookups; the record is written asynchronously. */
  backoffMs?: number[];
  /** Marks our own request so the span processor does not trace it. */
  markInternal?: (init: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Fetch the generation record for one model call.
 *
 * Returns null rather than throwing: provenance is evidence, and failing to
 * collect it must never fail the run that produced it. The record can lag the
 * response by a moment, so a 404 is retried once.
 */
export async function fetchGenerationRecord(
  generationId: string,
  requested: RequestedRouting | null,
  opts: FetchProvenanceOptions,
): Promise<RoutingProvenance | null> {
  const base = (opts.baseUrl ?? 'https://openrouter.ai').replace(/\/$/, '');
  const url = `${base}${GENERATION_PATH}?id=${encodeURIComponent(generationId)}`;
  const timeoutMs = opts.timeoutMs ?? 4_000;

  // OpenRouter writes the generation record shortly after the response, not
  // with it: measured 404 at +0ms and at +400ms, present a moment later. Since
  // this runs in the background, it can afford to wait properly rather than
  // give up and lose the evidence.
  const backoffMs = opts.backoffMs ?? [300, 700, 1_500, 2_500, 4_000];

  for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
    if (attempt > 0) {
      // Deliberately NOT unref'd. These waits are what keeps the process alive
      // while evidence is still being collected — with them unref'd, Node
      // exited mid-collection and two of three model calls in a run lost their
      // provenance. The schedule is bounded, so this cannot hold a process
      // open indefinitely.
      await new Promise((resolve) => setTimeout(resolve, backoffMs[attempt - 1]));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    try {
      let init: Record<string, unknown> = {
        method: 'GET',
        headers: { authorization: `Bearer ${opts.apiKey}` },
        signal: controller.signal,
      };
      if (opts.markInternal) init = opts.markInternal(init);

      const response = await fetch(url, init as RequestInit);
      if (response.status === 404) continue; // not written yet — try once more
      if (!response.ok) return null;
      const body = (await response.json()) as unknown;
      return normalizeGenerationRecord(generationId, body, requested);
    } catch {
      continue; // transient — the loop's backoff is the retry
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * The attested form: flat, stable keys that go into span attributes.
 *
 * Attributes are what Core hashes into the session's Merkle tree, so every
 * key here ends up under the signed session root. Nulls are dropped rather
 * than sent — an absent field and a field asserted to be null are different
 * claims, and only one of them is honest when OpenRouter did not tell us.
 */
export function provenanceAttributes(p: RoutingProvenance): Record<string, unknown> {
  const attrs: Record<string, unknown> = {
    'gen_ai.generation.id': p.generationId,
  };
  const put = (key: string, value: unknown) => {
    if (value != null) attrs[key] = value;
  };
  put('gen_ai.upstream.provider', p.provider);
  put('gen_ai.response.model', p.model);
  put('gen_ai.upstream.data_region', p.dataRegion);
  put('gen_ai.usage.total_cost', p.totalCost);
  put('gen_ai.usage.upstream_cost', p.upstreamCost);
  put('gen_ai.usage.tokens_prompt', p.tokensPrompt);
  put('gen_ai.usage.tokens_completion', p.tokensCompletion);
  put('gen_ai.upstream.latency_ms', p.latencyMs);
  put('gen_ai.response.finish_reason', p.finishReason);
  put('gen_ai.upstream.is_byok', p.isByok);
  if (p.attempts.length > 0) {
    attrs['gen_ai.routing.fallback_attempts'] = p.attempts.length;
    attrs['gen_ai.routing.providers_tried'] = p.attempts
      .map((a) => a.provider)
      .filter((name): name is string => name != null);
  }
  if (p.requested?.only != null) attrs['openbox.routing.requested_only'] = p.requested.only;
  if (p.requested?.order != null) attrs['openbox.routing.requested_order'] = p.requested.order;
  if (p.requested?.allowFallbacks != null) {
    attrs['openbox.routing.allow_fallbacks'] = p.requested.allowFallbacks;
  }
  if (p.honored != null) attrs['openbox.routing.honored'] = p.honored;
  return attrs;
}
