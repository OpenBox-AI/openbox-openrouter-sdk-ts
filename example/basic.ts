/**
 * Runnable example. Requires OPENROUTER_API_KEY and OPENBOX_API_KEY.
 *
 *   npx tsx example/basic.ts
 */

import { OpenRouter, callModel, tool } from '@openrouter/agent';
import { z } from 'zod';

import { createOpenBoxGovernance } from '../src/index';

const client = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY! });

const openbox = createOpenBoxGovernance({
  agentName: 'demo-agent',
  // A demo should not silently run ungoverned if Core is down.
  onApiError: 'fail_closed',
});

const lookup = tool({
  name: 'lookup_order',
  description: 'Look up an order by id',
  parameters: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => ({ orderId, status: 'shipped', total: 42.5 }),
});

async function main() {
  const result = await openbox.callModel(callModel, client, {
    model: 'anthropic/claude-sonnet-5',
    input: 'What is the status of order A-1001?',
    tools: openbox.tools([lookup]),
  });

  console.log(await result.getText());
}

main()
  .catch((err) => {
    // A governance block/halt surfaces here as GovernanceBlockedError /
    // GovernanceHaltError with Core's reason as the message.
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => openbox.close());
