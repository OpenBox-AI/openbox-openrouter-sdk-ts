/**
 * Exercises every instrumentation path the SDK claims to cover, in one run:
 * model calls (llm_completion), outbound HTTP inside a tool (http_get),
 * Postgres (database_*), and Redis. Each tool is deliberately trivial — the
 * point is which spans reach Core, not what the agent concludes.
 */

import { config as loadEnv } from 'dotenv';
loadEnv();

import { OpenRouter, callModel, tool } from '@openrouter/agent';
import { createOpenBoxGovernance } from 'openbox-openrouter-governance';
import { z } from 'zod';
import { Client as PgClient } from 'pg';
import Redis from 'ioredis';

const log = (t: string, m: string) => console.log(`  [${t}] ${m}`);

const dbLookup = tool({
  name: 'db_lookup',
  description: 'Count rows in the orders table',
  inputSchema: z.object({ table: z.string() }),
  execute: async ({ table }: { table: string }) => {
    log('tool', `db_lookup(${table}) — real Postgres query`);
    const c = new PgClient({
      host: 'localhost', port: 5433, user: 'n8n', password: 'n8n', database: 'n8n',
    });
    await c.connect();
    try {
      const r = await c.query('SELECT count(*)::int AS n FROM pg_catalog.pg_tables');
      return { table, tableCount: r.rows[0].n };
    } finally {
      await c.end();
    }
  },
});

const cacheCheck = tool({
  name: 'cache_check',
  description: 'Read a key from the cache',
  inputSchema: z.object({ key: z.string() }),
  execute: async ({ key }: { key: string }) => {
    log('tool', `cache_check(${key}) — real Redis command`);
    const redis = new Redis({ host: 'localhost', port: 6380, lazyConnect: true, maxRetriesPerRequest: 1 });
    try {
      await redis.connect();
      await redis.set(key, 'demo-value');
      return { key, value: await redis.get(key) };
    } finally {
      redis.disconnect();
    }
  },
});

const webCheck = tool({
  name: 'web_check',
  description: 'Look something up on the web',
  inputSchema: z.object({ query: z.string() }),
  execute: async ({ query }: { query: string }) => {
    log('tool', `web_check(${query}) — real outbound HTTP`);
    const res = await fetch(`https://duckduckgo.com/ac/?q=${encodeURIComponent(query)}&type=list`);
    return { query, status: res.status, bytes: (await res.text()).length };
  },
});

async function main() {
  const openbox = createOpenBoxGovernance({
    agentName: 'instrumentation-check',
    onApiError: 'fail_closed',
    toolTypeMap: { db_lookup: 'database', cache_check: 'cache', web_check: 'http' },
  });

  const client = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY! });

  const result = await openbox.callModel(callModel, client, {
    model: process.env.OPENROUTER_MODEL!,
    instructions:
      'You are a diagnostics agent. Call ALL THREE tools exactly once each, in this order: ' +
      'db_lookup on table "orders", cache_check on key "demo", web_check for "openbox ai". ' +
      'Then report one line per tool.',
    input: 'Run the full diagnostic and report the results.',
    tools: openbox.tools([dbLookup, cacheCheck, webCheck]),
  });

  console.log(`\n${await result.getText()}\n`);
  await openbox.close();
}

main().catch((e) => { console.error('FAILED:', e); process.exitCode = 1; });
