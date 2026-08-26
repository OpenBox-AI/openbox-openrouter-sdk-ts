/**
 * Demo: a customer-support agent built on `@openrouter/agent`, governed by
 * OpenBox through `openbox-openrouter-governance` (linked as a local `file:..`
 * dependency, so this exercises the published package surface — not the
 * SDK's internals).
 *
 * Three tools, deliberately different in kind:
 *   - `lookup_order`   plain read, expected to sail through
 *   - `refund_order`   the one worth governing: moves money
 *   - `search_docs`    makes a real outbound HTTP call, so the instrumentation
 *                      has something to capture besides the model call itself
 *
 * Run:
 *   npm run agent                    # default question
 *   npm run agent -- "your question" # your own
 *   npm run agent:stream             # stream the answer as it arrives
 */

import { config as loadEnv } from 'dotenv';
import { OpenRouter, callModel } from '@openrouter/agent';
import { createOpenBoxGovernance } from 'openbox-openrouter-governance';

loadEnv();

import { ALL_TOOLS, INSTRUCTIONS, TOOL_TYPES, log } from './tools';

// ── wiring ──────────────────────────────────────────────────────────────────

async function main() {
  requireEnv(['OPENROUTER_API_KEY', 'OPENBOX_API_KEY']);

  const stream = process.argv.includes('--stream');
  const question =
    process.argv.slice(2).filter((a) => !a.startsWith('--'))[0] ??
    'Order A-1003 arrived damaged. Check it and refund me in full.';

  const openbox = createOpenBoxGovernance({
    agentName: 'support-agent',
    // apiKey / openboxUrl / agentDid / agentPrivateKey are read from
    // OPENBOX_* env vars when not passed explicitly.
    //
    // fail_closed: if OpenBox is unreachable the run stops rather than
    // quietly continuing ungoverned. That is the right default for an agent
    // that can move money; swap to 'fail_open' for a read-only assistant.
    onApiError: 'fail_closed',
    toolTypeMap: TOOL_TYPES,
    hitl: { enabled: true, pollIntervalMs: 3000, timeoutMs: 5 * 60_000 },
  });

  const client = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY! });

  log('run', `model=${model()}  question=${JSON.stringify(question)}`);

  try {
    const result = await openbox.callModel(callModel, client, {
      model: model(),
      instructions: INSTRUCTIONS,
      input: question,
      // The one line that governs every tool: wraps each execute so it is
      // evaluated, optionally held for human approval, and reported.
      tools: openbox.tools(ALL_TOOLS),
    });

    if (stream) {
      process.stdout.write('\n');
      for await (const delta of result.getTextStream()) {
        process.stdout.write(delta);
      }
      process.stdout.write('\n');
    } else {
      const text = await result.getText();
      console.log(`\n${text}\n`);
    }
  } catch (err) {
    // A governance block/halt arrives here as GovernanceBlockedError /
    // GovernanceHaltError, carrying the reason Core gave.
    const e = err as Error;
    if (e?.name === 'GovernanceBlockedError' || e?.name === 'GovernanceHaltError') {
      log('blocked', e.message);
      process.exitCode = 2;
      return;
    }
    throw err;
  } finally {
    // Drains in-flight span telemetry. Always await it.
    await openbox.close();
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function model(): string {
  return process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini';
}

function requireEnv(names: string[]): void {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length > 0) {
    console.error(
      `Missing ${missing.join(', ')}. Copy .env.example to .env and fill it in.`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
