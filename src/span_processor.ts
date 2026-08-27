/**
 * HTTP span collector.
 *
 * In Node.js 18+, the OpenRouter SDK reaches the provider over the native fetch
 * API (undici), so the global fetch is patched — capturing request/response
 * bodies and posting ActivityStarted + hook_trigger + http_request spans to
 * Core. `node:http`/`node:https` are patched too, for clients that bypass fetch.
 *
 * Flow:
 *   1. wrapModelCall calls registerActivity(activityId, activityContext, ...)
 *      → mirrors span_processor.set_activity_context()
 *   2. Patched fetch fires on the actual LLM HTTP call
 *      → mirrors _httpx_request_hook / _patched_send
 *   3. ActivityStarted + http_request spans are POSTed to Core
 *      → mirrors hook_governance.evaluate_async()
 *   4. wrapModelCall calls unregisterActivity(activityId)
 *      → mirrors span_processor.clear_activity_context()
 */

import { AsyncLocalStorage } from 'async_hooks';
import { setTimeout as _st } from 'timers';
import {
  extractRequestedRouting,
  extractRequestedModel,
  provenanceAttributes,
  fetchGenerationRecord,
  type RequestedRouting,
  type RoutingProvenance,
} from './provenance';

import {
  GovernanceAuthError,
  OPENBOX_INTERNAL_REQUEST,
  SoftGovernanceError,
  type OpenBoxTransport,
} from './transport';
import { safeString } from './error-info';
import { GovernanceClient, OnApiError } from './client';
import type { HITLConfig, Logger } from './config';
import { rfc3339Now, stableSpanId, GovernanceVerdictResponse } from './types';
import { GovernanceBlockedError, GovernanceHaltError, formatActivityRejectedMessage, verdictFromString } from './verdict';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => _st(resolve, ms));
}

// ── Activity context registry (mirrors WorkflowSpanProcessor._activity_context) ──

interface ActivityContext {
  source: 'workflow-telemetry';
  workflow_id: string;
  run_id: string;
  workflow_type: string;
  task_queue: string | undefined;
  session_id: string | undefined;
  event_type: 'ActivityStarted';
  activity_id: string;
  activity_type: string;
}

export interface RegisterActivityOptions {
  hitl: HITLConfig;
  onApiError: OnApiError;
  logger: Logger;
  /** GovernanceConfig.governanceTimeout converted to ms. */
  requestTimeoutMs: number;
}

interface ActiveEntry {
  ctx: ActivityContext;
  transport: OpenBoxTransport;
  traceId: string;
  hitl: HITLConfig;
  onApiError: OnApiError;
  logger: Logger;
  requestTimeoutMs: number;
}

// Global registry keyed by activityId — only one entry active at a time per LLM call
const _activeActivities = new Map<string, ActiveEntry>();
const _activityAbort = new Map<string, string>();
// Activities approved at ToolStarted/LLMStarted level — hook-level require_approval
// verdicts are suppressed for these so one approval covers the full tool execution.
const _approvedActivities = new Set<string>();
/**
 * The activity an operation's HTTP/DB calls belong to.
 *
 * Stored as a resolver rather than a bare id so a scope can span an activity
 * that is REPLACED partway through. A single-turn host never needs this — one
 * `runWithActivity` call wraps one model call with one id. Driving an engine
 * that owns its own loop does: a single consumption of the result spans
 * several model turns, each with its own llm_call id, so the scope has to ask
 * "which activity is open right now?" at fetch time instead of capturing an id
 * that goes stale after the first turn.
 */
interface ActivityScope {
  get(): string | undefined;
}

const _activityScope = new AsyncLocalStorage<ActivityScope>();

function currentScopedActivityId(): string | undefined {
  return _activityScope.getStore()?.get();
}
const _recentSpans = new Map<string, number>();
// Fire-and-forget span sends still in flight, per activity. Completion spans
// are dispatched without being awaited (a verdict on a finished operation
// can't un-run it), so an activity that finishes first would delete its own
// registration and evaluateActivitySpan would then silently drop the pending
// completion — losing duration/error on most spans against a real Core, where
// each send takes ~1s. Tracked here so unregisterActivity can drain them.
const _inFlightSpans = new Map<string, Set<Promise<void>>>();

// Per-activity FIFO chain for span deliveries.
//
// Span sends are dispatched fire-and-forget, so without this they race and
// arrive at Core in whatever order the network settles: a completed span could
// overtake its own started span, and concurrent operations interleaved as
// started, started, completed, completed. Core builds the span row from the
// started hook and fills it from the completed one, so order matters. Chaining
// each activity's sends preserves the order they were created in, giving the
// trace a strict started → completed, started → completed sequence. Only the
// (already asynchronous) reporting path waits; the agent's own work never does.
const _sendChain = new Map<string, Promise<void>>();

/** Register a fire-and-forget span send so unregisterActivity can await it. */
export function trackSpanSend(activityId: string, p: Promise<void>): void {
  let set = _inFlightSpans.get(activityId);
  if (!set) { set = new Set(); _inFlightSpans.set(activityId, set); }
  const wrapped = p.catch(() => { /* already handled downstream */ }).finally(() => {
    set!.delete(wrapped);
    if (set!.size === 0) _inFlightSpans.delete(activityId);
  });
  set.add(wrapped);
}

/** Await any span sends still in flight for this activity. */
export async function drainSpanSends(activityId: string): Promise<void> {
  const set = _inFlightSpans.get(activityId);
  if (!set || set.size === 0) return;
  await Promise.all([...set]);
}
const _recentSpanTtlMs = 1000;

let _patched = false;
let _httpModulesPatched = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _originalFetch: ((...args: any[]) => Promise<any>) | null = null;

// ── Ignored URL prefixes (Core API itself, to avoid infinite loops) ────────────

const _ignoredPrefixes: string[] = [
  'https://core.openbox.ai',
  'http://core.openbox.ai',
];

/**
 * Register an extra URL prefix to ignore (e.g. a self-hosted OpenBox URL).
 * Called once at middleware construction time.
 */
export function addIgnoredPrefix(prefix: string): void {
  const normalised = prefix.replace(/\/+$/, '');
  if (!_ignoredPrefixes.includes(normalised)) {
    _ignoredPrefixes.push(normalised);
  }
}

export function shouldIgnore(url: string): boolean {
  return _ignoredPrefixes.some((p) => url.startsWith(p));
}

// ── LLM provider detection (gen_ai.system per OTel semantic conventions) ────

const LLM_PROVIDERS: Array<{ host: string; system: string }> = [
  { host: 'api.openai.com',                      system: 'openai' },
  { host: 'api.anthropic.com',                   system: 'anthropic' },
  { host: 'generativelanguage.googleapis.com',   system: 'google' },
  { host: 'openrouter.ai',                       system: 'openrouter' },
  { host: 'api.mistral.ai',                      system: 'mistral' },
  { host: 'api.groq.com',                        system: 'groq' },
  { host: 'api.together.xyz',                    system: 'together' },
  { host: 'api.together.ai',                     system: 'together' },
  { host: 'api.cohere.com',                      system: 'cohere' },
];

function detectGenAiSystem(url: string): string | null {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    // Azure OpenAI: <resource>.openai.azure.com
    if (hostname.endsWith('.openai.azure.com')) return 'azure_openai';
    // AWS Bedrock: bedrock-runtime.<region>.amazonaws.com
    if (hostname.includes('bedrock') && hostname.endsWith('.amazonaws.com')) return 'aws_bedrock';
    const match = LLM_PROVIDERS.find((p) => hostname === p.host || hostname.endsWith(`.${p.host}`));
    return match?.system ?? null;
  } catch {
    return null;
  }
}

// ── Span builder (mirrors _build_http_span_data in http_governance_hooks.py) ───

