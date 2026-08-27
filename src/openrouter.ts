/**
 * The OpenRouter Agent SDK binding — the counterpart of `OpenBoxAgent.node.ts`
 * of this SDK.
 *
 * ─── How the middleware attaches ──────────────────────────────────────────
 *
 * A host that owns its agent loop calls the five middleware methods directly.
 * `@openrouter/agent` owns the loop instead, and exposes
 * two extension points: the `tool()` objects it executes, and the lifecycle
 * hooks it emits. So governance is attached in three places:
 *
 *   middleware method             attached here via
 *   ─────────────────────────     ──────────────────────────────────────────
 *   beforeAgent()             →   awaited inside `callModel()` before the
 *                                 request goes out (NOT the SessionStart /
 *                                 UserPromptSubmit hooks — those fire too
 *                                 late to redact the prompt that is already
 *                                 in flight, and the wrapper owns
 *                                 `request.input` anyway)
 *   wrapModelCall()           →   split across the turn boundary: the
 *                                 LLMStarted pre-screen runs before each
 *                                 model call, LLMCompleted on `PostModelCall`
 *   wrapToolCall()            →   `tools()` wraps each tool's `execute`/`run`
 *   afterAgent()              →   `SessionEnd`
 *
 * ─── The one real gap ─────────────────────────────────────────────────────
 *
 * `@openrouter/agent` has no pre-model hook — `PostModelCall` fires after the
 * tokens are already spent. A model call is therefore pre-screened by opening
 * the LLMStarted activity at the two points where the engine is guaranteed to
 * be about to make one:
 *
 *   1. before `callModel()` invokes the engine (the initial turn), and
 *   2. on the first `PreToolUse` of a tool round — a tool round is always
 *      followed by another model call.
 *
 * A `block`/`halt` verdict at either point throws out of the wrapper or out
 * of the hook, aborting the run before the call. In addition the HTTP
 * instrumentation in `span_processor.ts` intercepts the actual request to
 * OpenRouter mid-flight, which is a genuine pre-response gate. What is NOT
 * available is a per-call gate on a model call the engine decides to make for
 * some other reason (a retry, a `Stop`-hook forced resume); those are
 * governed observationally via `PostModelCall`.
 */

import type { HooksManager, InlineHookConfig, LifecycleHookContext } from '@openrouter/agent';
import type {
  PermissionRequestPayload,
  PermissionRequestResult,
  PostModelCallPayload,
  PostToolUseFailurePayload,
  PostToolUsePayload,
  PreToolUsePayload,
  PreToolUseResult,
  SessionEndPayload,
  StopPayload,
  StopResult,
  DoomLoopDetectedPayload,
  DoomLoopDetectedResult,
} from '@openrouter/agent';

import { AsyncLocalStorage } from 'async_hooks';

import type { OpenBoxOpenRouterOptions } from './config';
import {
  applyPiiRedaction,
  baseEventFields,
  buildEvent,
  evaluate,
  extractResponseMetadata,
  sendOrphanClosure,
  Turn,
} from './hooks';
import { toErrorInfo } from './error-info';
import { pollApprovalOrHalt } from './hitl';
import { OpenBoxOpenRouterMiddleware } from './middleware';
import {
  abortActivity,
  clearActivityAbort,
  registerActivity,
  runInScopeSync,
  awaitAssistantText,
  beginRoutingAttestation,
  drainRoutingAttestations,
  evaluateActivitySpan,
  runWithActivityResolver,
  unregisterActivity,
} from './span_processor';
import { readRequestedRouting, type RequestedRouting, type RoutingProvenance } from './provenance';
import {
  applyRoutingToRequest,
  describeResolution,
  describeRouting,
  narrowRouting,
  readRoutingDirective,
  routingRecordSpans,
  routingSpan,
  routingTarget,
} from './preflight_routing';
import { hexId, safeSerialize, type GovernanceVerdictResponse } from './types';
import {
  enforceVerdict,
  GovernanceBlockedError,
  GovernanceHaltError,
  unwrapGovernanceError,
} from './verdict';

/**
 * Minimal structural view of `@openrouter/agent`'s `Tool`. Typed structurally
 * rather than importing the real generic union so `tools()` can accept a
 * heterogeneous array (regular / generator / unified / manual) without the
 * caller's precise tool types being widened — see `tools()` below.
 */
interface ToolLike {
  /**
   * `tool()` returns the OpenAI wire shape — `{type: 'function', function:
   * {name, inputSchema, execute, description}}` — so the governable body sits
   * one level down, NOT at the top level. `toolBody()` resolves both that
   * shape and a flat hand-built one.
   */
  type?: unknown;
  function?: { name?: string; execute?: unknown; run?: unknown; [key: string]: unknown };
  name?: string;
  execute?: unknown;
  run?: unknown;
  [key: string]: unknown;
}

/**
 * Locate a tool's governable body regardless of which shape it is in.
 * Returns the object that OWNS the body (so the caller can replace the
 * property on a copy of exactly that object), the property key, and the tool
 * name to report to Core.
 */
function toolBody(
  t: ToolLike,
): { owner: Record<string, unknown>; key: 'execute' | 'run'; name: string } | null {
  const candidates: Array<Record<string, unknown>> = [];
  if (t.function != null && typeof t.function === 'object') {
    candidates.push(t.function as Record<string, unknown>);
  }
  candidates.push(t as unknown as Record<string, unknown>);

  for (const owner of candidates) {
    for (const key of ['execute', 'run'] as const) {
      if (typeof owner[key] === 'function') {
        const name = typeof owner.name === 'string' ? owner.name : (t.name ?? '');
        if (!name) continue;
        return { owner, key, name };
      }
    }
  }
  return null;
}

/** Minimal structural view of `callModel`'s `request` argument. */
interface CallModelRequestLike {
  model?: unknown;
  input?: unknown;
  hooks?: InlineHookConfig | HooksManager;
  [key: string]: unknown;
}

/**
 * Per-run state. One instance per `callModel()` call — never shared, so two
 * concurrent runs on one middleware can't clobber each other's turn identity
 * or LLM activity id. Turn identity is
 * a value threaded through calls, never mutable state on the middleware.
 */
class RunState {
  readonly turn: Turn;
  /**
   * Routing constraint read off the caller's request object, once per run.
   *
   * The wire body is the better source and is preferred when available; this is
   * the fallback for the common case where `captureRequestObjectBody` is off.
   */
  declaredRouting: RequestedRouting | null = null;
  /**
   * Routing a policy narrowed the request to, pre-flight. Set only while this
   * SDK still owns the request object — the pre-flight turn — because that is
   * the only point at which the constraint can still be written into what goes
   * out. After that it is `declaredRouting` that carries the effective
   * constraint, so later turns state the narrowed one, not the original.
   */
  appliedRouting: RequestedRouting | null = null;
  /** The model the caller asked for, reported with the routing. */
  model: string | null = null;
  /**
   * When this turn's routing began — the first attempt at the call, not the
   * re-opened one. The record spans are written by the call that runs, which is
   * after the fact, so they carry this rather than the time they were sent.
   */
  routingStartedAtMs = 0;
  /** What it asked for before a policy redirected it, kept for the record. */
  routingRedirectedFrom: RequestedRouting | null = null;
  /**
   * A refusal raised while the engine was mid-call, and the promise waiting on
   * it.
   *
   * A span-level block rejects the patched fetch, and the engine swallows that
   * rejection — so the caller's `getText()` never settles and the process exits
   * with no answer and no error. The existing verdict-wins check only runs when
   * the engine's promise resolves, which in that case it never does. This is
   * the signal that is RACED against the engine, so a refused call fails as a
   * refusal rather than as silence.
   */
  blockedError: Error | null = null;
  /**
   * The finalization started for a refusal, so `close()` can wait for it.
   *
   * It is started without being awaited — the caller's error must not queue
   * behind bookkeeping — which means the process can otherwise exit before the
   * session is closed. Measured: exit 2 with the right reason printed, and the
   * session still `pending`.
   */
  pendingFinalize: Promise<void> | null = null;
  private blockedWaiters: Array<(err: Error) => void> = [];

  /** Record a refusal and wake anything waiting on one. */
  noteBlocked(err: Error): void {
    if (this.blockedError != null) return;
    this.blockedError = err;
    const waiters = this.blockedWaiters;
    this.blockedWaiters = [];
    for (const wake of waiters) wake(err);
  }

  /** Resolves only if this run is refused. Never rejects, never settles twice. */
  blockedSignal(): Promise<Error> {
    if (this.blockedError != null) return Promise.resolve(this.blockedError);
    return new Promise<Error>((resolve) => {
      this.blockedWaiters.push(resolve);
    });
  }

