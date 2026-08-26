/**
 * Governance configuration.
 *
 * Ported from the n8n node's `shared/langchain/config.ts`. Same fields, same
 * defaults, with three deliberate changes for this runtime:
 *   - `taskQueue` defaults to "openrouter" (n8n: "n8n", Python: "langchain")
 *   - credentials are carried here, since there is no n8n credential store
 *   - `instrumentHttp` stays on: it is what makes the model call to
 *     OpenRouter itself visible as an http_request span, and it is the ONLY
 *     pre-response enforcement point for a model call (the OpenRouter Agent
 *     SDK exposes no pre-model hook — see openrouter.ts).
 */

import type { OpenBoxCredentials, OpenBoxTransport } from './transport';

export type DatabaseDriverName = 'pg' | 'mysql2' | 'mongodb' | 'redis' | 'ioredis';

export const ALL_DATABASE_DRIVERS: DatabaseDriverName[] = [
  'pg',
  'mysql2',
  'mongodb',
  'redis',
  'ioredis',
];

export interface Logger {
  warn(message: string, meta?: unknown): void;
}

const consoleLogger: Logger = {
  warn(message: string, meta?: unknown) {
    if (meta !== undefined) console.warn(`[openbox] ${message}`, meta);
    else console.warn(`[openbox] ${message}`);
  },
};

export interface OpenBoxOpenRouterOptions extends Partial<OpenBoxCredentials> {
  /** Displayed as workflow_type in governance events. */
  agentName?: string;
  sessionId?: string;
  /** task_queue field on all events. Defaults to "openrouter". */
  taskQueue?: string;
  onApiError?: 'fail_open' | 'fail_closed';
  /** Governance HTTP request timeout, in seconds. */
  governanceTimeout?: number;
  /** Maps tool name → tool_type tag sent on ToolStarted/ToolCompleted. */
  toolTypeMap?: Record<string, string>;
  /** Tool names whose governance events are suppressed entirely. */
  skipToolTypes?: Set<string>;
  sendChainStartEvent?: boolean;
  sendChainEndEvent?: boolean;
  sendLlmStartEvent?: boolean;
  sendLlmEndEvent?: boolean;
  sendToolStartEvent?: boolean;
  sendToolEndEvent?: boolean;
  hitl?: Partial<HITLConfig>;
  instrumentHttp?: boolean;
  /**
   * Capture request bodies for clients that call `fetch(new Request(...))`.
   *
   * Off by default: reading such a body requires cloning the caller's Request,
   * which leaves it in a state their retry logic cannot reuse — the OpenRouter
   * SDK crashed on roughly a quarter of runs with this on. Response bodies
   * (which is where Core reads tokens and the model id) are unaffected.
   */
  captureRequestObjectBody?: boolean;
  /**
   * How many span evaluations may be in flight at once for one activity
   * (default 4).
   *
   * Every span costs a ~1s round-trip to Core, which starts a Temporal
   * workflow and waits for it, so a tool doing several operations pays that
   * repeatedly. Spans of one operation stay ordered regardless; this only
   * governs how many DIFFERENT operations' spans travel at once. Raise it for
   * a chatty tool against a Core with headroom, lower it to 1 to restore the
   * old strictly-serial behaviour.
   */
  spanConcurrency?: number;
  instrumentFileIo?: boolean;
  /** Back-compat boolean — true enables all drivers in ALL_DATABASE_DRIVERS. */
  instrumentDatabases?: boolean;
  /** Per-driver instrumentation allowlist. Takes precedence over instrumentDatabases. */
  databases?: Set<DatabaseDriverName>;
  logger?: Logger;
  /** Supply your own HTTP stack instead of the built-in fetch transport. */
  transport?: OpenBoxTransport;
}

export interface HITLConfig {
  enabled: boolean;
  pollIntervalMs: number;
  /** null = poll indefinitely (matches the SDK's explicit opt-out). */
  timeoutMs: number | null;
}

export interface GovernanceConfig {
  taskQueue: string;
  onApiError: 'fail_open' | 'fail_closed';
  governanceTimeout: number;
  toolTypeMap: Record<string, string>;
  skipToolTypes: Set<string>;
  sessionId?: string;
  agentName?: string;
  sendChainStartEvent: boolean;
  sendChainEndEvent: boolean;
  sendLlmStartEvent: boolean;
  sendLlmEndEvent: boolean;
  sendToolStartEvent: boolean;
  sendToolEndEvent: boolean;
  hitl: HITLConfig;
  instrumentHttp: boolean;
  captureRequestObjectBody: boolean;
  spanConcurrency: number;
  instrumentFileIo: boolean;
  instrumentDatabases: boolean;
  databases: Set<DatabaseDriverName>;
  logger: Logger;
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Default HITL max wait — 1 hour, comfortably above the typical server-side
 * approval expiry (~30 min).
 */
export const DEFAULT_APPROVAL_MAX_WAIT_MS = 60 * 60 * 1000;

/** merge_config() — mirrors openbox_langgraph.config.merge_config */
export function mergeConfig(opts: OpenBoxOpenRouterOptions): GovernanceConfig {
  const databases =
    opts.databases ??
    new Set<DatabaseDriverName>((opts.instrumentDatabases ?? true) ? ALL_DATABASE_DRIVERS : []);

  return {
    taskQueue: opts.taskQueue ?? 'openrouter',
    onApiError: opts.onApiError ?? 'fail_open',
    governanceTimeout: opts.governanceTimeout ?? 30.0,
    toolTypeMap: opts.toolTypeMap ?? {},
    skipToolTypes: opts.skipToolTypes ?? new Set(),
    sessionId: opts.sessionId,
    agentName: opts.agentName,
    sendChainStartEvent: opts.sendChainStartEvent ?? true,
    sendChainEndEvent: opts.sendChainEndEvent ?? true,
    sendLlmStartEvent: opts.sendLlmStartEvent ?? true,
    sendLlmEndEvent: opts.sendLlmEndEvent ?? true,
    sendToolStartEvent: opts.sendToolStartEvent ?? true,
    sendToolEndEvent: opts.sendToolEndEvent ?? true,
    hitl: {
      enabled: opts.hitl?.enabled ?? true,
      pollIntervalMs:
        opts.hitl?.pollIntervalMs ?? envNumber('OPENBOX_HITL_POLL_INTERVAL_MS') ?? 5000,
      timeoutMs:
        opts.hitl?.timeoutMs !== undefined
          ? opts.hitl.timeoutMs
          : envNumber('OPENBOX_HITL_TIMEOUT_MS') ?? DEFAULT_APPROVAL_MAX_WAIT_MS,
    },
    // HTTP instrumentation is always on (mirrors the Python SDK wiring httpx
    // by default). File IO is off — file reads are almost always
    // credential/config, not user data worth governing.
    instrumentHttp: opts.instrumentHttp ?? true,
    captureRequestObjectBody: opts.captureRequestObjectBody ?? false,
    spanConcurrency:
      opts.spanConcurrency ?? envNumber('OPENBOX_SPAN_CONCURRENCY') ?? 4,
    instrumentFileIo: opts.instrumentFileIo ?? false,
    instrumentDatabases: opts.instrumentDatabases ?? true,
    databases,
    logger: opts.logger ?? consoleLogger,
  };
}