export function buildHttpSpanData(opts: {
  activityId: string;
  method: string;
  url: string;
  stage: 'started' | 'completed';
  requestBody: string | null;
  responseBody: string | null;
  statusCode: number | null;
  startMs: number;
  endMs?: number;
}): Record<string, unknown> {
  const startNs = opts.startMs * 1_000_000;
  const endNs = opts.endMs != null ? opts.endMs * 1_000_000 : null;
  const durationNs = endNs != null ? endNs - startNs : null;
  const error =
    opts.statusCode != null && opts.statusCode >= 400 ? `HTTP ${opts.statusCode}` : null;

  // Name: include status code on completed spans so the dashboard shows
  // e.g. "POST https://api.openai.com/v1/chat/completions 200"
  const name = opts.stage === 'completed' && opts.statusCode != null
    ? `${opts.method} ${opts.url} ${opts.statusCode}`
    : `${opts.method} ${opts.url}`;

  // start_time: for "completed" spans use end timestamp 
  const spanStartNs = opts.stage === 'completed' ? (endNs ?? startNs) : startNs;
  const genAiSystem = detectGenAiSystem(opts.url);

  const normalizedResponseBody = normalizeSseResponseBody(opts.responseBody);
  // The one choke point every HTTP span passes through, which is why the
  // completion text is picked off here rather than at each of the five
  // fetch/http/https call sites. Only for a model call (genAiSystem != null) —
  // an ordinary HTTP tool's response is not an assistant message.
  if (genAiSystem != null) {
    if (opts.stage === 'started') _llmSpanPending.add(opts.activityId);
    else {
      recordAssistantText(opts.activityId, normalizedResponseBody);
      // The generation id is the receipt number for this call, and the request
      // body carries what the caller asked of the router. Both are only
      // available here, together.
      recordRoutingCandidate(opts.activityId, normalizedResponseBody, opts.requestBody);
    }
  }

  return {
    // Same id for the started and completed halves of one HTTP call — Core
    // correlates them by span_id to fill in duration (see spanBase in
    // node_instrumentation.ts for the full rationale). Seeded on the request
    // identity plus startMs, which both stages share.
    span_id: stableSpanId(`${opts.activityId}|http|${opts.method}|${opts.url}|${opts.startMs}`),
    // Derived from the SAME seed as span_id, for the same reason: the started
    // and completed halves of one HTTP call must agree. This was `hexId(32)`
    // — a fresh random id per call — so every span's two halves carried
    // different trace_ids and could never be correlated by trace, even though
    // their span_ids matched. 32 hex chars to match W3C trace-id width, built
    // from two 16-char stable digests.
    trace_id:
      stableSpanId(`${opts.activityId}|trace|${opts.method}|${opts.url}|${opts.startMs}`) +
      stableSpanId(`${opts.activityId}|trace2|${opts.method}|${opts.url}|${opts.startMs}`),
    parent_span_id: null,
    name,
    kind: 'CLIENT',
    stage: opts.stage,
    start_time: spanStartNs,
    end_time: endNs,
    duration_ns: durationNs,
    attributes: {
      'http.method': opts.method,
      'http.url': opts.url,
      // Status must ride in `attributes`, not only as the root http_status_code
      // field: Core maps the root http_* fields to NO span column (they land in
      // the opaque `data` blob) while `attributes` is what it persists and the
      // dashboard renders. OTel's `http.status_code`, and only on the completed
      // stage, where a status first exists.
      ...(opts.statusCode != null ? { 'http.status_code': opts.statusCode } : {}),
      // Deliberately NOT 'gen_ai.system'. Core's classifyLLMGenAI
      // (content/session.go) returns semantic type 'llm_gen_ai' for ANY span
      // carrying that attribute, and it runs after URL-domain matching — so an
      // LLM host Core doesn't know (openrouter.ai is absent from its llmDomains
      // list) lands on 'llm_gen_ai'. The dashboard's llm_gen_ai branch hardcodes
      // statusCode: null, so the status pill silently vanished for model calls
      // while ordinary HTTP tools kept theirs. Only method/url/status travel in
      // attributes; the provider rides the root gen_ai_system field.
    },
    // UNSET while running; OK/ERROR once the call has actually finished.
    status: opts.stage === 'started'
      ? { code: 'UNSET', description: null }
      : { code: error ? 'ERROR' : 'OK', description: error },
    events: [],
    hook_type: 'http_request',
    // Advisory only — Core recomputes semantic_type for every span
    // (governance_workflow.go -> ComputeSemanticTypeFromSpan), so this does not
    // decide the label today. Sent anyway because it is Core's own vocabulary,
    // which makes the intent explicit and takes effect if Core ever honours the
    // declared value.
    ...(genAiSystem != null ? { semantic_type: 'llm_completion' } : {}),
    http_method: opts.method,
    http_url: opts.url,
    gen_ai_system: genAiSystem,
    request_body: opts.requestBody,
    request_headers: null,
    response_body: normalizedResponseBody,
    response_headers: null,
    http_status_code: opts.statusCode,
    error,
    // Carried on the span for server-side correlation
    activity_id: opts.activityId,
  };
}

// ── Evaluate helper (fire-and-forget — mirrors hook_governance.evaluate_async) ──

async function evaluateHookSpan(
  entry: ActiveEntry,
  spanData: Record<string, unknown>,
): Promise<void> {
  if (isDuplicateSpan(entry.ctx.activity_id, spanData)) return;
  // event_type stays 'ActivityStarted' for BOTH stages — deliberately. A hook
  // span is not an activity lifecycle event: Core creates the span row from the
  // started hook and fills its duration/end_time from the completed hook
  // (UpdateCompletion in openbox-core), telling them apart by the span's own
  // `stage` field. Relabelling the completed hook as 'ActivityCompleted' made
  // Core read it as a lifecycle completion instead, so durations were never
  // filled in and every span sat at "started" on the dashboard.
  const payload: Record<string, unknown> = {
    ...entry.ctx,
    timestamp: rfc3339Now(),
    spans: [spanData],
    span_count: 1,
    hook_trigger: true,
  };
  try {
    const response = await entry.transport.request<GovernanceVerdictResponse>({
      method: 'POST',
      path: '/api/v1/governance/evaluate',
      body: payload,
      traceId: entry.traceId,
      timeoutMs: entry.requestTimeoutMs,
    });
    // Span is always sent to Core so it shows on the dashboard.
    // For already-approved activities, skip verdict enforcement — enforcing would
    // create spurious approval rows. The ToolStarted approval covers the full call.
    if (!_approvedActivities.has(entry.ctx.activity_id)) {
      await enforceHookVerdict(entry, response, String(spanData.http_url ?? spanData.name ?? 'hook'));
    }
  } catch (err) {
    if (err instanceof GovernanceBlockedError || err instanceof GovernanceHaltError) throw err;
    // Auth/signing failures always hard-fail, regardless of onApiError.
    if (err instanceof GovernanceAuthError) throw err;
    // Other soft failures (network/API) respect the configured policy —
    // default fail_open so governance errors don't crash the model call.
    if (err instanceof SoftGovernanceError && entry.onApiError === 'fail_closed') throw err;
    if (!(err instanceof SoftGovernanceError)) {
      entry.logger.warn('span evaluate failed', err);
    }
  }
}

function isDuplicateSpan(activityId: string, spanData: Record<string, unknown>): boolean {
  const hookType = spanData.hook_type;
  if (typeof hookType !== 'string') return false;
  const now = Date.now();
  for (const [key, seenAt] of _recentSpans) {
    if (now - seenAt > _recentSpanTtlMs) {
      _recentSpans.delete(key);
    }
  }
  // Generalized across all hook types (http_request, db_query, file_operation) —
  // previously only http spans were deduplicated, so file/db spans had no
  // duplicate-suppression at all.
  const identity =
    hookType === 'http_request'
      ? [spanData.http_method, spanData.http_url, spanData.http_status_code ?? '']
      : hookType === 'db_query'
        ? [spanData.db_system, spanData.db_statement, spanData.rowcount ?? '']
        : hookType === 'llm_provenance'
          ? [(spanData.attributes as Record<string, unknown> | undefined)?.['gen_ai.generation.id']]
          : [spanData.file_path, spanData.file_operation];
  const key = [activityId, spanData.stage, hookType, ...identity].join('|');
  const seenAt = _recentSpans.get(key);
  if (seenAt != null && now - seenAt <= _recentSpanTtlMs) {
    return true;
  }
  _recentSpans.set(key, now);
  return false;
}

