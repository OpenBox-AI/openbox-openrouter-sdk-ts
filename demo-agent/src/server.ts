/**
 * A local web UI for the governed agent.
 *
 * The page drives the SAME agent the CLI does (`tools.ts`), server-side —
 * the OpenRouter and OpenBox keys never reach the browser. What it adds is
 * visibility: every governance decision Core makes is streamed to the page as
 * it happens, so a block, a halt or a held approval is something you watch
 * rather than something you reconstruct from the database afterwards.
 *
 *   npm run ui        →  http://localhost:4545
 */

import { config as loadEnv } from 'dotenv';
loadEnv();

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OpenRouter, callModel } from '@openrouter/agent';
import {
  createOpenBoxGovernance,
  FetchTransport,
  type OpenBoxRequestOptions,
  type OpenBoxTransport,
} from 'openbox-openrouter-governance';
import { Client as PgClient } from 'pg';

import { ALL_TOOLS, INSTRUCTIONS, TOOL_TYPES } from './tools';
import {
  SCENARIOS,
  applyScenario,
  decideApproval,
  findScenario,
  type Scenario,
} from './scenarios';

const PORT = Number(process.env.UI_PORT ?? 4545);
const DASHBOARD = process.env.OPENBOX_DASHBOARD_URL ?? 'http://localhost:3233';

// ── governance → UI ─────────────────────────────────────────────────────────

interface UiEvent {
  type: 'activity' | 'answer' | 'done' | 'error' | 'scenario';
  [key: string]: unknown;
}

/**
 * Wraps the real transport and reports every governance evaluation to the
 * page. Purely observational: the request and the verdict are passed through
 * untouched, so the UI cannot change what governance decides — it only shows
 * it. This is the one seam that makes the SDK's decisions visible without
 * reaching into its internals.
 */
class ObservingTransport implements OpenBoxTransport {
  private workflowId: string | null = null;

  constructor(
    private readonly inner: OpenBoxTransport,
    private readonly emit: (event: UiEvent) => void,
  ) {}

  get seenWorkflowId(): string | null {
    return this.workflowId;
  }

  async request<T = unknown>(options: OpenBoxRequestOptions): Promise<T> {
    const body = (options.body ?? {}) as Record<string, unknown>;
    const isEvent = options.path.endsWith('/evaluate') && body.hook_trigger !== true;

    if (isEvent && typeof body.workflow_id === 'string') this.workflowId = body.workflow_id;

    const startedAt = Date.now();
    try {
      const response = await this.inner.request<T>(options);
      if (isEvent) this.report(body, response as Record<string, unknown>, Date.now() - startedAt);
      return response;
    } catch (err) {
      // A transport failure is governance the agent did NOT get; say so rather
      // than letting the row sit there looking pending.
      if (isEvent) {
        this.emit({
          type: 'activity',
          id: String(body.activity_id ?? ''),
          name: String(body.activity_type ?? 'unknown'),
          stage: String(body.event_type ?? ''),
          verdict: 'unreachable',
          reason: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }
  }

  private report(
    body: Record<string, unknown>,
    response: Record<string, unknown> | null,
    ms: number,
  ): void {
    const eventType = String(body.event_type ?? '');
    // Workflow-level events are the run's own bookkeeping, not an activity.
    if (eventType.startsWith('Workflow') || eventType === 'SignalReceived') return;

    const verdict = String(
      response?.verdict ?? response?.arm ?? response?.action ?? 'allow',
    ).toLowerCase();

    this.emit({
      type: 'activity',
      id: String(body.activity_id ?? ''),
      name: String(body.activity_type ?? 'unknown'),
      stage: eventType.endsWith('Completed') ? 'completed' : 'started',
      verdict,
      reason: (response?.reason as string | undefined) ?? null,
      // The remediation directive, when a policy attaches one to a block.
      patch: (response?.patch as unknown) ?? null,
      durationMs: (body.duration_ms as number | undefined) ?? ms,
      output: preview(body.activity_output),
      governanceMs: ms,
    });
  }
}

function preview(value: unknown): string | null {
  if (value == null) return null;
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
  } catch {
    return null;
  }
}

/**
 * The dashboard link for a finished run. Resolved from the local database
 * because Core's verdict response carries a governance_event_id, not a
 * session id. Best effort: no database, no link, everything else still works.
 */
async function sessionUrl(workflowId: string | null): Promise<string | null> {
  if (workflowId == null) return null;
  const client = new PgClient({
    host: process.env.OPENBOX_DB_HOST ?? 'localhost',
    port: Number(process.env.OPENBOX_DB_PORT ?? 5432),
    user: process.env.OPENBOX_DB_USER ?? 'postgres',
    password: process.env.OPENBOX_DB_PASSWORD ?? 'password',
    database: process.env.OPENBOX_DB_NAME ?? 'openbox',
    connectionTimeoutMillis: 2_000,
  });
  try {
    await client.connect();
    const { rows } = await client.query(
      'SELECT id, agent_id FROM sessions WHERE workflow_id = $1 ORDER BY created_at DESC LIMIT 1',
      [workflowId],
    );
    if (rows.length === 0) return null;
    return `${DASHBOARD}/agents/${rows[0].agent_id}/sessions/${rows[0].id}/replay`;
  } catch {
    return null;
  } finally {
    await client.end().catch(() => undefined);
  }
}

// ── one governed run, streamed ──────────────────────────────────────────────

async function runAgent(
  prompt: string,
  scenario: Scenario,
  emit: (event: UiEvent) => void,
): Promise<void> {
  const credentials = {
    openboxUrl: process.env.OPENBOX_API_URL ?? 'http://localhost:8086',
    apiKey: process.env.OPENBOX_API_KEY ?? '',
    agentDid: process.env.OPENBOX_AGENT_DID,
    agentPrivateKey: process.env.OPENBOX_AGENT_PRIVATE_KEY,
  };
  const transport = new ObservingTransport(new FetchTransport(credentials), emit);

  const openbox = createOpenBoxGovernance({
    agentName: 'support-agent',
    transport,
    onApiError: 'fail_closed',
    toolTypeMap: TOOL_TYPES,
    // Long enough for someone to actually decide on the page; the other arms
    // never reach the poll loop.
    hitl: { enabled: true, pollIntervalMs: 2_000, timeoutMs: 5 * 60_000 },
    logger: { warn: () => undefined },
  });

  const client = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY! });

