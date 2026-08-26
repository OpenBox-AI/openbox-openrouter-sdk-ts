import { OpenRouter, callModel } from '@openrouter/agent';
import { createOpenBoxGovernance } from '../src/index';

const openbox = createOpenBoxGovernance({ agentName: 'openrouter-stream-e2e', onApiError: 'fail_closed' });
const client = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY! });

async function main() {
  const result = await openbox.callModel(callModel, client, {
    model: process.env.OPENROUTER_MODEL ?? 'anthropic/claude-3.5-haiku',
    input: 'Count from 1 to 5, one number per line.',
  });

  let chunks = 0;
  let text = '';
  for await (const delta of (result as any).getTextStream()) {
    chunks++;
    text += delta;
  }
  console.log(`streamed ${chunks} chunks, ${text.length} chars`);
  console.log(JSON.stringify(text));
  await openbox.close();
}
main().catch((e) => { console.error('FAILED:', e); process.exitCode = 1; });