  /** Activity id of the currently-open llm_call, if any. */
  llmActivityId: string | null = null;
  llmStartedAtMs = 0;
  /** Prompt governed for this run — reused as the llm_call activity_input. */
  promptText: string;
  /**
   * What has actually been sent to the model so far, in order.
   *
   * Turn 1's input is the user prompt, and that is all the SDK owns. Every
   * turn after it is the prompt PLUS the assistant messages and tool results
   * the engine accumulated — but the engine does not hand that conversation
   * to any hook, so `LLMStarted` for turn 2+ used to report the run's
   * ORIGINAL prompt as the input. On a long multi-turn run that is a wrong
   * claim about what the model was asked, not merely a missing detail.
   *
   * Reconstructed here from what the hooks do carry: the assistant text
   * recovered from the model call's own response body (see
   * `takeAssistantText`) and each tool's output at PostToolUse. It is a
   * faithful record of the conversation's content, not a byte-exact copy of
   * the provider request — the engine's own framing (system prompt, tool
   * schemas, truncation) is not visible from here, and nothing here claims it
   * is.
   */
  readonly transcript: Array<{ role: string; name?: string; content: string }> = [];
  /** Tool names governed by `tools()`; hooks skip these to avoid double events. */
  readonly wrappedToolNames: ReadonlySet<string>;
  /**
   * The halt that ended this run, if one was raised.
   *
   * A halt is the arm that means "stop the agent", but throwing it from a hook
   * handler does NOT stop this engine: `HooksManager` runs handlers with
   * `throwOnHandlerError` false, so it logs the exception and carries on, and
   * a halt raised inside a wrapped tool body is caught by the engine and
   * handed to the model as an ordinary failed tool call. Verified against a
   * real Core with an OPA policy returning STOP: the tool was stopped, the
   * halt was logged by the engine, and the run then completed normally and
   * returned an answer to the caller — the opposite of halt.
   *
   * So the halt is recorded here and enforced where the engine cannot swallow
   * it: no further model call is allowed out (see `openLlmActivity`), every
   * consumption of the result rethrows it instead of returning the text, and
   * the run is closed as failed.
   */
  haltError: Error | null = null;
  /**
   * Scope id used only to refuse the engine's next provider request after a
   * halt. Deliberately NOT `llmActivityId`: that field means "an llm_call is
   * open on Core", and putting a never-registered id there made the following
   * `PostModelCall` close an activity that never started — an orphan
   * completion on Core, flagged by the sequence checker as
   * `completed_without_started`.
   */
  abortActivityId: string | null = null;
  /** Set once the run has been finalized, so it can never be closed twice. */
  closed = false;
  /** SessionEnd has fired — the engine is done, but the caller may still be reading. */
  engineEnded = false;
  endReason: SessionEndPayload['reason'] | null = null;
  /**
   * Consumptions of the ModelResult currently in flight. WorkflowCompleted is
   * held until this hits zero, because the final answer is not in hand until
   * the caller's `getText()` (or stream) has actually resolved.
   */
  consumptionsInFlight = 0;
  /** The agent's final answer, captured from whatever consumed the result. */
  finalText: string | null = null;
  /**
   * In-flight tool calls governed via the hook path, queued per tool name.
   *
   * Carries the activity id as well as the start time. Both halves of a tool
   * call MUST report the same activity_id — Core pairs a completion to its
   * start by that id, and minting a fresh one at PostToolUse (as this did)
   * produced two orphans per call: a start that never finishes and a
   * completion belonging to nothing.
   *
   * A QUEUE rather than a single slot because PreToolUse/PostToolUse carry no
   * call id, so two concurrent calls to the same tool are indistinguishable;
   * FIFO pairs them plausibly instead of overwriting.
   */
  readonly hookToolCalls = new Map<string, Array<{ activityId: string; startedAt: number }>>();
  /**
   * Tools of the current round that have entered PreToolUse but not yet
   * finished. The next llm_call is opened only when this returns to zero —
   * see `endOfToolRound()`.
   */
  pendingTools = 0;

  constructor(turn: Turn, promptText: string, wrappedToolNames: ReadonlySet<string>) {
    this.turn = turn;
    this.promptText = promptText;
    this.wrappedToolNames = wrappedToolNames;
    this.transcript.push({ role: 'user', content: promptText });
  }
}

export interface OpenBoxGovernance {
  /** The underlying middleware, if you need to drive it directly. */
  readonly middleware: OpenBoxOpenRouterMiddleware;

  /**
   * Wrap each tool so its execution is governed end-to-end
   * (ToolStarted → HITL approval → execute → ToolCompleted), exactly as
   * `wrapToolCall` does.
   *
   * Tools whose body cannot be wrapped without changing its semantics —
   * async-generator `execute`, and manual tools with no body at all — are
   * returned untouched and governed through the `PreToolUse`/`PostToolUse`
   * hooks instead. That path still blocks and still reports, but it cannot
   * hold the call open across a human approval, and it produces no
   * http/db spans scoped to the tool.
   */
  tools<T extends readonly unknown[]>(tools: T): T;

  /**
   * Governed `callModel`. Pass the real `callModel` from `@openrouter/agent`
   * as `fn`. Returns the SDK's own `ModelResult` untouched, so every
   * consumption pattern (`getText`, `getTextStream`, …) still works — only
   * the pre-flight governance is awaited.
   */
  callModel<TClient, TRequest, TOptions, TResult>(
    fn: (client: TClient, request: TRequest, options?: TOptions) => TResult,
    client: TClient,
    request: TRequest,
    options?: TOptions,
  ): Promise<TResult>;

  /**
   * Drain in-flight span telemetry and release instrumentation state. Always
   * await it — the counterpart to opening the run.
   */
  close(): Promise<void>;

  /**
   * What the routing provenance for the finished runs actually said.
   *
   * The same summary that rides on `WorkflowCompleted.extra` — who served each
   * call, from which region, at what cost, and whether a stated allowlist held.
   * Exposed because a developer who wants to show or assert on this should not
   * have to read it back out of the dashboard.
   *
   * Populated as each run finalizes, so read it after `close()`. Empty when no
   * provenance was collected (attestation off, no API key, or records that
   * never arrived).
   */
  routingSummaries(): ReadonlyArray<Record<string, unknown>>;
}

/**
 * Create the governance binding.
 *
 * ```ts
 * import { callModel, tool } from '@openrouter/agent';
 * import { createOpenBoxGovernance } from 'openbox-openrouter-governance';
 *
 * const openbox = createOpenBoxGovernance({ agentName: 'research-agent' });
 *
 * const result = await openbox.callModel(callModel, client, {
 *   model: 'anthropic/claude-sonnet-5',
 *   input: 'Summarize the incident report',
 *   tools: openbox.tools([searchTool, dbTool]),
 * });
 * console.log(await result.getText());
 * await openbox.close();
 * ```
 */