/**
 * How many span evaluations may be in flight at once for one activity.
 *
 * Each evaluation starts a Temporal workflow on Core and waits for it — about
 * a second, measured — so this is a real dial, not a micro-optimization. It is
 * bounded rather than unlimited because a chatty tool (twenty Redis commands)
 * would otherwise open twenty concurrent workflows and Core's per-call latency
 * degrades under exactly that load: with three tools evaluating at once, a
 * ~1.0s call measured ~2.0s.
 */
let _spanConcurrency = 4;

export function setSpanConcurrency(limit: number): void {
  _spanConcurrency = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
}

interface ActivityGate {
  active: number;
  waiting: Array<() => void>;
}

const _activityGates = new Map<string, ActivityGate>();

/** Run `fn` once this activity has a free slot. */
async function withActivitySlot<T>(activityId: string, fn: () => Promise<T>): Promise<T> {
  let gate = _activityGates.get(activityId);
  if (gate == null) {
    gate = { active: 0, waiting: [] };
    _activityGates.set(activityId, gate);
  }

  if (gate.active >= _spanConcurrency) {
    await new Promise<void>((resolve) => gate!.waiting.push(resolve));
  }
  gate.active++;
  try {
    return await fn();
  } finally {
    gate.active--;
    const next = gate.waiting.shift();
    if (next) next();
    else if (gate.active === 0 && gate.waiting.length === 0) _activityGates.delete(activityId);
  }
}

/**
 * Span pairs whose `started` half was sent as telemetry — nobody awaited it, so
 * its verdict gates nothing and the `completed` half has no reason to queue
 * behind it.
 */
const _ungatedSpans = new Set<string>();

export async function evaluateActivitySpan(
  activityId: string,
  spanData: Record<string, unknown>,
  opts: { gate?: boolean } = {},
): Promise<void> {
  // _activityAbort is only ever set for a terminal block/halt verdict now (see
  // enforceHookVerdict below) — require_approval is resolved by polling inline
  // before it ever reaches this map.
  const abortReason = _activityAbort.get(activityId);
  if (abortReason) {
    throw new GovernanceBlockedError('halt', abortReason);
  }
  const entry = _activeActivities.get(activityId);
  if (!entry) return;

  // Ordered per OPERATION, not per activity.
  //
  // Chaining every span of an activity behind the last one serialized work
  // that has no ordering requirement between operations: Core stores each
  // stage as its own row, uniquely keyed (session_id, span_id, stage), so two
  // different queries' spans are independent. The cost was severe, because
  // each send is a ~1s round-trip: four INDEPENDENT Postgres queries a tool
  // issued with Promise.all took 8.4s — exactly as long as running them one
  // after another, with the SDK undoing the concurrency the application asked
  // for. Ordering within one operation is still preserved (`started` before
  // `completed`), which is what the original chain was actually protecting.
  //
  // A failed send must not stall the ones behind it, hence the caught copy.
  const chainKey = `${activityId}|${String(spanData.span_id ?? spanData.stage ?? '')}`;

  // A `started` half the caller fired and walked away from (`void evaluateDb(…)`)
  // is telemetry: its verdict is never read, so it cannot gate anything. Making
  // the awaited `completed` half wait behind it doubled the cost of every such
  // operation — a Redis command paid ~1s for the send nobody was waiting on
  // before its own ~1s send could start. Core keys span rows by
  // (session_id, span_id, stage), so the two halves are independent there too.
  //
  // A gating `started` (the Postgres promise path awaits it, and a block stops
  // the query running) keeps the ordering: its approval, if any, must be
  // settled before the completion is evaluated, or a human could be asked twice.
  if (spanData.stage === 'started' && opts.gate === false) {
    _ungatedSpans.add(chainKey);
  }
  const ordered = !(spanData.stage === 'completed' && _ungatedSpans.has(chainKey));

  const previous = ordered ? _sendChain.get(chainKey) ?? Promise.resolve() : Promise.resolve();
  const pending = previous.then(() =>
    withActivitySlot(activityId, () => evaluateHookSpan(entry, spanData)),
  );
  _sendChain.set(chainKey, pending.catch(() => { /* chain must survive */ }));

  // Track before awaiting: callers that fire-and-forget (`void evaluateDb(...)`)
  // otherwise race their own activity's unregistration and lose the span.
  trackSpanSend(activityId, pending);
  await pending;
}

export function getCurrentActivityId(): string | undefined {
  return currentScopedActivityId();
}

/**
 * Poll Core for approval on a hook-level (span) verdict, blocking until
 * allowed/rejected/expired. Mirrors pollApprovalOrHalt() but operates on an
 * ActiveEntry (available inside the fetch/DB patch) instead of the full
 * OpenBoxOpenRouterMiddleware instance.
 *
 * Polling happens INLINE here — before evaluateHookSpan/enforceHookVerdict
 * ever throws — so require_approval never surfaces as an exception out of
 * the patched fetch/query call. This matters because that call runs inside
 * the LLM/DB client's own retry wrapper (e.g. a client's retry wrapper), which
 * has no notion of "this error means poll and retry" — it just sees an
 * unrecognized error and burns through its own retry budget with exponential
 * backoff, or gives up and surfaces a generic failure, before our HITL logic
 * ever got a chance to run.
 */
/**
 * Record the resolved reason in the abort side-channel BEFORE throwing, then
 * return the error to throw. This is the one source of truth for "why was
 * this activity aborted" that survives no matter how an external HTTP/LLM
 * client library mangles or replaces the thrown exception on its way out of
 * a patched fetch/http call — e.g. the OpenAI SDK wraps ANY error its fetch
 * implementation throws as a generic APIConnectionError with the fixed
 * message "Connection error.", discarding the real reason. Callers up the
 * stack should prefer getActivityAbortReason(activityId) over trying to
 * introspect the caught error itself.
 */
function abortAndThrow(activityId: string, message: string): GovernanceHaltError {
  _activityAbort.set(activityId, message);
  return new GovernanceHaltError(message);
}

async function pollHookApproval(
  entry: ActiveEntry,
  activityId: string,
  activityType: string,
  approvalId?: string,
): Promise<void> {
  const { hitl } = entry;
  if (!hitl.enabled) {
    throw abortAndThrow(activityId, `Approval required for activity ${activityType}`);
  }

  const client = new GovernanceClient(entry.transport, entry.traceId, entry.requestTimeoutMs);
  const startedAt = Date.now();
  while (hitl.timeoutMs == null || Date.now() - startedAt <= hitl.timeoutMs) {
    const response = await client.pollApproval(
      entry.ctx.workflow_id,
      entry.ctx.run_id,
      activityId,
      approvalId,
      entry.onApiError,
    );
    if (response == null) {
      await sleep(hitl.pollIntervalMs);
      continue;
    }

    if (response.expired) {
      throw abortAndThrow(
        activityId,
        `Approval expired for activity ${activityType} (workflow_id=${entry.ctx.workflow_id}, run_id=${entry.ctx.run_id}, activity_id=${activityId})`,
      );
    }

    // No arm/verdict/action field at all means still pending (no human
    // decision recorded yet) — not "allow". See hitl.ts's pollApprovalOrHalt
    // for the full explanation; this is the hook-level (fetch/db span) twin
    // of that same poll loop and had the identical bug.
    const rawVerdict = response.arm ?? response.verdict ?? response.action;
    if (typeof rawVerdict !== 'string' || rawVerdict.trim() === '') {
      await sleep(hitl.pollIntervalMs);
      continue;
    }

    const verdict = verdictFromString(rawVerdict);

    if (verdict === 'allow') return;
    if (verdict === 'block' || verdict === 'halt') {
      throw abortAndThrow(activityId, formatActivityRejectedMessage(response.reason));
    }

    await sleep(hitl.pollIntervalMs);
  }

  throw abortAndThrow(
    activityId,
    `Approval timed out for activity ${activityType} (workflow_id=${entry.ctx.workflow_id}, run_id=${entry.ctx.run_id}, activity_id=${activityId})`,
  );
}

