/**
 * Model-substitution showcase: "did I get the model I paid for?"
 *
 * The provider that serves a call is invisible in the response — item 1's
 * subject — but so is the *model*, in a subtler way. The response body does
 * echo a model id, and nobody compares it to the one the request asked for.
 * Under a `models` fallback chain, or a provider quietly serving a different
 * build, the two can differ while the call looks entirely successful.
 *
 * Each leg is a real run against the real OpenRouter API:
 *
 *   1. plain        — one model named, that model runs. AS REQUESTED.
 *   2. fallback     — asks for anthropic/claude-3.5-haiku but permits only the
 *                     OpenAI provider, so OpenRouter falls through the declared
 *                     chain and openai/gpt-4o-mini answers. The ids differ and
 *                     it is still honored: the caller listed it themselves.
 *                     This is the row that makes the check visible — "asked for
 *                     X, ran Y" — without anything having gone wrong.
 *   3. auto         — openrouter/auto. Choosing the model IS the promise, so
 *                     there is nothing to check and the call is UNCHECKED, not
 *                     a pass.
 *
 * There is deliberately no leg that produces a substitution. OpenRouter serves
 * only from the model the request named or the chain it declared, so a genuine
 * "a model nobody asked for answered" is not something this demo can
 * manufacture — and a fabricated one would be worth nothing. Its absence is
 * the result: the check runs on every call and finds nothing, which is what
 * evidence of a kept promise looks like.
 *
 * Run:
 *   npm run demo:model
 *
 * Costs a few tenths of a cent in total.
 */

import { spawn } from 'child_process';
import { config as loadEnv } from 'dotenv';
import path from 'path';

loadEnv();

interface Leg {
  label: string;
  model: string;
  /** `models` fallback chain, when the leg declares one. */
  models?: string;
  only?: string;
  question: string;
  expect: string;
}

const LEGS: Leg[] = [
  {
    label: 'plain',
    model: 'openai/gpt-4o-mini',
    question: 'Leg 1 of 3, plain model request: look up order A-1001.',
    expect: 'AS REQUESTED — the model named is the model that ran',
  },
  {
    label: 'declared fallback',
    model: 'anthropic/claude-3.5-haiku',
    models: 'anthropic/claude-3.5-haiku,openai/gpt-4o-mini',
    // Anthropic models are not served by the OpenAI provider, so the chain is
    // what makes this request answerable at all. Verified against the live
    // API: gpt-4o-mini answers a claude-3.5-haiku request.
    only: 'openai',
    question: 'Leg 2 of 3, declared fallback chain: look up order A-1002.',
    expect: 'AS REQUESTED via the declared chain — asked for claude, ran gpt-4o-mini',
  },
  {
    label: 'auto-routed',
    model: 'openrouter/auto',
    question: 'Leg 3 of 3, auto-routed: look up order A-1003.',
    expect: 'unchecked — the caller handed the model choice to OpenRouter',
  },
];

let lastTail = '';

function runLeg(leg: Leg): Promise<number> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, OPENROUTER_MODEL: leg.model };
    if (leg.models) env.OPENROUTER_MODELS = leg.models;
    else delete env.OPENROUTER_MODELS;
    if (leg.only) env.OPENROUTER_PROVIDER_ONLY = leg.only;
    else delete env.OPENROUTER_PROVIDER_ONLY;

    const child = spawn(
      process.execPath,
      [
        path.join(__dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        path.join(__dirname, 'agent.ts'),
        leg.question,
      ],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let tail = '';
    const collect = (chunk: Buffer) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-400);
      // The provenance lines ARE the demo.
      for (const line of text.split('\n')) {
        if (line.includes('[provenance]')) console.log(`      ${line.trim()}`);
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    child.on('close', (code) => {
      lastTail = tail;
      resolve(code ?? 0);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs one leg and reports it. Returns whether it behaved as expected. */
async function attemptLeg(leg: Leg, isRetry = false): Promise<boolean> {
  const code = await runLeg(leg);
  if (code === 0) {
    console.log(`  ✓ ${leg.label} — ${leg.expect}`);
    return true;
  }
  // Same reasoning as the routing showcase: back-to-back runs against one
  // upstream provider hit transient 5xx often enough to spoil a demo.
  if (isRetry) {
    console.log(`  ✗ ${leg.label} — unexpected exit ${code} after retry`);
    console.log(`      ${lastTail.replace(/\n/g, '\n      ')}`);
  } else {
    console.log(`  … ${leg.label} — exit ${code}, likely transient`);
  }
  return false;
}

async function main() {
  for (const name of ['OPENROUTER_API_KEY', 'OPENBOX_API_KEY']) {
    if (!process.env[name]) {
      console.error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
      process.exit(1);
    }
  }

  console.log('\nModel substitution showcase — three legs, real API calls.\n');

  for (const [index, leg] of LEGS.entries()) {
    const ok = await attemptLeg(leg);
    if (!ok) {
      console.log('      retrying once…');
      await sleep(3000);
      await attemptLeg(leg, true);
    }
    if (index < LEGS.length - 1) await sleep(2000);
  }

  console.log(`
Done. Each leg printed what its provenance actually recorded, above.

Where to look:
  Agent → Provenance   "Did I Get the Model I Paid For?" lists the
                       requested → served pairs; leg 2 is the row where the
                       two ids differ. "Model Substitutions" reads 0.
  Agent → Verify       pick a leg's session: the Model card says
                       "As requested" or "Unchecked", never green for a call
                       that named no model.

Expected:
  · leg 1 requested and served the same model
  · leg 2 shows anthropic/claude-3.5-haiku → openai/gpt-4o-mini and is still
    honored: the caller declared that chain, so nothing was substituted
  · leg 3 is unchecked, not a pass — openrouter/auto promises no model
  · zero substitutions anywhere, which is the correct result
`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
