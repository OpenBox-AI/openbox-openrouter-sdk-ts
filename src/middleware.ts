/**
 * OpenBoxOpenRouterMiddleware — the governance lifecycle for one agent.
 *
 * Exposes the same five lifecycle methods (beforeAgent / afterAgent /
 * wrapModelCall / wrapToolCall / wrapMemoryOp) as plain async functions. The
 * OpenRouter Agent SDK has no wrapping-middleware slot of its own, so
 * `openrouter.ts` drives these from its `callModel` wrapper and from the
 * SDK's lifecycle hooks.
 *
 * Turn identity (workflowId/runId) is NEVER stored as mutable state on this
 * instance — beforeAgent() returns a `Turn` value the caller threads through
 * every subsequent call. Identity living on a shared/reused instance is
 * exactly what a concurrent-run refactor would clobber, and unlike a host with one
 * node execution at a time) an OpenRouter agent process routinely has several
 * sessions in flight against one middleware.
 */

import { GovernanceClient } from './client';
import {
  GovernanceConfig,
  OpenBoxOpenRouterOptions,
  mergeConfig,
} from './config';
import { Turn } from './hooks';
import {
  AgentState,
  handleAfterAgent,
  handleBeforeAgent,
  handleWrapMemoryOp,
  handleWrapModelCall,
} from './hook_handlers';
import {
  addIgnoredPrefix,
  setCaptureRequestObjectBody,
  setSpanConcurrency,
  setupSpanProcessorInstrumentation,
} from './span_processor';
import { setupNodeHookInstrumentation } from './node_instrumentation';
import { handleWrapToolCall } from './tool_hook';
import { GovernanceVerdictResponse } from './types';
import {
  DEFAULT_OPENBOX_URL,
  FetchTransport,
  type OpenBoxTransport,
  resolveCredentials,
} from './transport';

export class OpenBoxOpenRouterMiddleware {
  readonly _workflowType: string;

  readonly _config: GovernanceConfig;
  readonly _client: GovernanceClient;
  readonly _transport: OpenBoxTransport;

  constructor(options: OpenBoxOpenRouterOptions = {}) {
    this._config = mergeConfig(options);
    this._workflowType = options.agentName ?? 'OpenRouterRun';

    if (options.transport) {
      this._transport = options.transport;
    } else {
      const credentials = resolveCredentials(options);
      this._transport = new FetchTransport(credentials);
      // The credential's URL may be a self-hosted Core rather than the
      // default, so ignore it explicitly: HTTP calls to Core made while an
      // activity is registered must not be intercepted as hook spans and sent
      // back to Core a second time, creating duplicate approval requests.
      addIgnoredPrefix(credentials.openboxUrl);
    }

    this._client = new GovernanceClient(
      this._transport,
      '',
      this._config.governanceTimeout * 1000,
    );

    addIgnoredPrefix(DEFAULT_OPENBOX_URL);
    setCaptureRequestObjectBody(this._config.captureRequestObjectBody);
    setSpanConcurrency(this._config.spanConcurrency);
    setupSpanProcessorInstrumentation({ http: this._config.instrumentHttp });

    setupNodeHookInstrumentation({
      fileIo: this._config.instrumentFileIo,
      databases: this._config.databases,
      logger: this._config.logger,
    });
  }

  // ── Lifecycle hooks ────────────────────────────────────────────────────────

  /**
   * before_agent() — session setup. Returns the minted turn identity; pass it
   * to every subsequent call.
   */
  async beforeAgent(state: AgentState, threadId?: string): Promise<Turn> {
    return handleBeforeAgent(this, state, threadId);
  }

  /** after_agent() — session close. Returns the WorkflowCompleted verdict. */
  async afterAgent(
    turn: Turn,
    state: AgentState,
    failedWith?: Error,
  ): Promise<GovernanceVerdictResponse | null> {
    return handleAfterAgent(this, turn, state, failedWith);
  }

  /**
   * wrap_model_call() — LLM governance. `messages` is the array handed to the
   * model; `handler` is the thunk that performs the actual call.
   */
  async wrapModelCall(
    turn: Turn,
    messages: unknown[],
    handler: () => Promise<unknown>,
  ): Promise<unknown> {
    return handleWrapModelCall(this, turn, messages, handler);
  }

  /** wrap_tool_call() — tool governance. */
  async wrapToolCall(
    turn: Turn,
    toolName: string,
    toolArgs: unknown,
    handler: () => Promise<unknown>,
  ): Promise<unknown> {
    return handleWrapToolCall(this, turn, toolName, toolArgs, handler);
  }

  /**
   * wrap_memory_op() — scope a memory load/save inside a short-lived activity
   * so database queries inside it generate db_query spans on the dashboard.
   */
  async wrapMemoryOp<T>(
    turn: Turn,
    opType: 'load_memory' | 'save_context',
    fn: () => Promise<T>,
  ): Promise<T> {
    return handleWrapMemoryOp(this, turn, opType, fn);
  }
}