async function enforceHookVerdict(
  entry: ActiveEntry,
  response: GovernanceVerdictResponse | null,
  identifier: string,
): Promise<void> {
  if (response == null) return;
  const activityId = entry.ctx.activity_id;
  const verdict = verdictFromString(response.verdict ?? response.arm ?? response.action);

  if (verdict === 'require_approval') {
    const approvalId = response.approval_id ?? response.approvalId ?? response.id;
    await pollHookApproval(entry, activityId, entry.ctx.activity_type, approvalId as string | undefined);
    // Approved — mark so a subsequent hook span or the ToolCompleted/LLMCompleted
    // event-level check doesn't ask Core for approval a second time.
    markActivityApproved(activityId);
    return;
  }

  if (verdict === 'block' || verdict === 'halt') {
    const reason = response.reason ?? 'Blocked by governance';
    _activityAbort.set(activityId, reason);
    throw new GovernanceBlockedError(verdict, `${reason} (${identifier})`);
  }
}

// ── Fetch patch (mirrors setup_httpx_body_capture in http_governance_hooks.py) ──
// Use `any` throughout — the dom lib is not in tsconfig.json lib, so fetch/Request/
// Response types are not available at compile time. We guard at runtime.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFetch = (...args: any[]) => Promise<any>;

function patchFetch(): void {
  if (_patched) return;
  if (typeof fetch !== 'function') return; // Node < 18: no native fetch
  _patched = true;
  _originalFetch = fetch as AnyFetch;
  const captured = _originalFetch!;

  // @ts-expect-error -- fetch is a writable global in Node.js 18+ (undici); TypeScript's
  // declaration via @types/node as a function type does not reflect its runtime writability.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fetch = async function patchedFetch(input: any, init?: any): Promise<any> {
    // Fast-path: no active governed activity — skip all instrumentation.
    if (_activeActivities.size === 0) {
      return captured(input, init);
    }
    // Resolve activityId from the async-local scope only. Previously this
    // fell back to "the first key in the global activity map" when the scope
    // was empty — under concurrent executions in the same process, that could
    // attribute one execution's HTTP span (and any governance verdict tied to
    // it) to a completely different execution's activity. Skipping
    // instrumentation when context is missing (like every other patch here
    // already does) is the safe behavior.
    const activityId = currentScopedActivityId();
    // An aborted activity is let through to the abort check below even when it
    // was never registered: after a halt the SDK deliberately does not open
    // (or register) another llm_call, and refusing the engine's next provider
    // request is the only thing that actually stops a run the engine has
    // decided to continue.
    if (!activityId || (!_activeActivities.has(activityId) && !_activityAbort.has(activityId))) {
      return captured(input, init);
    }

    const urlStr: string = (() => {
      try {
        if (typeof input === 'string') return input;
        if (input instanceof URL) return input.toString();
        return String(input?.url ?? '');
      } catch { return ''; }
    })();

    // Our own governance traffic must never be captured as a span: doing so
    // posts a second event to Core for the same activity and, under a
    // require_approval policy, creates a duplicate approval request. The URL
    // prefix check below covers it once the Core URL is known, but
    // FetchTransport also stamps every request it makes, which is exact
    // regardless of how the base URL was configured.
    const isInternal =
      init != null && (init as Record<string, unknown>)[OPENBOX_INTERNAL_REQUEST] === true;

    if (isInternal || !urlStr || shouldIgnore(urlStr)) {
      return captured(input, init);
    }

    // Only ever set for a terminal block/halt verdict now — require_approval is
    // resolved by polling inline inside evaluateHookSpan before it gets here.
    const abortReason = _activityAbort.get(activityId);
    if (abortReason) {
      throw new GovernanceBlockedError('halt', abortReason);
    }

    const entry = _activeActivities.get(activityId);
    if (!entry) return captured(input, init);

    const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
    const startMs = Date.now();

    // Capture request body (mirrors _capture_httpx_request_data)
    let requestBody: string | null = null;
    try {
      const bodyVal = init?.body;
      if (typeof bodyVal === 'string') {
        requestBody = bodyVal;
      } else if (bodyVal instanceof ArrayBuffer || ArrayBuffer.isView(bodyVal)) {
        requestBody = new TextDecoder().decode(bodyVal as ArrayBuffer);
      } else if (bodyVal == null && typeof input?.clone === 'function') {
        // Reading the body off a `Request` requires cloning it, and doing so
        // destabilizes the caller's object: measured 2/8 runs of the demo
        // agent failing with "Cannot construct a Request with a Request
        // object that has already been used" once the client retried, versus
        // 0/8 with this read skipped and 0/4 with no instrumentation at all.
        // Request-body capture is not worth a 25% crash rate, so it is opt-in.
        // `init.body` (the common case for clients that pass a plain URL) is
        // still captured above — no clone involved there, no risk.
        if (_captureRequestObjectBody) {
          requestBody = await input.clone().text().catch(() => null);
        }
      }
    } catch { /* best effort */ }

    // Evaluate "started" span (mirrors _httpx_async_request_hook)
    await evaluateHookSpan(
      entry,
      buildHttpSpanData({ activityId, method, url: urlStr, stage: 'started', requestBody, responseBody: null, statusCode: null, startMs }),
    );

    // Forward a CLONE, never the caller's own Request.
    //
    // `fetch(request)` constructs a new Request from it, which marks the
    // original's body disturbed. Clients that retry — the OpenRouter SDK's
    // retryBackoff among them — re-send the same Request object, and undici
    // then rejects it with "Cannot construct a Request with a Request object
    // that has already been used". Instrumentation must not change the state
    // of an object the caller still owns, so the original is left pristine
    // and a clone goes on the wire. Cloning is only valid while the body is
    // undisturbed, hence the bodyUsed guard.
    const forward =
      init == null && typeof input?.clone === 'function' && input?.bodyUsed === false
        ? input.clone()
        : input;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response: any = await captured(forward, init);
    const endMs = Date.now();

    const contentType = String(response?.headers?.get?.('content-type') ?? '');
    const isStream = contentType.includes('text/event-stream');

    // ── Streaming responses ────────────────────────────────────────────────
    // A streamed body must NOT be buffered before the caller gets the
    // response. Doing that (clone().text() with a 5s cap) meant a turn slower
    // than the cap left an abandoned tee branch and a stalled stream, the
    // caller's HTTP client timed out and retried, and its retry re-sent the
    // SAME Request object — which undici rejects with "Cannot construct a
    // Request with a Request object that has already been used", burying the
    // real cause. Instead the body is teed: one branch goes straight to the
    // caller untouched, the other is drained in the background and the
    // completed span is reported when it ends.
    if (isStream && response?.body != null && typeof response.body.tee === 'function') {
      const [forCaller, forCapture] = response.body.tee();

      const drain = (async () => {
        const chunks: string[] = [];
        try {
          const reader = forCapture.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) chunks.push(decoder.decode(value, { stream: true }));
          }
        } catch {
          // partial capture is still worth reporting
        }
        await evaluateHookSpan(
          entry,
          buildHttpSpanData({
            activityId, method, url: urlStr, stage: 'completed',
            requestBody, responseBody: chunks.join('') || null,
            statusCode: response?.status ?? null, startMs, endMs: Date.now(),
          }),
        ).catch(() => undefined);
      })();

      // Tracked so unregisterActivity waits for it — otherwise the activity
      // could be torn down before the stream finishes and the completed span
      // would be silently dropped.
      trackSpanSend(activityId, drain);

      return new Response(forCaller, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    // ── Non-streaming responses ────────────────────────────────────────────
    // Safe to buffer: the body is already complete. The timeout still guards
    // a connection that is held open without terminating.
    let responseBody: string | null = null;
    try {
      if (contentType.includes('application/json') || contentType.startsWith('text/')) {
        const bodyTimeout = new Promise<null>((resolve) => _st(() => resolve(null), 5_000));
        responseBody = await Promise.race([
          response.clone().text().catch((): null => null),
          bodyTimeout,
        ]);
      }
    } catch { /* best effort */ }

    // Evaluate "completed" span (mirrors _patched_async_send). require_approval
    // is resolved by polling inline inside evaluateHookSpan — it blocks here
    // until approved/rejected rather than throwing, so the response is only
    // ever returned once the verdict is settled. block/halt still throw and
    // discard this response immediately.
    await evaluateHookSpan(
      entry,
      buildHttpSpanData({ activityId, method, url: urlStr, stage: 'completed', requestBody, responseBody, statusCode: response?.status ?? null, startMs, endMs }),
    );

    return response;
  };
}

