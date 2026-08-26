/**
 * The demo's tools, shared by the CLI (`agent.ts`) and the web UI
 * (`server.ts`) so both drive exactly the same agent.
 *
 * Three tools, deliberately different in kind:
 *   - `lookup_order`   plain read, expected to sail through
 *   - `refund_order`   the one worth governing: moves money
 *   - `search_docs`    makes a real outbound HTTP call, so the instrumentation
 *                      has something to capture besides the model call itself
 */

import { tool } from '@openrouter/agent';
import { z } from 'zod';

export const ORDERS: Record<string, { status: string; total: number; carrier: string }> = {
  'A-1001': { status: 'shipped', total: 42.5, carrier: 'DHL' },
  'A-1002': { status: 'processing', total: 189.99, carrier: 'none yet' },
  'A-1003': { status: 'delivered', total: 12.0, carrier: 'Royal Mail' },
};

export const TOOL_TYPES: Record<string, string> = {
  lookup_order: 'database',
  refund_order: 'payment',
  search_docs: 'http',
};

export function log(tag: string, message: string): void {
  console.log(`  [${tag}] ${message}`);
}

export const lookupOrder = tool({
  name: 'lookup_order',
  description: 'Look up an order by its id. Returns status, total and carrier.',
  inputSchema: z.object({ orderId: z.string().describe('e.g. A-1001') }),
  execute: async ({ orderId }: { orderId: string }) => {
    log('tool', `lookup_order(${orderId})`);
    const order = ORDERS[orderId];
    if (!order) return { error: `No order ${orderId}` };
    return { orderId, ...order };
  },
});

export const refundOrder = tool({
  name: 'refund_order',
  description: 'Issue a refund for an order. Only for delivered or shipped orders.',
  inputSchema: z.object({
    orderId: z.string(),
    amount: z.number().describe('Amount in GBP'),
    reason: z.string(),
  }),
  execute: async ({ orderId, amount, reason }: { orderId: string; amount: number; reason: string }) => {
    log('tool', `refund_order(${orderId}, £${amount}) — ${reason}`);
    // If a policy on this agent returns require_approval for refund_order,
    // OpenBox holds this call open here until a human decides, and this line
    // never runs unless they approve.
    return { orderId, refunded: amount, reference: `RF-${orderId}` };
  },
});

export const searchDocs = tool({
  name: 'search_docs',
  description: 'Search the public help centre for a policy question.',
  inputSchema: z.object({ query: z.string() }),
  execute: async ({ query }: { query: string }) => {
    log('tool', `search_docs(${query})`);
    // A real outbound request, so the HTTP instrumentation records a span for
    // the tool as well as for the model call.
    const res = await fetch(
      `https://duckduckgo.com/ac/?q=${encodeURIComponent(query)}&type=list`,
    );
    const body = (await res.json().catch(() => [])) as unknown;
    return { query, suggestions: JSON.stringify(body).slice(0, 300) };
  },
});

export const ALL_TOOLS = [lookupOrder, refundOrder, searchDocs];

export const INSTRUCTIONS =
  'You are a customer support agent. Use the tools to answer. ' +
  'Look an order up before refunding it, and refund the exact order total.';