export function createOpenBoxGovernance(
  options: OpenBoxOpenRouterOptions = {},
): OpenBoxGovernance {
  const mw = new OpenBoxOpenRouterMiddleware(options);
  const wrappedToolNames = new Set<string>();
  // Turn identity for the tool wrappers, which run inside the engine and have
  // no way to receive the RunState. Keyed by nothing: a wrapper closes over
  // the middleware, and the active run is resolved through this stack. Nested
  // concurrent runs push/pop, and the most recent open run wins — see
  // `currentRun()`.
  const openRuns: RunState[] = [];
  /** Routing summaries of finalized runs, surfaced via `routingSummaries()`. */
  const collectedRoutingSummaries: Array<Record<string, unknown>> = [];
  // Carries the active run through the engine and through result consumption,
  // so concurrent runs on one instance never cross-attribute their tools.
  const runScope = new AsyncLocalStorage<RunState>();

  /**
   * Resolve the run a tool body belongs to.
   *
   * Async-local first: the engine invocation and every consumption of its
   * result are wrapped in `runScope`, so a tool executing inside the engine
   * lands on its OWN run. The fallback — most recent still-open run — is only
   * reached if the async context was lost, and is wrong under concurrency:
   * with two `callModel` calls in flight on one governance instance it would
   * bill one run's tool to the other. Keeping it means a lost context
   * degrades to a plausible guess rather than dropping governance entirely,
   * which for a tool that moves money is the safer of the two failures.
   */
  function currentRun(): RunState | undefined {
    const scoped = runScope.getStore();
    if (scoped && !scoped.closed) return scoped;
    for (let i = openRuns.length - 1; i >= 0; i--) {
      if (!openRuns[i].closed) return openRuns[i];
    }
    return undefined;
  }

  /**
   * Record a halt if this error is one (at any depth of its cause chain — an
   * HTTP client in between will have wrapped it). First halt wins: the one
   * that stopped the run is the one worth reporting.
   */
  function noteHalt(run: RunState, err: unknown): void {
    if (run.haltError != null) return;
    const governance = unwrapGovernanceError(err);
    if (governance instanceof GovernanceHaltError) run.haltError = governance;
  }

  // ── LLM activity lifecycle ────────────────────────────────────────────────

  /**
   * The routing step: its own activity, between the call that was refused and
   * the call that runs.
   *
   * It is an activity rather than a pair of spans on the model call because it
   * is a different thing from the model call — the SDK deciding where a prompt
   * may go, on the policy's instruction. Under it sit the two halves of the
   * routing itself, naming the provider and model the prompt is being routed
   * to. Allowed, because it is what happens: nothing here is in question by the
   * time it is written.
   *
   * The spans go through the hook path because that is the only one Core
   * persists, which means registering the activity for the length of it.
   */
  async function routeModelCall(
    run: RunState,
    routing: RequestedRouting,
    reason: string | null,
    startedAtMs: number,
  ): Promise<void> {
    const activityId = hexId(32);
    const target = routingTarget(run.model, routing);

    const started = await evaluate(
      mw,
      buildEvent(mw, run.turn, 'ActivityStarted', activityId, 'llm_routing', {
        activity_input: [
          {
            model: run.model,
            provider_only: routing.only ?? null,
            allow_fallbacks: routing.allowFallbacks ?? null,
            redirected_by_policy: reason,
          },
        ],
      }),
    );

    if (started != null) {
      try {
        const result = enforceVerdict(started, 'llm_routing');
        if (result.requiresHitl) {
          await pollApprovalOrHalt(mw, run.turn, activityId, 'llm_routing', result.approvalId);
          clearActivityAbort(activityId);
        }
      } catch (err) {
        noteHalt(run, err);
        await sendOrphanClosure(mw, run.turn, 'ActivityCompleted', activityId, 'llm_routing', err);
        throw err;
      }
    }

    registerActivity(
      activityId,
      {
        ...baseEventFields(mw, run.turn),
        event_type: 'ActivityStarted',
        activity_id: activityId,
        activity_type: 'llm_routing',
      },
      mw._client.transport,
      run.turn.workflowId,
      {
        hitl: mw._config.hitl,
        onApiError: mw._config.onApiError,
        logger: mw._config.logger,
        requestTimeoutMs: mw._config.governanceTimeout * 1000,
      },
    );

    const [routedStart, routedEnd] = routingRecordSpans(
      activityId,
      run.model,
      run.routingRedirectedFrom,
      routing,
      reason,
      { startMs: startedAtMs, endMs: Date.now() },
    );
    for (const span of [routedStart, routedEnd]) {
      await evaluateActivitySpan(activityId, span).catch(() => undefined);
    }
    await unregisterActivity(activityId);

    await evaluate(
      mw,
      buildEvent(mw, run.turn, 'ActivityCompleted', activityId, 'llm_routing', {
        status: 'completed',
        duration_ms: Date.now() - startedAtMs,
        activity_output: safeSerialize({ result: describeResolution(routing, reason) }),
      }),
    ).catch(() => undefined);

    mw._config.logger.warn(
      `${target}${reason != null ? ` — ${reason}` : ''}`,
    );
  }

  /**
   * How many times one turn's model call may be re-opened after a redirect.
   *
   * A redirect narrows the request and the re-opened call states the narrowed
   * constraint, so a policy that was asking for exactly that stops firing and
   * one re-open is always enough. This is a backstop against a policy that keeps
   * demanding a change it has already been given, not a retry budget.
   */
  const MAX_ROUTING_ATTEMPTS = 2;

  /**
   * What a model call's verdict says about its routing.
   *
   * A policy that wants a prompt routed elsewhere has to say so on a **block**
   * carrying `patch.new_input` — that is the only arm and key Core forwards a
   * directive on (`constrain`, `allow` and `monitor` all arrive with it
   * stripped; measured, not assumed). So the block lands on the model call as
   * originally routed, which is the thing that was actually refused, and this
   * decides what that means:
   *
   *   - `none` — the verdict says nothing about routing. Enforce it as-is.
   *   - `satisfied` — a directive the request already complies with. The policy
   *     is restating a constraint that is in force, so there is nothing to
   *     refuse; the block is enforced as an allow.
   *   - `redirect` — apply it, and let the call proceed to where it may go. The
   *     model call keeps the refusal on its start, because the call as routed
   *     genuinely was refused; the routing that fixed it is reported inside the
   *     same activity, between its start and its completion, so the row reads
   *     "refused as routed → routed here instead → done".
   *
   * It throws instead when the directive cannot be honoured: when it and the
   * request have no provider in common, and when the request belongs to the
   * engine rather than to us (turn two onwards), where a constraint that cannot
   * be applied must be refused rather than appear to have been applied.
   */
  function resolveRouting(
    run: RunState,
    response: GovernanceVerdictResponse | null,
    ownsRequest: boolean,
    attempt: number,
  ): 'none' | 'satisfied' | 'redirect' {
    if (!mw._config.preflightRouting) return 'none';
    const directive = readRoutingDirective(response);
    if (directive == null) return 'none';

    const reason = response?.reason ?? 'routing refused by policy';
    const narrowed = narrowRouting(run.declaredRouting, directive);
    const refuse = (message: string): never => {
      throw new GovernanceBlockedError('block', message);
    };

    if (!narrowed.satisfiable) {
      refuse(
        `OpenBox governance block at llm_routing: ${reason} — the policy's routing ` +
          `(${describeRouting(directive)}) and the request's ` +
          `(${describeRouting(run.declaredRouting ?? {})}) have no provider in common, so the ` +
          `prompt was not sent`,
      );
    }

    if (!narrowed.changed) return 'satisfied';

    if (!ownsRequest) {
      refuse(
        `OpenBox governance block at llm_routing: ${reason} — this turn's request is held by the ` +
          `engine, so ${describeRouting(narrowed.routing)} cannot be applied to it; refusing the ` +
          `call rather than sending it routed as it was`,
      );
    }

    if (attempt >= MAX_ROUTING_ATTEMPTS) {
      refuse(
        `OpenBox governance block at llm_routing: ${reason} — the policy asked for ` +
          `${describeRouting(narrowed.routing)} again after the call was already routed there; ` +
          `refusing rather than re-routing the same call indefinitely`,
      );
    }

    run.appliedRouting = narrowed.routing;
    run.routingRedirectedFrom = run.declaredRouting;
    // What the call states from here on is the constraint actually in force,
    // not the one the caller wrote — otherwise it reports the original and the
    // same policy fires again on a request that already complies.
    run.declaredRouting = narrowed.routing;
    mw._config.logger.warn(
      `policy routed this call to ${describeRouting(narrowed.routing)}` +
        (narrowed.removed.length > 0 ? ` (removed ${narrowed.removed.join(', ')})` : '') +
        ` — ${reason}`,
    );
    return 'redirect';
  }

  /**
   * Open the llm_call activity and enforce its verdict — the first half of
   * `handleWrapModelCall`. Throws on block/halt (closing the orphaned row
   * first) and polls on require_approval.
   */
  async function openLlmActivity(
    run: RunState,
    messages?: unknown[],
    attempt = 1,
  ): Promise<void> {
    if (run.llmActivityId != null) return; // already open for this turn

    // The run is already halted. Do not open another activity and do not ask
    // Core again — just make sure the engine's next request to the provider
    // cannot leave the process, and rethrow. Marking the scope aborted is what
    // actually stops it: the engine ignores a throwing hook handler, but the
    // patched fetch inside this scope refuses the call outright.
    if (run.haltError != null) {
      if (run.abortActivityId == null) {
        run.abortActivityId = hexId(32);
        abortActivity(run.abortActivityId, run.haltError.message);
      }
      throw run.haltError;
    }

    const activityId = hexId(32);
    run.llmActivityId = activityId;
    run.llmStartedAtMs = Date.now();
    // The routing clock starts with the first attempt, not with the re-opened
    // one: the routing began when the call was first asked for.
    if (attempt === 1) run.routingStartedAtMs = run.llmStartedAtMs;

    if (!mw._config.sendLlmStartEvent) return;

    // The claim a policy decides this call on, built once: it is sent with the
    // call, and again with its closure if the call is refused.
    const routingClaimSpan = mw._config.preflightRouting
      ? routingSpan(activityId, 'started', run.model, run.declaredRouting)
      : null;
    // A refused call must close on the same claim it was refused on, or its
    // completion is evaluated against nothing and the record reads BLOCK …
    // ALLOW for one activity in which nothing changed.
    const claim = routingClaimSpan != null
      ? { spans: [routingClaimSpan], span_count: 1 }
      : {};

    // Only the pre-flight turn has nothing but the prompt behind it.
    const isFirstTurn = run.transcript.length <= 1;

    const startResponse = await evaluate(
      mw,
      buildEvent(mw, run.turn, 'LLMStarted', activityId, 'llm_call', {
        // Turn 1 is the prompt and nothing else; from turn 2 on, report the
        // conversation that was actually sent rather than re-reporting the
        // original prompt (see `RunState.transcript`).
        activity_input: isFirstTurn
          ? [{ prompt: run.promptText }]
          : run.transcript.map((m) => ({ ...m })),
        prompt: isFirstTurn ? run.promptText : renderTranscript(run.transcript),
        // Where this call is routed, stated on the call itself — so a policy
        // that refuses it is refusing this model call as routed, which is what
        // actually happened. On a redirect the SDK re-opens the call under the
        // corrected routing and this span restates it (see `resolveRouting`).
        ...(routingClaimSpan != null ? { spans: [routingClaimSpan], span_count: 1 } : {}),
      }),
    );

    // PII redaction — apply whenever Core returned a valid coercion of
    // `redacted_input`. No length heuristic: redaction removes or replaces
    // content, it never expands it arbitrarily, and a length heuristic here
    // silently skipped legitimate (longer) redactions, leaking the raw prompt
    // to the provider. `messages` is only passed for the pre-flight
    // call, the one turn whose input this SDK still owns; a mid-run turn's
    // input lives inside the engine, so a redaction verdict there can only
    // block, not rewrite.
    const guardrails = startResponse?.guardrails_result ?? startResponse?.guardrailsResult;
    if (
      messages != null &&
      guardrails?.input_type === 'activity_input' &&
      guardrails.redacted_input != null
    ) {
      applyPiiRedaction(messages, guardrails.redacted_input);
      run.promptText = extractPromptText(messages);
      // The transcript must carry the redacted prompt too — it is replayed as
      // the input of every later turn, and leaking there would undo the
      // redaction one turn on.
      if (run.transcript.length > 0 && run.transcript[0].role === 'user') {
        run.transcript[0].content = truncate(run.promptText, MAX_TRANSCRIPT_ENTRY_CHARS);
      }
    }

    // Does this verdict say anything about where the call is routed?
    //
    // A block carrying a routing directive refused this call AS ROUTED. So this
    // attempt is closed and never runs — which is what a block means, and the
    // reason the redirect cannot simply be applied in place: an activity Core
    // recorded as blocked must not go on to execute. The corrected call is a
    // new one, evaluated fresh, and it is the one that carries the routing
    // record and the response.
    let routing: 'none' | 'satisfied' | 'redirect';
    try {
      routing = resolveRouting(run, startResponse, messages != null, attempt);
    } catch (err) {
      noteHalt(run, err);
      if (mw._config.sendLlmEndEvent) {
        await sendOrphanClosure(mw, run.turn, 'LLMCompleted', activityId, 'llm_call', err, claim);
      }
      run.llmActivityId = null;
      throw err;
    }

    if (routing === 'redirect') {
      // Close the refused attempt with the SAME claim it was refused on, so the
      // policy sees the same facts and its completion records the same verdict.
      // An activity whose start says BLOCK and whose completion says ALLOW is a
      // record that contradicts itself: nothing about the call changed between
      // the two, so nothing about the verdict should either.
      if (mw._config.sendLlmEndEvent) {
        await evaluate(
          mw,
          buildEvent(mw, run.turn, 'LLMCompleted', activityId, 'llm_call', {
            status: 'failed',
            error: toErrorInfo(
              new GovernanceBlockedError(
                'block',
                startResponse?.reason ?? 'routing refused by policy',
              ),
            ),
            // Why it was refused, and what happened next — read together, the
            // two say the whole thing: this call was not sent, and the prompt
            // went out under the routing the policy named instead.
            activity_output: safeSerialize({
              result:
                `blocked: ${startResponse?.reason ?? 'routing refused by policy'} — nothing was ` +
                `sent; ${routingTarget(run.model, run.appliedRouting)} and retried`,
            }),
            ...claim,
          }),
        ).catch(() => undefined);
      }
      run.llmActivityId = null;

      // Where it may go instead, as its own step.
      await routeModelCall(
        run,
        run.appliedRouting!,
        startResponse?.reason ?? null,
        run.routingStartedAtMs,
      );

      // …and the call again, routed there.
      return openLlmActivity(run, messages, attempt + 1);
    }

    if (startResponse != null) {
      try {
        const result = enforceVerdict(
          // A directive the request already complies with has nothing left to
          // enforce: the policy is restating a constraint that is in force.
          routing === 'satisfied'
            ? { ...startResponse, arm: 'allow', verdict: 'allow', action: 'allow' }
            : startResponse,
          'llm_start',
        );
        if (result.requiresHitl) {
          await pollApprovalOrHalt(mw, run.turn, activityId, 'llm_call', result.approvalId);
          clearActivityAbort(activityId);
        }
      } catch (err) {
        noteHalt(run, err);
        if (mw._config.sendLlmEndEvent) {
          await sendOrphanClosure(mw, run.turn, 'LLMCompleted', activityId, 'llm_call', err, claim);
        }
        run.llmActivityId = null;
        throw err;
      }
    }

    // Layer 2: register so the actual HTTPS call to OpenRouter is captured as
    // an http_request span under this activity (and can be aborted mid-flight
    // by a hook-level verdict).
    registerActivity(
      activityId,
      {
        ...baseEventFields(mw, run.turn),
        event_type: 'ActivityStarted',
        activity_id: activityId,
        activity_type: 'llm_call',
      },
      mw._client.transport,
      run.turn.workflowId,
      {
        hitl: mw._config.hitl,
        onApiError: mw._config.onApiError,
        logger: mw._config.logger,
        requestTimeoutMs: mw._config.governanceTimeout * 1000,
        // A span-level refusal of THIS call must reach the caller. The refusal
        // rejects the patched fetch and the engine swallows that rejection, so
        // without this signal the run stops with no answer and no error.
        onBlocked: (err) => {
          run.noteBlocked(err);
          // Close the run as failed, carrying the reason — nothing else will:
          // the engine emits no SessionEnd for a call it never completed, so
          // the session would sit at `pending` with no record of why it
          // stopped.
          //
          // Deliberately NOT awaited, and deliberately not routed through
          // `maybeFinalize`. Making the caller's error wait on finalization is
          // what broke this the first time: the refusal reached the consumption
          // handler, `release()` then called finalizeRun, that never settled,
          // and the rethrow never happened — the same silent exit, one layer
          // further in. The caller learns first; the bookkeeping follows.
          run.pendingFinalize = finalizeRun(run, err).catch(() => undefined);
        },
      },
    );

  }

  /**
   * Close the open llm_call — the second half of `handleWrapModelCall`.
   * Reuses the SAME activity id as LLMStarted: Core matches completions to
   * starts by activity_id, and a fresh id produces an orphan it discards.
   */
  async function closeLlmActivity(
    run: RunState,
    payload: PostModelCallPayload | null,
    failedWith?: unknown,
  ): Promise<void> {
    const activityId = run.llmActivityId;
    if (activityId == null) return;
    run.llmActivityId = null;

    // Awaited BEFORE unregisterActivity, which drops whatever is left over.
    // This is a wait, not a read: the span carrying the text completes just
    // after `PostModelCall` fires (see `awaitAssistantText`).
    //
    // Skipped for a refused call, which has no answer to wait for. The wait is
    // capped at 2s on an UNREF'd timer, so a process with nothing else pending
    // exits before it fires — and this close never reached its `WorkflowFailed`.
    // Measured: exit 2 with the right reason printed and the session still
    // `pending`, because the record was still queued behind a wait for text
    // that was never coming.
    const assistantText =
      run.blockedError != null ? null : await awaitAssistantText(activityId);
    if (assistantText != null) recordTranscript(run, 'assistant', assistantText);

    // Which provider actually served this call. Started here — while the
    // activity's context is still available to carry the span — but not
    // awaited: OpenRouter writes the generation record a moment after the
    // response, and no turn should wait on evidence nobody is blocked on. The
    // run drains it before closing (see finalizeRun).
    beginRoutingAttestation(activityId, run.declaredRouting, run.model);

    await unregisterActivity(activityId);

    if (!mw._config.sendLlmEndEvent) return;

    if (failedWith !== undefined) {
      await sendOrphanClosure(mw, run.turn, 'LLMCompleted', activityId, 'llm_call', failedWith);
      return;
    }

    const meta = extractResponseMetadata(payload);
    const resp = await evaluate(
      mw,
      buildEvent(mw, run.turn, 'LLMCompleted', activityId, 'llm_call', {
        status: 'completed',
        duration_ms: payload?.durationMs ?? Date.now() - run.llmStartedAtMs,
        llm_model: meta.llm_model,
        input_tokens: meta.input_tokens,
        output_tokens: meta.output_tokens,
        total_tokens: meta.total_tokens,
        ...(meta.has_tool_calls !== undefined ? { has_tool_calls: meta.has_tool_calls } : {}),
        completion: meta.completion ?? assistantText,
        // …and again as `activity_output`, because `completion` is not a
        // field Core's payload struct has — it is dropped at unmarshal, the
        // same way `workflow_output` is. `activity_output` is the key
        // Core copies into the `output` column for every event type, so this
        // is what actually puts the turn's answer on the timeline.
        ...(meta.completion ?? assistantText) != null
          ? { activity_output: safeSerialize({ result: meta.completion ?? assistantText }) }
          : {},
      }),
    );

    if (resp != null) {
      try {
        const endResult = enforceVerdict(resp, 'llm_end');
        if (endResult.requiresHitl) {
          await pollApprovalOrHalt(mw, run.turn, activityId, 'llm_call', endResult.approvalId);
        }
      } catch (err) {
        noteHalt(run, err);
        throw err;
      }
    }
  }

  /** Open a hook-path tool call, minting the id both halves will share. */
  function pushToolStart(run: RunState, toolName: string): string {
    const entry = { activityId: hexId(32), startedAt: Date.now() };
    const queue = run.hookToolCalls.get(toolName);
    if (queue) queue.push(entry);
    else run.hookToolCalls.set(toolName, [entry]);
    return entry.activityId;
  }

  /** Close the oldest outstanding call for a tool, if any. */
  function shiftToolStart(
    run: RunState,
    toolName: string,
  ): { activityId: string; startedAt: number } | undefined {
    const queue = run.hookToolCalls.get(toolName);
    if (!queue || queue.length === 0) return undefined;
    const entry = queue.shift();
    if (queue.length === 0) run.hookToolCalls.delete(toolName);
    return entry;
  }

  /**
   * Close the workflow. Deliberately NOT called straight from SessionEnd.
   *
   * SessionEnd fires while the engine is still unwinding — measurably BEFORE
   * `getText()` resolves (~0ms, but strictly before), so the final answer is
   * not available yet. Closing there sent `{result: null}` to Core on every
   * run, losing the one field a reviewer most wants to see. Awaiting the
   * consumption inside the handler is not an option either: the engine awaits
   * its hook handlers, so blocking on a promise that the engine itself has to
   * finish resolving would deadlock.
   *
   * So the close is driven by whichever finishes last — the engine, or the
   * caller reading the result. Both paths funnel through here, and `closed`
   * makes it idempotent.
   */
  async function finalizeRun(run: RunState, failedWith?: unknown): Promise<void> {
    if (run.closed) return;
    run.closed = true;
    // A halted run is a failed run, whichever path got here first — and so is
    // a refused one. Core marks a session halted itself on a halt verdict, but
    // nothing marks it on a block, so without this the run that was refused
    // sits at `pending` forever and the record never says why it stopped.
    failedWith = failedWith ?? run.haltError ?? run.blockedError ?? undefined;
    // The abort id is never registered, so nothing else would clean it up.
    if (run.abortActivityId != null) {
      clearActivityAbort(run.abortActivityId);
      run.abortActivityId = null;
    }

    // An llm_call still open means the run ended without a PostModelCall for
    // it (an error, or an abort). Close it as failed rather than leaving a
    // "started, never completed" row on Core.
    if (run.llmActivityId != null) {
      await closeLlmActivity(
        run,
        null,
        failedWith ?? new Error(`Run ended (${run.endReason ?? 'unknown'}) before the model call completed`),
      ).catch(() => undefined);
    }

    const error =
      failedWith != null
        ? failedWith instanceof Error
          ? failedWith
          : new Error(String(failedWith))
        : run.endReason === 'error'
          ? new Error('OpenRouter session ended with reason "error"')
          : undefined;

    // Routing evidence lands after the turn that produced it (OpenRouter
    // writes the record a moment later), so it is drained here — before the
    // session closes, which is what keeps it inside the session's attestation.
    const routing = await drainRoutingAttestations().catch(() => []);

    // Shaped as a messages array because that is what `handleAfterAgent`
    // reads to build `workflow_output`.
    const state = {
      messages: run.finalText != null ? [{ role: 'assistant', content: run.finalText }] : [],
    };

    const summary = routingSummary(routing);
    if (summary != null) collectedRoutingSummaries.push(summary);

    await mw
      .afterAgent(run.turn, state, error, summary)
      .catch(() => undefined);
  }

  /** Finalize if, and only if, both the engine and the reader are done. */
  async function maybeFinalize(run: RunState): Promise<void> {
    if (run.closed || !run.engineEnded || run.consumptionsInFlight > 0) return;
    await finalizeRun(run);
  }

  /**
   * A tool of the current round finished. When the LAST one does, open the
   * llm_call for the turn that follows.
   *
   * This is deliberately NOT done at PreToolUse. Opening it there made the
   * tool's ActivityStarted/Completed pair land INSIDE the llm_call's, so the
   * session log read as "the model call started, a tool ran during it, the
   * model call ended" — implying the tool executed mid-call. The log should
   * be a flat sequence (llm_call, tool, llm_call), and this is what restores it. The pre-screen gate is unaffected: the round still ends
   * strictly before the next model call.
   *
   * The counter (rather than a bare `llmActivityId == null` check) is what
   * makes a parallel tool round come out right — with several tools in
   * flight, opening on the first completion would nest all the others.
   */
  async function endOfToolRound(run: RunState): Promise<void> {
    run.pendingTools = Math.max(0, run.pendingTools - 1);
    if (run.pendingTools > 0) return;
    try {
      await openLlmActivity(run);
    } catch (err) {
      // This runs inside a hook handler, and the engine logs and continues
      // whatever a handler throws — so rethrowing alone would lose the
      // verdict. Recording it is what makes it stick (see RunState.haltError);
      // a block still propagates for the engine to deal with.
      noteHalt(run, err);
      throw err;
    }
  }

  // ── Hook entries ──────────────────────────────────────────────────────────

  function buildHooks(run: RunState): InlineHookConfig {
    return {
      PostModelCall: [
        {
          handler: async (payload: PostModelCallPayload) => {
            await closeLlmActivity(run, payload);
          },
        },
      ],

      // A tool round is always followed by another model call, so this is the
      // pre-screen point for turn N+1 (see the module header). Throwing here
      // aborts the run — the manager is constructed with
      // `throwOnHandlerError`, so a governance block is not swallowed.
      PreToolUse: [
        {
          handler: async (payload: PreToolUsePayload): Promise<PreToolUseResult | void> => {
            // Counted for EVERY tool, wrapped or not, so `endOfToolRound()`
            // knows when the round is actually over.
            run.pendingTools++;

            // Recorded for EVERY tool, wrapped or not, and before any skip:
            // the transcript is what turn N+1 reports as its input, so it
            // must reflect the conversation even for tools this SDK does not
            // emit events for. This is the model's tool call — the closest
            // the hooks come to showing the assistant's decision.
            recordTranscript(
              run,
              'assistant',
              `tool_call ${payload.toolName}(${safeSerializeText(payload.toolInput)})`,
            );

            // Tools wrapped by `tools()` are already fully governed by
            // `wrapToolCall`; governing them here too would double every
            // ToolStarted event and, under require_approval, ask a human
            // twice for the same call.
            if (run.wrappedToolNames.has(payload.toolName)) return;
            // Same reason as the wrapped path: a halted run asks no further
            // questions of Core.
            if (run.haltError != null) throw run.haltError;
            // `skipToolTypes` was honored by `wrapToolCall` but not here, so a
            // tool the caller explicitly excluded still produced events as
            // soon as it took the hook path.
            if (mw._config.skipToolTypes.has(payload.toolName)) return;

            const activityId = pushToolStart(run, payload.toolName);
            if (!mw._config.sendToolStartEvent) return;

            const response = await evaluate(
              mw,
              buildEvent(mw, run.turn, 'ToolStarted', activityId, payload.toolName, {
                activity_input: [safeSerialize(payload.toolInput)],
                tool_name: payload.toolName,
                tool_type: mw._config.toolTypeMap[payload.toolName],
              }),
            );
            if (response == null) return;

            try {
              const result = enforceVerdict(response, 'tool_start');
              if (result.requiresHitl) {
                await pollApprovalOrHalt(
                  mw,
                  run.turn,
                  activityId,
                  payload.toolName,
                  result.approvalId,
                );
              }
            } catch (err) {
              if (mw._config.sendToolEndEvent) {
                await sendOrphanClosure(
                  mw,
                  run.turn,
                  'ToolCompleted',
                  activityId,
                  payload.toolName,
                  err,
                );
              }
              // `block` is the hook's own short-circuit: returning it lets the
              // engine feed the denial back to the model (which can then
              // change course) instead of tearing the whole run down, which
              // is what an unwrapped tool deserves. A halt still throws.
              if (err instanceof GovernanceHaltError) throw err;
              return { block: err instanceof Error ? err.message : String(err) };
            }
          },
        },
      ],

      PostToolUse: [
        {
          handler: async (payload: PostToolUsePayload) => {
            try {
              recordToolResult(run, payload.toolName, payload.toolOutput);
              if (run.wrappedToolNames.has(payload.toolName)) return;
              if (mw._config.skipToolTypes.has(payload.toolName)) return;
              const call = shiftToolStart(run, payload.toolName);
              if (!mw._config.sendToolEndEvent) return;
              // Same id as the PreToolUse half — see RunState.hookToolCalls.
              const activityId = call?.activityId ?? hexId(32);
            await evaluate(
              mw,
              buildEvent(mw, run.turn, 'ToolCompleted', activityId, payload.toolName, {
                activity_output:
                  typeof payload.toolOutput === 'string'
                    ? safeSerialize({ result: payload.toolOutput })
                    : safeSerialize(payload.toolOutput),
                tool_name: payload.toolName,
                tool_type: mw._config.toolTypeMap[payload.toolName],
                status: 'completed',
                duration_ms: payload.durationMs,
              }),
              );
            } finally {
              await endOfToolRound(run);
            }
          },
        },
      ],

      PostToolUseFailure: [
        {
          handler: async (payload: PostToolUseFailurePayload) => {
            try {
              recordToolResult(run, payload.toolName, { error: toErrorInfo(payload.error) });
              if (run.wrappedToolNames.has(payload.toolName)) return;
              if (mw._config.skipToolTypes.has(payload.toolName)) return;
              if (!mw._config.sendToolEndEvent) return;
              const call = shiftToolStart(run, payload.toolName);
              const activityId = call?.activityId ?? hexId(32);
              const startedAt = call?.startedAt;
            await evaluate(
              mw,
              buildEvent(mw, run.turn, 'ToolCompleted', activityId, payload.toolName, {
                activity_output: safeSerialize({ error: toErrorInfo(payload.error) }),
                tool_name: payload.toolName,
                tool_type: mw._config.toolTypeMap[payload.toolName],
                status: 'failed',
                duration_ms: startedAt != null ? Date.now() - startedAt : undefined,
                error: toErrorInfo(payload.error),
              }),
              );
            } finally {
              await endOfToolRound(run);
            }
          },
        },
      ],

      // The SDK's own approval gate. OpenBox already decides approval inside
      // `wrapToolCall`/`PreToolUse` above, so this hook exists to make the
      // decision Core reached authoritative for the SDK's gate too, rather
      // than letting a second, unrelated prompt reach the user.
      PermissionRequest: [
        {
          handler: async (
            payload: PermissionRequestPayload,
          ): Promise<PermissionRequestResult> => {
            const activityId = hexId(32);
            const response = await evaluate(
              mw,
              buildEvent(mw, run.turn, 'ToolStarted', activityId, payload.toolName, {
                activity_input: [safeSerialize(payload.toolInput)],
                tool_name: payload.toolName,
                tool_type: mw._config.toolTypeMap[payload.toolName],
                extra: { risk_level: payload.riskLevel, permission_request: true },
              }),
            );
            if (response == null) return { decision: 'allow' };

            try {
              const result = enforceVerdict(response, 'permission_request');
              if (result.requiresHitl) {
                await pollApprovalOrHalt(
                  mw,
                  run.turn,
                  activityId,
                  payload.toolName,
                  result.approvalId,
                );
              }
              return { decision: 'allow' };
            } catch (err) {
              return {
                decision: 'deny',
                reason: err instanceof Error ? err.message : String(err),
              };
            }
          },
        },
      ],

      // Two engine-level safety signals. Reporting them is the point: an agent that
      // exhausts its turn budget, or loops on the same call, is exactly the
      // behavior a reviewer wants on the timeline rather than lost in stdout.
      Stop: [
        {
          handler: async (payload: StopPayload): Promise<StopResult | void> => {
            await evaluate(
              mw,
              buildEvent(mw, run.turn, 'SignalReceived', `${run.turn.runId}-stop`, 'agent_stop', {
                signal_name: 'stop',
                signal_args: [payload.reason],
              }),
            ).catch(() => null);
            // Observational only. Returning `forceResume` here would override
            // the caller's own stop condition, which is theirs to decide.
          },
        },
      ],

      DoomLoopDetected: [
        {
          handler: async (
            payload: DoomLoopDetectedPayload,
          ): Promise<DoomLoopDetectedResult | void> => {
            const response = await evaluate(
              mw,
              buildEvent(
                mw,
                run.turn,
                'SignalReceived',
                `${run.turn.runId}-doomloop-${payload.fingerprint.slice(0, 8)}`,
                'doom_loop',
                {
                  signal_name: 'doom_loop',
                  signal_args: [payload.detector, payload.action, payload.streak],
                  tool_name: payload.toolName,
                  extra: {
                    detector: payload.detector,
                    engine_action: payload.action,
                    streak: payload.streak,
                    fingerprint: payload.fingerprint,
                    message: payload.message,
                  },
                },
              ),
            ).catch(() => null);
            if (response == null) return;

            // A governance block/halt on a looping agent escalates to a full
            // stop. Anything else leaves the engine's own ladder alone —
            // de-escalating a verdict Core did not ask to de-escalate would
            // be the SDK overruling policy.
            try {
              enforceVerdict(response, 'doom_loop');
            } catch {
              return { overrideAction: 'stop' };
            }
          },
        },
      ],

      SessionEnd: [
        {
          handler: async (payload: SessionEndPayload, _ctx: LifecycleHookContext) => {
            run.engineEnded = true;
            run.endReason = payload.reason;
            // Only close inline when nobody is mid-read; otherwise the reader
            // closes it once the final answer is actually in hand. See
            // `finalizeRun` for why this must not await the reader.
            if (run.consumptionsInFlight === 0) await finalizeRun(run);
          },
        },
      ],
    };
  }

  // ── Public surface ────────────────────────────────────────────────────────

  // Typed `readonly unknown[]` in and `T` out, NOT `readonly ToolLike[]`: the
  // SDK's real `Tool` is a closed generic union with no index signature, so a
  // structural parameter type rejects it outright, and a widened one would
  // erase the per-tool types `callModel` relies on to infer `context`. The
  // shape is checked at runtime by `toolBody()` instead.
  function tools<T extends readonly unknown[]>(list: T): T {
    return (list as readonly ToolLike[]).map((t) => {
      const found = toolBody(t);
      // A manual tool has no body to wrap at all; it falls through to the
      // hook path, which governs without touching execution semantics.
      if (!found) return t;

      const { owner, key, name } = found;
      const original = owner[key] as (...args: unknown[]) => unknown;

      // An async-generator body streams partial results to the engine; running
      // it inside `wrapToolCall` would mean buffering every yield until the
      // tool finished, silently converting a streaming tool into a batch one.
      // Also falls through to the hook path.
      if (isAsyncGeneratorFunction(original)) return t;

      wrappedToolNames.add(name);
      const governed = async (...args: unknown[]) => {
        const run = currentRun();
        // No open run means the tool was invoked outside a governed
        // `callModel` — run it ungoverned rather than inventing a turn
        // identity that would produce an orphan workflow on Core.
        if (!run) return original(...args);
        // Once the run is halted, do not ask Core (or a human) again. The
        // engine retries a failed tool call, and each retry re-entered
        // governance: a timed-out approval produced three separate approval
        // requests for one refund, each waiting out the full HITL timeout.
        if (run.haltError != null) throw run.haltError;
        try {
          return await mw.wrapToolCall(run.turn, name, args[0], async () => original(...args));
        } catch (err) {
          // The engine catches a throwing tool body and reports it to the
          // model as a failed tool call, so a halt raised here would otherwise
          // end the tool and nothing more.
          noteHalt(run, err);
          throw err;
        }
      };

      // Copy with property descriptors and the original prototype, not a bare
      // `{...t}` spread: a tool object may carry getters or non-enumerable
      // fields (and future SDK versions may make it a class instance), all of
      // which a spread would silently drop — producing a tool the engine then
      // rejects as malformed.
      const clone = (obj: Record<string, unknown>): Record<string, unknown> =>
        Object.create(Object.getPrototypeOf(obj), Object.getOwnPropertyDescriptors(obj));

      if (owner === (t as unknown as Record<string, unknown>)) {
        const copy = clone(owner);
        copy[key] = governed;
        return copy as unknown as ToolLike;
      }

      const outer = clone(t as unknown as Record<string, unknown>);
      const inner = clone(owner);
      inner[key] = governed;
      outer.function = inner;
      return outer as unknown as ToolLike;
    }) as unknown as T;
  }

  async function governedCallModel<TClient, TRequest, TOptions, TResult>(
    fn: (client: TClient, request: TRequest, options?: TOptions) => TResult,
    client: TClient,
    rawRequest: TRequest,
    callOptions?: TOptions,
  ): Promise<TResult> {
    // Widened once here so the body can read `input`/`hooks`; the object handed
    // back to `fn` is re-narrowed to the caller's own `TRequest`.
    const request = rawRequest as unknown as CallModelRequestLike;
    const messages = normalizeInput(request.input);
    // Read once here: `provider.only` lives on the object the caller passed,
    // and reading it needs neither a body capture nor a Request clone.
    const declaredRouting = readRequestedRouting(request);
    const state = { messages };

    // WorkflowStarted + SignalReceived, enforced. Throws on block/halt.
    let turn: Turn;
    try {
      turn = await mw.beforeAgent(state, mw._config.sessionId);
    } catch (err) {
      // beforeAgent attaches the minted turn to the error so the workflow can
      // still be closed even when the gate itself rejected the run.
      const recovered = (err as Record<string, unknown> | null)?.__obTurn as Turn | undefined;
      if (recovered) {
        await mw
          .afterAgent(recovered, state, err instanceof Error ? err : new Error(String(err)))
          .catch(() => undefined);
      }
      throw err;
    }

    const run = new RunState(turn, extractPromptText(state.messages), wrappedToolNames);
    run.declaredRouting = declaredRouting;
    run.model = typeof request.model === 'string' ? request.model : null;
    openRuns.push(run);

    try {
      // Pre-screen the initial model call before the request goes out. This
      // may rewrite `state.messages` in place with Core's redacted text.
      await openLlmActivity(run, state.messages);

      // Write the (possibly redacted) messages back into the request shape the
      // caller used, so the redaction actually reaches the provider rather
      // than only being reflected in telemetry.
      const governedInput = denormalizeInput(request.input, state.messages);
      // Same idea for a routing constraint the routing step narrowed: a
      // directive reflected only in telemetry is not enforcement. This is the
      // last point at which the request is still ours to write.
      const routedRequest =
        run.appliedRouting != null
          ? applyRoutingToRequest(request, run.appliedRouting)
          : request;
      const hooks = mergeHooks(request.hooks, buildHooks(run));

      // Run the engine inside an activity scope so the HTTP call it makes to
      // OpenRouter is captured as an http_request span — and can be aborted
      // mid-flight by a hook-level verdict, which is the only true pre-response
      // gate available here. The scope resolves `run.llmActivityId` lazily
      // because that id is replaced at each turn boundary. The abort id wins
      // while it is set: it exists precisely so the engine's next request
      // lands in a scope that refuses it.
      const scope = () => run.abortActivityId ?? run.llmActivityId ?? undefined;
      // Raced against a refusal, because the engine call itself may never
      // settle. A span-level block rejects the patched fetch and the engine
      // swallows that rejection — measured: `fn` pending forever, the process
      // exiting 0 with no answer, no error, and the session left `pending`.
      // Whether the engine propagates the rejection depends on where in its
      // pipeline the call was refused, so it cannot be relied on either way.
      // The consumption path is raced too, for a refusal that lands later.
      const result = await Promise.race([
        runScope.run(run, async () =>
          runWithActivityResolver(scope, async () =>
            fn(
              client,
              { ...routedRequest, input: governedInput, hooks } as unknown as TRequest,
              callOptions,
            ),
          ),
        ),
        run.blockedSignal().then((err): never => {
          throw err;
        }),
      ]);
      return scopeResultConsumption(result, scope, runScope, run, {
        begin: () => {
          run.consumptionsInFlight++;
        },
        end: async (finalText) => {
          run.consumptionsInFlight = Math.max(0, run.consumptionsInFlight - 1);
          if (finalText != null) run.finalText = finalText;
          await maybeFinalize(run);
        },
        halted: () => run.haltError ?? run.blockedError,
        // Resolves only if this run is refused, so a consumption that would
        // otherwise wait forever on a swallowed rejection ends as a refusal.
        refused: () => run.blockedSignal(),
      });
    } catch (err) {
      run.closed = true;
      // The engine threw before it ever emitted a hook, so no PostModelCall
      // and no SessionEnd is coming. The llm_call opened by the pre-screen
      // above is still open — close it here or it sits on Core forever as a
      // "started, never completed" row. (Seen for real: a malformed tool
      // schema throws out of callModel synchronously.)
      if (run.llmActivityId != null) {
        await closeLlmActivity(run, null, err).catch(() => undefined);
      }
      await mw
        .afterAgent(turn, state, err instanceof Error ? err : new Error(String(err)))
        .catch(() => undefined);
      throw err;
    } finally {
      // Trim runs that finished, so `openRuns` doesn't grow across a long-
      // lived process. The active run stays until its SessionEnd fires.
      for (let i = openRuns.length - 1; i >= 0; i--) {
        if (openRuns[i].closed) openRuns.splice(i, 1);
      }
    }
  }

  async function close(): Promise<void> {
    // Backstop for a run that was never consumed (so no SessionEnd ever fired)
    // or was abandoned mid-read. A run that already finalized is skipped —
    // except a refused one, whose finalization was started but not awaited so
    // the refusal could reach the caller first. Skipping it there is what left
    // the session `pending` while the terminal printed the right reason.
    for (const run of openRuns) {
      if (run.pendingFinalize != null) {
        await run.pendingFinalize;
        continue;
      }
      if (run.closed) continue;
      await finalizeRun(run, new Error('Governance closed before the run finished'));
    }
    openRuns.length = 0;
  }

  return {
    middleware: mw,
    tools,
    callModel: governedCallModel,
    close,
    routingSummaries: () => collectedRoutingSummaries,
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function isAsyncGeneratorFunction(fn: unknown): boolean {
  return (
    typeof fn === 'function' &&
    (fn as { constructor?: { name?: string } }).constructor?.name === 'AsyncGeneratorFunction'
  );
}

/**
 * `callModel`'s `input` is either a bare string prompt or an array of
 * OpenResponses items. Normalize to the message array shape the ported
 * governance helpers expect (`{role, content}`), so a string prompt is
 * governed exactly like a single user turn rather than being skipped.
 */
function normalizeInput(input: unknown): unknown[] {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (Array.isArray(input)) return input.map((item) => item);
  return [];
}

/**
 * Rebuild `input` in its original shape from the (possibly redacted) message
 * array. A string prompt stays a string; an item array stays an array.
 */
function denormalizeInput(original: unknown, messages: unknown[]): unknown {
  if (typeof original === 'string') {
    const first = messages[0] as Record<string, unknown> | undefined;
    const content = first?.content;
    return typeof content === 'string' ? content : original;
  }
  return messages;
}

/**
 * Session-level routing summary: who served this run, where, and at what cost.
 *
 * The per-call records are already spans; this is the one-line answer a
 * reviewer wants first — and, because it rides the closing event, it is
 * attested with the rest of the session.
 */
function routingSummary(records: RoutingProvenance[]): Record<string, unknown> | undefined {
  if (records.length === 0) return undefined;
  const providers = [...new Set(records.map((r) => r.provider).filter((p): p is string => p != null))];
  const regions = [...new Set(records.map((r) => r.dataRegion).filter((d): d is string => d != null))];
  const costs = records.map((r) => r.totalCost).filter((c): c is number => c != null);
  const checked = records.filter((r) => r.honored != null);
  // The constraint that was actually in force — which is not necessarily the
  // one the caller wrote, since the routing step may have narrowed it. A
  // summary that reported only "honored: true" would leave the reader unable to
  // tell what was honored.
  const requested = [
    ...new Set(records.flatMap((r) => r.requested?.only ?? [])),
  ];
  const fallbacks = records.reduce((n, r) => n + r.attempts.length, 0);
  // "Did I get the model I paid for?" — the models actually run, and whether
  // every checkable call ran the one it asked for.
  const modelsServed = [
    ...new Set(records.map((r) => r.model).filter((m): m is string => m != null)),
  ];
  const modelChecked = records.filter((r) => r.modelHonored != null);
  const substituted = [
    ...new Set(
      modelChecked
        .filter((r) => r.modelHonored === false)
        .map((r) => `${r.requestedModel} → ${r.model}`),
    ),
  ];

  return {
    model_calls: records.length,
    upstream_providers: providers,
    data_regions: regions,
    ...(costs.length > 0 ? { total_cost: costs.reduce((a, b) => a + b, 0) } : {}),
    ...(requested.length > 0 ? { routing_requested_only: requested } : {}),
    ...(checked.length > 0 ? { routing_honored: checked.every((r) => r.honored === true) } : {}),
    ...(fallbacks > 0 ? { fallback_attempts: fallbacks } : {}),
    ...(modelsServed.length > 0 ? { models_served: modelsServed } : {}),
    ...(modelChecked.length > 0
      ? { model_honored: modelChecked.every((r) => r.modelHonored === true) }
      : {}),
    ...(substituted.length > 0 ? { model_substitutions: substituted } : {}),
    generation_ids: records.map((r) => r.generationId),
  };
}

/** The governed prompt: the last user turn's text. */
/**
 * Caps on the reconstructed conversation (see `RunState.transcript`).
 *
 * A transcript is governance evidence, not a payload to replay, and it is
 * posted to Core on every turn — an agent looping over a large tool output
 * would otherwise grow each turn's event without bound. Entries are truncated
 * individually and the oldest are dropped, except the user prompt, which is
 * the one message a reviewer always needs to see.
 */
const MAX_TRANSCRIPT_ENTRY_CHARS = 4_000;
const MAX_TRANSCRIPT_ENTRIES = 100;
const MAX_TRANSCRIPT_PROMPT_CHARS = 16_000;

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}… [truncated ${text.length - limit} chars]`;
}

/** Append a message to the reconstructed conversation, within the caps. */
function recordTranscript(
  run: RunState,
  role: string,
  content: string,
  name?: string,
): void {
  if (content === '') return;
  run.transcript.push({
    role,
    ...(name != null ? { name } : {}),
    content: truncate(content, MAX_TRANSCRIPT_ENTRY_CHARS),
  });
  // Drop from index 1 so the original prompt survives the trim.
  while (run.transcript.length > MAX_TRANSCRIPT_ENTRIES) run.transcript.splice(1, 1);
}

/** Record a tool result on the transcript, whichever path governed the tool. */
function recordToolResult(run: RunState, toolName: string, output: unknown): void {
  const text = typeof output === 'string' ? output : safeSerializeText(output);
  recordTranscript(run, 'tool', text, toolName);
}

function safeSerializeText(value: unknown): string {
  if (value == null) return '';
  try {
    return JSON.stringify(safeSerialize(value)) ?? '';
  } catch {
    return String(value);
  }
}

/**
 * Render the conversation as the `prompt` string Core's guardrails scan.
 * Truncated from the FRONT: the most recent turn is what the model is
 * responding to, so it is the half worth keeping.
 */
function renderTranscript(transcript: ReadonlyArray<{ role: string; name?: string; content: string }>): string {
  const text = transcript
    .map((m) => `${m.role}${m.name != null ? `(${m.name})` : ''}: ${m.content}`)
    .join('\n');
  if (text.length <= MAX_TRANSCRIPT_PROMPT_CHARS) return text;
  return `… [truncated ${text.length - MAX_TRANSCRIPT_PROMPT_CHARS} chars]\n${text.slice(-MAX_TRANSCRIPT_PROMPT_CHARS)}`;
}

function extractPromptText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown> | null;
    if (msg == null || typeof msg !== 'object') continue;
    const role = msg.role ?? msg.type;
    if (role !== 'user' && role !== 'human') continue;
    const content = msg.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const text = content
        .filter(
          (p): p is Record<string, unknown> =>
            typeof p === 'object' &&
            p !== null &&
            typeof (p as Record<string, unknown>).text === 'string',
        )
        .map((p) => String(p.text));
      if (text.length > 0) return text.join('\n');
    }
  }
  return '';
}

/**
 * Merge OpenBox's hook entries with whatever the caller already passed.
 *
 * Inline configs merge cleanly — both sides' handlers run for each hook, ours
 * last so a caller's mutation is what OpenBox governs. A caller-supplied
 * `HooksManager` cannot be merged into an inline config (its registry is not
 * enumerable), so its handlers are registered onto it directly and it is
 * returned as-is.
 */
function mergeHooks(
  existing: InlineHookConfig | HooksManager | undefined,
  ours: InlineHookConfig,
): InlineHookConfig | HooksManager {
  if (existing == null) return ours;

  if (typeof (existing as HooksManager).on === 'function') {
    const manager = existing as HooksManager;
    for (const [hookName, entries] of Object.entries(ours)) {
      for (const entry of entries ?? []) {
        // Cast: `on()` is typed per hook name and this loop is generic over
        // all of them. The entries come from `buildHooks`, which is typed
        // against the same payload/result types, so this is sound.
        (manager.on as unknown as (n: string, e: unknown) => void)(hookName, entry);
      }
    }
    return manager;
  }

  const merged: Record<string, unknown[]> = {};
  for (const [hookName, entries] of Object.entries(existing as InlineHookConfig)) {
    merged[hookName] = [...(entries ?? [])];
  }
  for (const [hookName, entries] of Object.entries(ours)) {
    merged[hookName] = [...(merged[hookName] ?? []), ...(entries ?? [])];
  }
  return merged as InlineHookConfig;
}

/**
 * Tracks a consumption of the ModelResult: when it started, when it finished,
 * and the final text it produced.
 */
interface ConsumptionTracker {
  begin(): void;
  end(finalText: string | null): Promise<void>;
  /**
   * The halt that ended the run, if any. Checked when a consumption settles
   * and on every pull of a stream, because a halt raised mid-run reaches the
   * SDK while `getText()` is still pending — the engine having logged it and
   * carried on to produce an answer the caller must never receive.
   */
  halted(): Error | null;
  /**
   * Resolves only if the run is refused mid-call.
   *
   * `halted()` covers a verdict that arrives before the engine settles. This
   * covers the case where the engine NEVER settles: a span-level block rejects
   * the patched fetch, the engine swallows that rejection, and the promise the
   * caller awaits would hang forever. Measured: a blocked model call exited 0
   * with no answer, no error and the session left `pending`. Raced against the
   * engine so the refusal wins over the silence.
   */
  refused?(): Promise<Error>;
}

/**
 * `callModel` returns a lazy `ModelResult`: it performs no network I/O until
 * something consumes it (`getText()`, `getTextStream()`, …). That consumption
 * happens in the CALLER's async context, outside the activity scope the
 * wrapper established — so without this, every request to OpenRouter escapes
 * instrumentation and no http_request span is ever recorded.
 *
 * The result is proxied so each method call re-enters the scope, and so the
 * wrapper learns when the caller actually has the final answer (which is what
 * lets WorkflowCompleted carry it — see `finalizeRun`). Only methods are
 * wrapped; property reads pass through untouched.
 */
function scopeResultConsumption<T, R>(
  result: T,
  scope: () => string | undefined,
  runScope: AsyncLocalStorage<R>,
  run: R,
  track: ConsumptionTracker,
): T {
  if (result == null || typeof result !== 'object') return result;

  return new Proxy(result as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;

      return function scoped(this: unknown, ...args: unknown[]) {
        // No halt check on entry: this wrapper stands in for methods that
        // return a promise (getText) AND for ones that return an async
        // iterable (getTextStream), so throwing synchronously here would make
        // `getText()` blow up at the call site instead of rejecting, and would
        // hand `for await` a thrown error where it expects an iterable. The
        // checks below run when the call settles or on the next pull, which
        // covers a consumption started after the halt as well — the engine
        // cannot reach the provider from an aborted scope in the meantime.
        track.begin();
        let settled = false;
        // Guards the case where the method is neither a promise nor an
        // iterable (a plain getter-ish call): the consumption must still be
        // released, or the run would never finalize.
        const release = (text: string | null): Promise<void> => {
          if (settled) return Promise.resolve();
          settled = true;
          return track.end(text);
        };

        let out: unknown;
        try {
          out = runScope.run(run, () =>
            runInScopeSync(scope, () =>
              (value as (...a: unknown[]) => unknown).apply(
                this === receiver ? target : this,
                args,
              ),
            ),
          );
        } catch (err) {
          void release(null);
          throw err;
        }

        if (isThenable(out)) {
          const refusal = track.refused?.();
          const settlingFirst =
            refusal != null
              ? Promise.race([
                  out as Promise<unknown>,
                  refusal.then((err) => {
                    throw err;
                  }),
                ])
              : (out as Promise<unknown>);
          return settlingFirst.then(
            async (v) => {
              // The engine can resolve normally after a halt it swallowed, so
              // the verdict has to win here rather than the model's answer.
              const halt = track.halted();
              if (halt != null) {
                await release(null);
                throw halt;
              }
              await release(typeof v === 'string' ? v : null);
              return v;
            },
            async (err) => {
              await release(null);
              throw err;
            },
          );
        }

        if (isAsyncIterable(out)) {
          return scopeAsyncIterable(out, scope, release, (fn2) => runScope.run(run, fn2), track.halted);
        }

        void release(null);
        return out;
      };
    },
  }) as T;
}

function isThenable(value: unknown): boolean {
  return (
    value != null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function isAsyncIterable(value: unknown): boolean {
  return (
    value != null &&
    typeof value === 'object' &&
    typeof (value as Record<PropertyKey, unknown>)[Symbol.asyncIterator] === 'function'
  );
}

/**
 * Re-enter the activity scope for each pull of an async iterable, and release
 * the consumption when iteration ends.
 *
 * Scoping the CALL that produces the iterable is not enough: an async
 * generator's body runs on `next()`, resuming in whatever context the consumer
 * is in — not the one it was created in. So for `getTextStream()` and friends
 * the model request fires outside the scope and no http_request span is ever
 * recorded, even though the identical run consumed via `getText()` records
 * them fine. (Observed exactly that against real Core: 6 spans non-streaming,
 * 0 streaming.)
 */
function scopeAsyncIterable(
  value: unknown,
  scope: () => string | undefined,
  release: (finalText: string | null) => Promise<void>,
  inRunScope: <V>(fn: () => V) => V,
  halted: () => Error | null,
): unknown {
  const iterable = value as AsyncIterable<unknown> & Record<PropertyKey, unknown>;
  const factory = iterable[Symbol.asyncIterator] as () => AsyncIterator<unknown>;

  return new Proxy(iterable, {
    get(target, prop, receiver) {
      if (prop !== Symbol.asyncIterator) return Reflect.get(target, prop, receiver);

      return function scopedIterator() {
        const inner = factory.call(target);
        // String chunks are accumulated so a streamed run still reports the
        // answer it produced; a non-string stream just reports nothing.
        let text = '';
        let sawText = false;

        const finish = () => release(sawText ? text : null);

        // Only the three iterator-protocol methods are wrapped, and each is
        // forwarded only when the underlying iterator actually has it — a
        // bare `next`-only iterator must not gain a `return`/`throw` it never
        // had, or `for await`'s early-exit cleanup would call into nothing.
        const scoped: AsyncIterator<unknown> = {
          next: async (...args) => {
            let step: IteratorResult<unknown>;
            try {
              step = await inRunScope(() =>
                runInScopeSync(scope, () => inner.next(...(args as []))),
              );
            } catch (err) {
              await finish();
              throw err;
            }
            // Checked on every pull, so a halt raised mid-stream stops the
            // stream at the next chunk rather than at the end of it.
            const halt = halted();
            if (halt != null) {
              await finish();
              throw halt;
            }
            if (step.done) {
              await finish();
            } else if (typeof step.value === 'string') {
              sawText = true;
              text += step.value;
            }
            return step;
          },
        };
        if (typeof inner.return === 'function') {
          scoped.return = async (...args) => {
            // Early exit from `for await` — the caller has what it wants, so
            // whatever was streamed so far IS the final text.
            await finish();
            return inRunScope(() => runInScopeSync(scope, () => inner.return!(...(args as []))));
          };
        }
        if (typeof inner.throw === 'function') {
          scoped.throw = async (...args) => {
            await finish();
            return inRunScope(() => runInScopeSync(scope, () => inner.throw!(...(args as []))));
          };
        }
        return scoped;
      };
    },
  });
}