function patchHttpModules(): void {
  if (_httpModulesPatched) return;
  _httpModulesPatched = true;
  patchHttpModule('node:http');
  patchHttpModule('node:https');
}

function patchHttpModule(moduleName: 'node:http' | 'node:https'): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(moduleName) as Record<string, unknown>;
    if ((mod as { _openboxPatched?: boolean })._openboxPatched) return true;
    const originalRequest = mod.request;
    const originalGet = mod.get;
    if (typeof originalRequest !== 'function') return false;
    (mod as { _openboxPatched?: boolean })._openboxPatched = true;

    const requestWrapper = function patchedRequest(this: unknown, ...args: unknown[]) {
      const activityId = currentScopedActivityId();
      if (!activityId) return Reflect.apply(originalRequest, this, args);
      const entry = _activeActivities.get(activityId);
      const abortReason = _activityAbort.get(activityId);
      // Not `if (!entry) return` alone: an aborted activity must be refused
      // here as well as in the fetch patch, or a client that talks over
      // node:http (or captured `globalThis.fetch` before it was patched)
      // walks straight past a halt. The refusal is deferred until after the
      // ignored-URL check below so our own traffic to Core is never caught.
      if (!entry && !abortReason) return Reflect.apply(originalRequest, this, args);

      const startMs = Date.now();
      const reqBodyChunks: Buffer[] = [];
      const method = extractHttpMethod(args);
      const url = extractHttpUrl(moduleName, args);
      if (!url || shouldIgnore(url)) return Reflect.apply(originalRequest, this, args);

      if (abortReason) throw new GovernanceBlockedError('halt', abortReason);
      if (!entry) return Reflect.apply(originalRequest, this, args);

      const callbackIndex = args.findIndex((arg) => typeof arg === 'function');
      const originalCallback = callbackIndex >= 0 ? args[callbackIndex] as (...cbArgs: unknown[]) => void : null;

      if (originalCallback) {
        args[callbackIndex] = (response: {
          statusCode?: number;
          headers?: Record<string, unknown>;
          on?: (event: string, cb: (...cbArgs: unknown[]) => void) => unknown;
          once?: (event: string, cb: (...cbArgs: unknown[]) => void) => unknown;
          off?: (event: string, cb: (...cbArgs: unknown[]) => void) => unknown;
          emit?: (event: string, ...emitArgs: unknown[]) => unknown;
        }) => {
          const responseChunks: Buffer[] = [];
          // Kept separately from responseChunks (which is only ever read as
          // text for the span) so the bytes handed back to the real consumer
          // are exactly the ones that arrived, whatever their encoding.
          const replayChunks: unknown[] = [];

          const onData = (chunk: unknown) => {
            captureHttpBodyChunk(responseChunks, chunk);
            replayChunks.push(chunk);
          };

          // Attaching a 'data' listener puts the response into flowing mode,
          // so by the time the governance verdict settles below the stream is
          // already drained AND ended. Handing that exhausted object straight
          // to the caller means its own 'data'/'end' listeners — attached one
          // tick too late — never fire, and the request hangs until the
          // caller's timeout (axios-based clients fail in exactly this shape:
          // "Response body timed out ... without data"). So detach
          // our listener and replay the buffered body once the caller has had
          // a chance to subscribe. Object identity is preserved deliberately —
          // substituting a PassThrough would drop IncomingMessage fields that
          // consumers read off the response.
          const replayTo = (target: typeof response) => {
            target.off?.('data', onData);
            originalCallback(target);
            // setImmediate, not sync: the caller subscribes inside the
            // callback above, and must be listening before anything is emitted.
            setImmediate(() => {
              for (const chunk of replayChunks) target.emit?.('data', chunk);
              target.emit?.('end');
            });
          };

          response.on?.('data', onData);
          // `once` — the replayed 'end' below must not re-enter this handler.
          response.once?.('end', () => {
            const endMs = Date.now();
            const requestBody = chunksToText(reqBodyChunks);
            const responseBody = chunksToText(responseChunks);
            // Governance is the gate for handing the response to the caller — mirrors
            // patchFetch's "completed" check, where the response is only ever returned
            // once the verdict is settled. This used to be `void evaluateHookSpan(...)`
            // while `originalCallback(response)` ran unconditionally right after, so a
            // require_approval verdict resolved against a response the caller had
            // already consumed — a human decision made later had nothing left to affect.
            evaluateHookSpan(
              entry,
              buildHttpSpanData({
                activityId,
                method,
                url,
                stage: 'completed',
                requestBody,
                responseBody,
                statusCode: response.statusCode ?? null,
                startMs,
                endMs,
              }),
            ).then(
              () => replayTo(response),
              (err) => {
                req.destroy?.(err instanceof Error ? err : new Error(safeString(err)));
              },
            );
          });
        };
      }

      const req = Reflect.apply(originalRequest, this, args) as {
        write?: (...writeArgs: unknown[]) => unknown;
        end?: (...endArgs: unknown[]) => unknown;
        destroy?: (err?: Error) => unknown;
        on?: (event: string, cb: (...cbArgs: unknown[]) => void) => unknown;
      };

      // "started" gate — delays flushing the request body until the pre-flight
      // governance check resolves, mirroring patchFetch's `await evaluateHookSpan(...)`
      // before `await captured(...)`. write()/end() are synchronous APIs on
      // http.ClientRequest, so instead of blocking them directly we buffer whatever
      // the caller writes and replay it once the gate clears — a block/halt verdict
      // drops the buffered body and destroys the request instead of ever putting it
      // on the wire.
      let gateSettled = false;
      let gateError: Error | null = null;
      const pendingWrites: Array<{ end: boolean; writeArgs: unknown[] }> = [];

      const originalWrite = req.write;
      const originalEnd = req.end;

      const flushPendingWrites = () => {
        for (const pending of pendingWrites) {
          if (pending.end) {
            if (typeof originalEnd === 'function') Reflect.apply(originalEnd, req, pending.writeArgs);
          } else if (typeof originalWrite === 'function') {
            Reflect.apply(originalWrite, req, pending.writeArgs);
          }
        }
        pendingWrites.length = 0;
      };

      void evaluateHookSpan(
        entry,
        buildHttpSpanData({
          activityId,
          method,
          url,
          stage: 'started',
          requestBody: null,
          responseBody: null,
          statusCode: null,
          startMs,
        }),
      ).then(
        () => {
          gateSettled = true;
          flushPendingWrites();
        },
        (err) => {
          gateSettled = true;
          gateError = err instanceof Error ? err : new Error(safeString(err));
          pendingWrites.length = 0;
          req.destroy?.(gateError);
        },
      );

      if (typeof originalWrite === 'function') {
        req.write = function patchedWrite(...writeArgs: unknown[]) {
          captureHttpBodyChunk(reqBodyChunks, writeArgs[0]);
          if (!gateSettled) {
            pendingWrites.push({ end: false, writeArgs });
            return true;
          }
          if (gateError) return false;
          return Reflect.apply(originalWrite, this, writeArgs);
        };
      }
      if (typeof originalEnd === 'function') {
        req.end = function patchedEnd(...endArgs: unknown[]) {
          captureHttpBodyChunk(reqBodyChunks, endArgs[0]);
          if (!gateSettled) {
            pendingWrites.push({ end: true, writeArgs: endArgs });
            return req;
          }
          if (gateError) return req;
          return Reflect.apply(originalEnd, this, endArgs);
        };
      }
      req.on?.('error', (err: unknown) => {
        const endMs = Date.now();
        void evaluateHookSpan(
          entry,
          {
            ...buildHttpSpanData({
              activityId,
              method,
              url,
              stage: 'completed',
              requestBody: chunksToText(reqBodyChunks),
              responseBody: null,
              statusCode: null,
              startMs,
              endMs,
            }),
            error: safeString(err),
            status: { code: 'ERROR', description: safeString(err) },
          },
        );
      });
      return req;
    };

    mod.request = requestWrapper;
    if (typeof originalGet === 'function') {
      mod.get = function patchedGet(this: unknown, ...args: unknown[]) {
        const req = Reflect.apply(requestWrapper, this, args) as { end?: () => unknown };
        req.end?.();
        return req;
      };
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Collapse a Server-Sent Events response into the single JSON object Core
 * expects.
 *
 * The OpenRouter Agent SDK talks to the streaming Responses API, so the
 * captured body is an SSE transcript (`data: {...}` per line), not JSON. Core
 * reads token usage and the model id by `json.Unmarshal`-ing the whole
 * response body (observability/model.go -> extractTokenUsage), which fails
 * outright on that framing — so every OpenRouter run reported zero tokens and
 * no model, even though the numbers were sitting in the stream's terminal
 * `response.completed` event. A client using the non-streaming
 * chat-completions endpoint never hits this — that body already is JSON.
 *
 * The terminal event's `response` object carries `model` and `usage` in
 * exactly the shape Core parses, so that is what gets stored. Anything that is
 * not SSE, or an SSE stream with no terminal event, is passed through
 * untouched rather than dropped — a body Core cannot read still beats no body.
 */
export function normalizeSseResponseBody(body: string | null): string | null {
  if (body == null) return body;
  // Cheap guard: real JSON bodies never start with the SSE field prefix.
  if (!body.startsWith('data:') && !body.includes('\ndata:')) return body;

  let best: string | null = null;
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue; // a partial frame; the terminal event is what matters
    }
    if (parsed == null || typeof parsed !== 'object') continue;

    // Responses API: {type: 'response.completed', response: {...}}
    const inner = (parsed as Record<string, unknown>).response;
    const candidate =
      inner != null && typeof inner === 'object' ? (inner as Record<string, unknown>) : (parsed as Record<string, unknown>);

    // Keep the LAST frame that actually carries usage — earlier frames
    // (response.created / in_progress) have the envelope but no totals.
    if (candidate.usage != null) {
      try {
        best = JSON.stringify(candidate);
      } catch {
        // unserializable frame; keep whatever we already had
      }
    }
  }

  return best ?? body;
}

