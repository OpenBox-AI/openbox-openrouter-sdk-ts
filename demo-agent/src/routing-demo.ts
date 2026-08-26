/**
 * Routing-integrity showcase: generates the traffic the Routing Integrity
 * panel exists to display, then tells you where to look at it.
 *
 * Each leg is a real run against the real OpenRouter API, because the whole
 * point of the feature is that the evidence is not synthetic:
 *
 *   1. unconstrained  — no allowlist. Provenance is recorded, but nothing was
 *                       promised, so the call is neither honored nor broken.
 *   2. honored/openai — allowlist naming the provider that serves the model.
 *   3. honored/azure  — same model, a *different* real upstream provider, so
 *                       the per-provider breakdown has something to compare
 *                       and the latency column means something.
 *   4. fail-closed    — an allowlist no provider of this model satisfies.
 *                       OpenRouter enforces `provider.only` server-side and
 *                       404s rather than serving from outside it, which is the
 *                       promise working. Nothing is recorded for this leg.
 *
 * Run:
 *   npm run demo:routing
 *
 * Costs a few tenths of a cent in total.
 */

import { spawn } from 'child_process';
import { config as loadEnv } from 'dotenv';
import path from 'path';

loadEnv();

interface Leg {
  label: string;
  only?: string;
  question: string;
  expect: string;
  /** A leg that is supposed to fail — a non-zero exit is the pass. */
  expectFailure?: boolean;
}

const LEGS: Leg[] = [
  {
    label: 'unconstrained',
    question: 'Leg 1 of 4, no provider allowlist: look up order A-1001.',
    expect: 'recorded, outcome "unconstrained" — nothing was promised',
  },
  {
    label: 'honored via openai',
    only: 'openai',
    question: 'Leg 2 of 4, allowlist openai: look up order A-1002.',
    expect: 'outcome "honored", served by OpenAI',
  },
  {
    label: 'honored via azure',
    only: 'azure',
    question: 'Leg 3 of 4, allowlist azure: look up order A-1001 and confirm the amount.',
    expect: 'outcome "honored", served by Azure — a second real provider',
  },
  {
    label: 'fail-closed',
    only: 'anthropic',
    question: 'Leg 4 of 4, allowlist anthropic: look up order A-1003.',
    expect: 'OpenRouter refuses: no permitted provider serves this model',
    expectFailure: true,
  },
];

function runLeg(leg: Leg): Promise<number> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (leg.only) {
      env.OPENROUTER_PROVIDER_ONLY = leg.only;
    } else {
      delete env.OPENROUTER_PROVIDER_ONLY;
    }

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
      // The provenance lines ARE the demo — echo them as they arrive instead of
      // reducing each leg to a tick.
      for (const line of text.split('\n')) {
        if (line.includes('[provenance]')) {
          console.log(`      ${line.trim()}`);
        }
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

let lastTail = '';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Runs one leg and reports it. Returns whether it behaved as expected. */
async function attemptLeg(leg: Leg, isRetry = false): Promise<boolean> {
  const code = await runLeg(leg);
  const failed = code !== 0;
  const asExpected = leg.expectFailure ? failed : !failed;

  if (asExpected) {
    console.log(`  ✓ ${leg.label} — ${leg.expect}`);
    return true;
  }

  // Stay quiet on the first miss; the retry usually settles it.
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

  console.log('\nRouting integrity showcase — four legs, real API calls.\n');

  // Sequential on purpose: concurrent runs interleave in the session timeline
  // and make the panel harder to read while you are learning what it shows.
  //
  // Each leg gets one retry, and there is a pause between legs. Back-to-back
  // runs against the same upstream provider hit transient 5xx/rate-limit
  // errors often enough to spoil the demo — observed once in four legs — and a
  // showcase that fails for reasons unrelated to what it is showing is worse
  // than useless.
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

The four runs are labelled "Leg N of 4" in their prompts, so they are
distinguishable in the dashboard:
  Agent → Provenance   whole-agent view, all four legs
  Agent → Verify       pick a session, see that session's calls

Expected:
  · leg 1 unconstrained — recorded, but nothing was promised, so it is neither
    a pass nor a failure
  · legs 2 and 3 honored, by two DIFFERENT real providers, so the per-provider
    latency comparison means something
  · leg 4 has no provenance at all and closes as a FAILED session carrying its
    reason — OpenRouter enforces the allowlist server-side, so the request was
    refused rather than served by someone else. That is the promise working
  · no dishonored call anywhere, which is the correct result
`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
