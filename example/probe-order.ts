/** When does SessionEnd fire relative to the final text being available? */
import { OpenRouter, callModel } from '@openrouter/agent';

const client = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY! });
const t0 = Date.now();
const at = () => `+${Date.now() - t0}ms`;

const result = callModel(client, {
  model: process.env.OPENROUTER_MODEL ?? 'anthropic/claude-3.5-haiku',
  input: 'Say hello in five words.',
  hooks: {
    PostModelCall: [{ handler: (p: any) => { console.log(`PostModelCall ${at()} turn=${p.turnNumber}`); } }],
    SessionEnd: [{ handler: (p: any) => { console.log(`SessionEnd     ${at()} reason=${p.reason}`); } }],
  },
} as any);

(async () => {
  const text = await (result as any).getText();
  console.log(`getText resolved ${at()}: ${JSON.stringify(text)}`);
})();