/**
 * Assistant text captured from an LLM response body, keyed by activity id.
 *
 * `PostModelCall` carries no response text (its schema is sessionId /
 * responseId / model / durationMs / turnType / turnNumber / usage), so
 * `LLMCompleted.completion` was honestly `null` on every turn. The text is
 * already in hand one layer down — the span processor buffers the model
 * call's response body and normalizes it — so it is picked off there rather
 * than fetched again. Read-once: the consumer takes it, and whatever is left
 * behind (a call that never reached LLMCompleted) is dropped by
 * `unregisterActivity`, so this cannot grow across a long-lived process.
 */
const _assistantText = new Map<string, string>();

/**
 * Activities with an LLM span in flight, and whoever is waiting for its text.
 *
 * The response body is teed rather than buffered, so the completed
 * span — and with it the text — is only built once the engine has finished
 * reading the stream. Measured: that lands about a millisecond AFTER
 * `PostModelCall` fires, i.e. after the SDK has already closed the activity.
 * Taking the text at close time therefore always got null. The close waits for
 * the span instead of racing it, and waits only when a span is actually
 * coming: with HTTP instrumentation off there is nothing to wait for.
 */
const _llmSpanPending = new Set<string>();

/**
 * Routing provenance awaiting collection, keyed by activity.
 *
 * Set when a model call's completed span is built (that is where the
 * generation id and the request's own routing constraints are both in hand),
 * and drained by `attestRouting()` before the activity closes.
 */
const _pendingRouting = new Map<
  string,
  {
    generationId: string;
    requested: RequestedRouting | null;
    requestedModel: string | null;
    entry: ActiveEntry;
  }
>();

/**
 * Provenance collection still in flight.
 *
 * OpenRouter writes the generation record a moment after the response — a
 * lookup at turn close returns 404 (measured: still 404 at +400ms). Waiting
 * for it inline would tax every turn with a retry loop for evidence nobody is
 * blocked on, so collection runs in the background with backoff and the run
 * drains it before closing. That keeps the record inside the session — and so
 * inside the session's Merkle tree — without putting it on the turn's path.
 */
const _routingJobs = new Set<Promise<RoutingProvenance | null>>();

let _routingAttestation: { enabled: boolean; apiKey: string | null; baseUrl?: string } = {
  enabled: true,
  apiKey: null,
};

/**
 * Configure routing attestation. Silently inert without an OpenRouter key —
 * the generation record is OpenRouter's to hand over, and reading it needs
 * the caller's own credential.
 */
export function setRoutingAttestation(opts: {
  enabled?: boolean;
  apiKey?: string | null;
  baseUrl?: string;
}): void {
  _routingAttestation = {
    enabled: opts.enabled ?? _routingAttestation.enabled,
    apiKey: opts.apiKey ?? _routingAttestation.apiKey,
    baseUrl: opts.baseUrl ?? _routingAttestation.baseUrl,
  };
}

export function routingAttestationEnabled(): boolean {
  return _routingAttestation.enabled && _routingAttestation.apiKey != null;
}
const _assistantWaiters = new Map<string, Array<(text: string | null) => void>>();

function settleAssistantWaiters(activityId: string, text: string | null): void {
  const waiters = _assistantWaiters.get(activityId);
  if (waiters == null) return;
  _assistantWaiters.delete(activityId);
  for (const resolve of waiters) resolve(text);
}

/**
 * Pull the assistant's text out of a model response body.
 *
 * Handles both shapes the OpenRouter SDK can produce: the Responses API
 * (`output[].content[].text`, which is what the Agent SDK streams) and
 * chat-completions (`choices[].message.content`). Returns null for anything
 * else — a body we cannot read is reported as no completion, never as a
 * guess.
 */
export function extractAssistantText(body: string | null): string | null {
  if (body == null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed == null || typeof parsed !== 'object') return null;
  const root = parsed as Record<string, unknown>;

  const parts: string[] = [];

  // Responses API — the shape normalizeSseResponseBody() collapses to.
  const output = root.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (item == null || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      // Only assistant messages: reasoning and function_call items are not
      // the answer, and rolling them in would misreport tool arguments as
      // completion text.
      if (rec.type != null && rec.type !== 'message') continue;
      const content = rec.content;
      if (typeof content === 'string') {
        parts.push(content);
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const chunk of content) {
        if (chunk == null || typeof chunk !== 'object') continue;
        const text = (chunk as Record<string, unknown>).text;
        if (typeof text === 'string' && text !== '') parts.push(text);
      }
    }
  }

  // Chat-completions — the non-streaming providers' shape.
  if (parts.length === 0 && Array.isArray(root.choices)) {
    for (const choice of root.choices) {
      if (choice == null || typeof choice !== 'object') continue;
      const message = (choice as Record<string, unknown>).message;
      if (message == null || typeof message !== 'object') continue;
      const content = (message as Record<string, unknown>).content;
      if (typeof content === 'string' && content !== '') parts.push(content);
    }
  }

  const text = parts.join('').trim();
  return text === '' ? null : text;
}

