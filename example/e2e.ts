/**
 * End-to-end: real @openrouter/agent engine, real model call, real OpenBox
 * Core. Logs every governance event that goes on the wire so the run can be
 * checked against the dashboard.
 *
 *   npx tsx example/e2e.ts
 */

import { OpenRouter, callModel, tool } from '@openrouter/agent';
import { z } from 'zod';

import { createOpenBoxGovernance } from '../src/index';
import { FetchTransport, resolveCredentials } from '../src/transport';
import type { OpenBoxRequestOptions, OpenBoxTransport } from '../src/transport';

/** Wraps the real transport so every request/verdict is printed. */
class LoggingTransport implements OpenBoxTransport {
  constructor(private readonly inner: OpenBoxTransport) {}

  async request<T>(options: OpenBoxRequestOptions): Promise<T> {
    const body = (options.body ?? {}) as Record<string, unknown>;
    const name =
      (body.metadata as Record<string, unknown> | undefined)?.sdk_event_type ??
      body.event_type ??
      options.path;
    const tag = body.hook_trigger === true ? 'span ' : 'event';
    try {
      const res = (await this.inner.request<T>(options)) as Record<string, unknown> | undefined;
      const arm = res?.arm ?? res?.verdict ?? '-';
      console.log(
        `  ${tag} ${String(name).padEnd(20)} activity=${String(body.activity_type ?? '-').padEnd(12)} → ${arm}`,
      );
      return res as T;
    } catch (err) {
      console.log(`  ${tag} ${String(name).padEnd(20)} → ERROR ${(err as Error).message}`);
      throw err;
    }
  }
}

async function main() {
  const credentials = resolveCredentials();
  console.log(`Core: ${credentials.openboxUrl}  signed=${Boolean(credentials.agentDid)}\n`);

  const openbox = createOpenBoxGovernance({
    agentName: 'openrouter-e2e',
    transport: new LoggingTransport(new FetchTransport(credentials)),
    // Surface any Core-side failure instead of silently running ungoverned —
    // the whole point of the exercise.
    onApiError: 'fail_closed',
    hitl: { pollIntervalMs: 2000, timeoutMs: 60_000 },
  });

  const lookupOrder = tool({
    name: 'lookup_order',
    description: 'Look up an order by its id',
    inputSchema: z.object({ orderId: z.string() }),
    execute: async ({ orderId }: { orderId: string }) => {
      console.log(`  [tool] lookup_order(${orderId})`);
      return { orderId, status: 'shipped', total: 42.5, carrier: 'DHL' };
    },
  });

  const client = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY! });

  const result = await openbox.callModel(callModel, client, {
    model: process.env.OPENROUTER_MODEL ?? 'anthropic/claude-3.5-haiku',
    input: 'What is the status of order A-1001? Use the lookup_order tool.',
    tools: openbox.tools([lookupOrder]),
  });

  const text = await result.getText();
  console.log(`\n[model] ${text}\n`);

  await openbox.close();
}

main().catch((err) => {
  console.error('\nFAILED:', err);
  process.exitCode = 1;
});
