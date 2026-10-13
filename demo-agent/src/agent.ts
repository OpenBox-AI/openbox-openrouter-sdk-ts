/**
 * Demo: a customer-support agent built on `@openrouter/agent`, governed by
 * OpenBox through `@openbox-ai/openbox-openrouter-governance`, installed from
 * npm like any consumer would, so this exercises the published package surface
 * — not the SDK's internals.
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
import { createOpenBoxGovernance } from '@openbox-ai/openbox-openrouter-governance';

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
      // Routing constraint, when asked for. `callModel` spreads any field it
      // does not itself consume straight into the request body, so this
      // reaches OpenRouter as-is — and the SDK reads it back off the same
      // body to decide `openbox.routing.honored`.
      ...routingConstraint(),
      ...modelFallbacks(),
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

    // Print what the provenance actually said. The evidence is the product, so
    // a run that hides it is a worse demo than one that prints nothing.
    for (const summary of openbox.routingSummaries()) {
      const honored = summary.routing_honored;
      const verdict =
        honored === undefined
          ? 'unconstrained (no allowlist requested)'
          : honored
            ? 'HONORED'
            : 'DISHONORED';
      log(
        'provenance',
        `${summary.model_calls} call(s) · served by ${
          (summary.upstream_providers as string[])?.join(', ') || 'unknown'
        } · region ${
          (summary.data_regions as string[])?.join(', ') || 'unknown'
        } · $${Number(summary.total_cost ?? 0).toFixed(5)} · ${verdict}`,
      );
      // The second promise, from the same record: did the model that ran match
      // the model that was asked for?
      const modelHonored = summary.model_honored;
      const modelVerdict =
        modelHonored === undefined
          ? 'unchecked (no concrete model requested)'
          : modelHonored
            ? 'AS REQUESTED'
            : `SUBSTITUTED (${(summary.model_substitutions as string[])?.join('; ')})`;
      log(
        'provenance',
        `model ${model()} · ran ${
          (summary.models_served as string[])?.join(', ') || 'unknown'
        } · ${modelVerdict}`,
      );
      log('provenance', `verify at source: ${(summary.generation_ids as string[])?.join(', ')}`);
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function model(): string {
  return process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini';
}

/**
 * Optional `provider.only` allowlist, from `OPENROUTER_PROVIDER_ONLY`
 * (comma-separated, e.g. `openai` or `openai,azure`).
 *
 * This is what makes a call *checkable*. Without it the provenance record still
 * says who served the prompt, but nothing was promised, so
 * `openbox.routing.honored` is null and the call is "unconstrained" rather than
 * a pass. Set it to see the honored path end to end.
 *
 * `OPENROUTER_ALLOW_FALLBACKS=false` additionally makes the request fail closed
 * rather than falling out of the allowlist when the provider is down.
 */
function routingConstraint(): Record<string, unknown> {
  const only = (process.env.OPENROUTER_PROVIDER_ONLY ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (only.length === 0) return {};

  const provider: Record<string, unknown> = { only };
  if (process.env.OPENROUTER_ALLOW_FALLBACKS === 'false') {
    provider.allow_fallbacks = false;
  }
  log('routing', `provider.only=${only.join(',')}`);
  return { provider };
}

/**
 * Optional model fallback chain, from `OPENROUTER_MODELS` (comma-separated).
 *
 * OpenRouter serves the first model in the chain that can take the request, so
 * the model that answers is not necessarily the one named in `model`. Declaring
 * the chain is what makes that acceptable rather than a substitution: the SDK
 * counts a model the caller listed here as honored, and anything else as a
 * model nobody asked for.
 */
function modelFallbacks(): Record<string, unknown> {
  const models = (process.env.OPENROUTER_MODELS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (models.length === 0) return {};
  log('routing', `models=${models.join(',')}`);
  return { models };
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