/**
 * Record the assistant text of a completed LLM span. Called even when the
 * body carries no text — a turn that only called tools has none, and the
 * waiter must be released then too, immediately, rather than sitting out its
 * cap on every tool round.
 */
function recordAssistantText(activityId: string, body: string | null): void {
  const text = extractAssistantText(body);
  if (text != null) _assistantText.set(activityId, text);
  _llmSpanPending.delete(activityId);
  settleAssistantWaiters(activityId, text);
}

/**
 * Wait (briefly, and only when an LLM span is actually in flight) for the
 * assistant text of an activity, then take it.
 *
 * `capMs` is a backstop for a span that never completes — a request that
 * errors out mid-stream — not the expected path: the normal wait is under a
 * millisecond.
 */
export function awaitAssistantText(activityId: string, capMs = 2_000): Promise<string | null> {
  const already = takeAssistantText(activityId);
  if (already != null) return Promise.resolve(already);
  if (!_llmSpanPending.has(activityId)) return Promise.resolve(null);

  return new Promise<string | null>((resolve) => {
    let done = false;
    const finish = (text: string | null) => {
      if (done) return;
      done = true;
      _assistantText.delete(activityId);
      resolve(text);
    };
    const waiters = _assistantWaiters.get(activityId);
    if (waiters) waiters.push(finish);
    else _assistantWaiters.set(activityId, [finish]);
    const timer = setTimeout(() => finish(null), capMs);
    // Never hold the process open for telemetry.
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}

/**
 * Take (and forget) the assistant text captured for an activity. Returns null
 * when the response body was never captured — instrumentation off, a
 * non-LLM activity, or a body we could not read.
 */
/** Stash the generation id and requested routing for later collection. */
function recordRoutingCandidate(
  activityId: string,
  responseBody: string | null,
  requestBody: string | null,
): void {
  if (!routingAttestationEnabled() || responseBody == null) return;
  let generationId: string | null = null;
  try {
    const parsed = JSON.parse(responseBody) as Record<string, unknown>;
    const id = parsed.id;
    // OpenRouter's generation ids are `gen-…`; anything else is a provider id
    // we cannot look up.
    if (typeof id === 'string' && id.startsWith('gen-')) generationId = id;
  } catch {
    return;
  }
  if (generationId == null) return;
  const entry = _activeActivities.get(activityId);
  if (entry == null) return;
  _pendingRouting.set(activityId, {
    generationId,
    requested: extractRequestedRouting(requestBody),
    requestedModel: extractRequestedModel(requestBody),
    entry,
  });
}

/**
 * Start collecting the routing provenance for an activity, in the background.
 *
 * Returns immediately. The span it eventually sends goes through the normal
 * path, which means a policy evaluates it — so a call served outside an
 * approved provider set or region can be refused — and its attributes are
 * hashed into the session's Merkle tree, so the provenance is sealed under the
 * signed session root rather than being a log line someone could edit.
 */
export function beginRoutingAttestation(
  activityId: string,
  /**
   * Routing read off the caller's request OBJECT, used when the wire body was
   * not captured. `captureRequestObjectBody` is off by default (cloning a
   * `Request` broke the OpenRouter client's retries), so without this the
   * honored comparison is inert for exactly the client this SDK governs.
   */
  declaredRouting?: RequestedRouting | null,
  /** The model named on the caller's request object, same fallback reasoning. */
  declaredModel?: string | null,
): void {
  const pending = _pendingRouting.get(activityId);
  if (pending == null) return;
  _pendingRouting.delete(activityId);
  if (!routingAttestationEnabled()) return;

  const job = (async (): Promise<RoutingProvenance | null> => {
    // Body-derived wins when present — it is what actually went over the wire.
    // The declared constraint is the fallback, not an override.
    const requested = pending.requested ?? declaredRouting ?? null;
    const requestedModel = pending.requestedModel ?? declaredModel ?? null;
    const record = await fetchGenerationRecord(
      pending.generationId,
      requested,
      {
        apiKey: _routingAttestation.apiKey!,
        baseUrl: _routingAttestation.baseUrl,
        // Our own lookup must never be captured as one of the agent's spans.
        markInternal: (init) => ({ ...init, [OPENBOX_INTERNAL_REQUEST]: true }),
      },
      requestedModel,
    );
    if (record == null) {
      // Evidence that could not be collected is worth surfacing: the run is
      // fine, but its provenance has a hole in it.
      pending.entry.logger?.warn?.(
        `routing provenance unavailable for ${pending.generationId} — the generation record did not appear in time`,
      );
      return null;
    }

    // Emitted as a span, because that is the only channel that reaches Core.
    //
    // This was briefly removed on the grounds that a span should stand for
    // something the run DID, and this record is an announcement about something
    // that already happened. True as far as it goes — and it took routing
    // provenance off the dashboard entirely. The summary that rides on
    // `WorkflowCompleted.extra` never lands: Core's payload struct has no such
    // field and drops it at unmarshal, exactly as it does `workflow_output`.
    // Span attributes are also what Core hashes into the session's Merkle tree,
    // so this is the only form in which the record is attested at all.
    //
    // If it should not appear as a row in the execution tree, that is a display
    // decision for the dashboard: the data has to exist either way, and the
    // routing-integrity panel reads it from here.
    const nowNs = Date.now() * 1_000_000;
    const spanData: Record<string, unknown> = {
      span_id: stableSpanId(`${activityId}|routing|${record.generationId}`),
      trace_id:
        stableSpanId(`${activityId}|routing-trace|${record.generationId}`) +
        stableSpanId(`${activityId}|routing-trace2|${record.generationId}`),
      parent_span_id: null,
      // Says what it is: OpenRouter's record of who actually served the call.
      // "routing …" read as though it were the routing decision, which happens
      // before the call and is a different row.
      name: `served by ${record.provider ?? 'an unreported provider'}${
        record.model != null ? ` (${record.model})` : ''
      }`,
      kind: 'CLIENT',
      stage: 'completed',
      start_time: nowNs,
      end_time: nowNs,
      duration_ns: record.latencyMs != null ? record.latencyMs * 1_000_000 : null,
      attributes: provenanceAttributes(record),
      status: { code: 'OK', description: null },
      events: [],
      hook_type: 'llm_provenance',
      // Not a completion, and not the routing decision either: this is the
      // gateway's record OF a completion, read back after the fact. Core
      // recomputes semantic types on ingest and classifies it the same way
      // from `gen_ai.generation.id`, so this is the honest label rather than
      // the operative one.
      //
      // `llm_routing` belongs to the pre-flight decision — where a policy will
      // permit this prompt to go — which is a governance act a rule can be
      // written about. Naming both the same made the timeline read "routing"
      // twice for opposite things.
      semantic_type: 'llm_provenance',
      gen_ai_system: record.provider ?? 'openrouter',
      activity_id: activityId,
    };

    // Sent with the entry captured while the activity was open, because by the
    // time the record exists the activity has closed.
    await evaluateHookSpan(pending.entry, spanData).catch(() => undefined);
    return record;
  })();

  _routingJobs.add(job);
  void job.catch(() => undefined).finally(() => _routingJobs.delete(job));
}

/**
 * Await outstanding provenance collection and return what was gathered.
 *
 * Called before a run closes, so the evidence is part of the session. Capped:
 * a record that never appears must not hold a run open.
 */
export async function drainRoutingAttestations(capMs = 12_000): Promise<RoutingProvenance[]> {
  if (_routingJobs.size === 0) return [];
  const jobs = Array.from(_routingJobs);
  const timeout = new Promise<Array<RoutingProvenance | null>>((resolve) => {
    const timer = setTimeout(() => resolve([]), capMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  const settled = await Promise.race([
    Promise.all(jobs.map((j) => j.catch(() => null))),
    timeout,
  ]);
  return settled.filter((r): r is RoutingProvenance => r != null);
}

export function takeAssistantText(activityId: string): string | null {
  const text = _assistantText.get(activityId);
  if (text === undefined) return null;
  _assistantText.delete(activityId);
  return text;
}

function captureHttpBodyChunk(chunks: Buffer[], chunk: unknown): void {
  if (Buffer.isBuffer(chunk)) chunks.push(chunk);
  else if (typeof chunk === 'string') chunks.push(Buffer.from(chunk));
}

function chunksToText(chunks: Buffer[]): string | null {
  return chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : null;
}

function extractHttpMethod(args: unknown[]): string {
  for (const arg of args) {
    if (arg && typeof arg === 'object' && 'method' in arg) {
      const method = (arg as Record<string, unknown>).method;
      if (typeof method === 'string') return method.toUpperCase();
    }
  }
  return 'GET';
}

function extractHttpUrl(moduleName: 'node:http' | 'node:https', args: unknown[]): string {
  const protocol = moduleName === 'node:https' ? 'https:' : 'http:';
  const first = args[0];
  try {
    if (typeof first === 'string') return first;
    if (first instanceof URL) return first.toString();
    const candidate = args.find((arg) => arg && typeof arg === 'object' && ('hostname' in arg || 'host' in arg || 'path' in arg));
    if (candidate && typeof candidate === 'object') {
      const o = candidate as Record<string, unknown>;
      // `hostname` never carries the port, `host` may. Reattach an explicit
      // port when the resolved authority lacks one, otherwise a self-hosted
      // OpenBox Core on a non-default port (http://host:9902) reconstructs as
      // http://host/... and stops matching its own ignored-URL prefix — so
      // the governance client's calls to Core get instrumented as hook spans
      // and posted back to Core, which loops.
      let authority = String(o.hostname ?? o.host ?? 'unknown');
      const port = o.port == null || o.port === '' ? '' : String(o.port);
      if (port && !authority.includes(':')) authority = `${authority}:${port}`;
      const path = String(o.path ?? '/');
      return `${String(o.protocol ?? protocol)}//${authority}${path}`;
    }
  } catch {
    // best effort
  }
  return `${protocol}//unknown/`;
}

/**
 * Opt-in capture of request bodies from `Request` objects. Off by default —
 * see the call site for the failure it causes when on.
 */
let _captureRequestObjectBody = false;

export function setCaptureRequestObjectBody(enabled: boolean): void {
  _captureRequestObjectBody = enabled;
}

export function setupSpanProcessorInstrumentation(options: { http?: boolean } = {}): void {
  if (options.http ?? true) {
    patchFetch();
    patchHttpModules();
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Register an LLM activity so outgoing fetch calls during its execution
 * are captured as http_request spans and sent to Core.
 *
 * Registers the activity context and its trace so spans made inside it are
 * attributed to the right activity.
 */
export function registerActivity(
  activityId: string,
  ctx: ActivityContext,
  transport: OpenBoxTransport,
  traceId: string,
  opts: RegisterActivityOptions,
): void {
  patchFetch();
  _activeActivities.set(activityId, {
    ctx,
    transport,
    traceId,
    hitl: opts.hitl,
    onApiError: opts.onApiError,
    logger: opts.logger,
    requestTimeoutMs: opts.requestTimeoutMs,
  });
}

/**
 * Run a governed operation in an async-local activity scope.
 * Resolves the owning activity from async-local state rather than relying on
 * whichever registered activity happens to be first in the map.
 */
export async function runWithActivity<T>(
  activityId: string,
  handler: () => Promise<T>,
): Promise<T> {
  return _activityScope.run({ get: () => activityId }, handler);
}

/**
 * Run `handler` in a scope whose activity is resolved at call time.
 *
 * Used by the OpenRouter binding, where one consumption of a `ModelResult`
 * covers several model turns and the open llm_call changes between them —
 * see {@link ActivityScope}. `resolve` returning undefined means "nothing
 * open right now", and instrumentation is skipped for that call rather than
 * being attributed to a stale activity.
 */
export async function runWithActivityResolver<T>(
  resolve: () => string | undefined,
  handler: () => Promise<T>,
): Promise<T> {
  return _activityScope.run({ get: resolve }, handler);
}

/**
 * Synchronous variant of {@link runWithActivityResolver}, returning whatever
 * `handler` returns rather than a promise. Needed to scope a method whose
 * return value must stay synchronous — an async iterable, or a getter-backed
 * value — where wrapping in a promise would change the caller's contract.
 */
export function runInScopeSync<T>(resolve: () => string | undefined, handler: () => T): T {
  return _activityScope.run({ get: resolve }, handler);
}

/**
 * Clear hook-level abort state after HITL approval.
 * Mirrors span_processor.clear_activity_abort().
 */
/**
 * Mark an activity aborted, so the next patched fetch inside its scope refuses
 * to make the call.
 *
 * Works for an id that was never registered — which is the case that matters:
 * after a halt the SDK does not open (or register) another llm_call, it just
 * needs the engine's next provider request to die instead of spending money on
 * a run governance has already stopped. `patchedFetch` admits an unregistered
 * id specifically when it is aborted.
 */
export function abortActivity(activityId: string, reason: string): void {
  _activityAbort.set(activityId, reason);
}

export function clearActivityAbort(activityId: string): void {
  _activityAbort.delete(activityId);
}

/**
 * Mark an activity as approved so subsequent HTTP hook verdicts of
 * require_approval are suppressed for the rest of this tool execution.
 * Call this after pollApprovalOrHalt() returns at ToolStarted/LLMStarted level.
 */
export function markActivityApproved(activityId: string): void {
  _approvedActivities.add(activityId);
}

/**
 * True when the hook set an abort for this activity.
 * Used to detect require_approval blocks that the tool swallowed internally
 * (returned the error as a string) rather than propagating as an exception.
 */
export function hasActivityAbort(activityId: string): boolean {
  return _activityAbort.has(activityId);
}

/**
 * The reason recorded for this activity's abort (block/halt, an approval
 * rejection/expiry/timeout, or HITL-disabled), if any. Prefer this over
 * trying to introspect a caught error's message/cause chain — see
 * abortAndThrow's doc comment for why the caught error can't be trusted.
 */
export function getActivityAbortReason(activityId: string): string | undefined {
  return _activityAbort.get(activityId);
}

/**
 * True when this activity was already approved (at ToolStarted/LLMStarted level).
 * Used to skip HITL at ToolCompleted/LLMCompleted — one approval covers the full call.
 */
export function isActivityApproved(activityId: string): boolean {
  return _approvedActivities.has(activityId);
}

/**
 * Unregister an LLM activity after the model call completes.
 * 
 */
export async function unregisterActivity(activityId: string): Promise<void> {
  // Drain first: dropping the registration while completion spans are still in
  // flight makes evaluateActivitySpan discard them, so operations would show a
  // 'started' span and never a 'completed' one.
  try {
    await drainSpanSends(activityId);
  } catch { /* individual sends already fail-open */ }
  _activeActivities.delete(activityId);
  _activityAbort.delete(activityId);
  _approvedActivities.delete(activityId);
  _inFlightSpans.delete(activityId);
  // Keys are `${activityId}|${span_id}` now, so drop the whole activity's set.
  for (const key of _sendChain.keys()) {
    if (key.startsWith(`${activityId}|`)) _sendChain.delete(key);
  }
  for (const key of _ungatedSpans) {
    if (key.startsWith(`${activityId}|`)) _ungatedSpans.delete(key);
  }
  _activityGates.delete(activityId);
  // Anything not taken by LLMCompleted (a call that failed, or events off).
  _assistantText.delete(activityId);
  _llmSpanPending.delete(activityId);
  _pendingRouting.delete(activityId);
  settleAssistantWaiters(activityId, null);
}

/**
 * Remove all lingering activity registrations for a completed workflow.
 * 
 * Called from handleAfterAgent as a safety net — individual activities should
 * already be cleaned up by their own unregisterActivity() calls.
 */
export function unregisterWorkflow(workflowId: string): void {
  for (const [activityId, entry] of _activeActivities) {
    if (entry.ctx.workflow_id === workflowId) {
      _activeActivities.delete(activityId);
      _activityAbort.delete(activityId);
      _approvedActivities.delete(activityId);
    }
  }
}