  try {
    const result = await openbox.callModel(callModel, client, {
      model: process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini',
      instructions: INSTRUCTIONS,
      input: prompt,
      tools: openbox.tools(ALL_TOOLS),
    });

    for await (const delta of result.getTextStream()) {
      emit({ type: 'answer', text: delta });
    }
    emit({ type: 'done', sessionUrl: await sessionUrl(transport.seenWorkflowId) });
  } catch (err) {
    const e = err as Error;
    // A governance block/halt arrives here as GovernanceBlockedError /
    // GovernanceHaltError, carrying the reason Core gave.
    emit({
      type: 'error',
      name: e?.name ?? 'Error',
      message: e?.message ?? String(err),
      sessionUrl: await sessionUrl(transport.seenWorkflowId),
    });
  } finally {
    await openbox.close().catch(() => undefined);
  }
}

// ── server ──────────────────────────────────────────────────────────────────

async function readJson(req: import('node:http').IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const html = await readFile(join(__dirname, '..', 'public', 'index.html'), 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && req.url === '/scenarios') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(SCENARIOS));
    return;
  }

  if (req.method === 'POST' && req.url === '/decide') {
    const body = await readJson(req);
    const outcome = await decideApproval(
      String(body?.activityId ?? ''),
      Boolean(body?.approve),
    );
    res.writeHead(outcome.ok ? 200 : 409, { 'content-type': 'application/json' });
    res.end(JSON.stringify(outcome));
    return;
  }

  if (req.method === 'POST' && req.url === '/run') {
    const body = await readJson(req);
    if (body == null) {
      res.writeHead(400).end('bad request');
      return;
    }
    const prompt = String(body.prompt ?? '');
    const scenario = findScenario(body.scenario as string | undefined);

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const emit = (event: UiEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);

    console.log(`\n  [run] ${scenario.name} — ${JSON.stringify(prompt)}`);

    // Put the policy in the scenario's state before the run, not during it.
    const state = await applyScenario(scenario);
    emit({ type: 'scenario', name: scenario.name, ...state });

    await runAgent(prompt, scenario, emit).catch((err) =>
      emit({ type: 'error', name: 'Error', message: String(err) }),
    );
    res.end();
    return;
  }

  res.writeHead(404).end('not found');
});

server.listen(PORT, () => {
  console.log(`\n  OpenBox × OpenRouter demo UI  →  http://localhost:${PORT}\n`);
});
