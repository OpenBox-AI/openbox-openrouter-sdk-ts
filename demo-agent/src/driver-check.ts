/**
 * Covers the paths instrumentation-check does not: mysql2, mongodb, and file
 * IO. No mysql/mongo server is running, which is deliberate — a refused
 * connection is exactly what the "report failed database connections" span
 * path exists for.
 */
import { config as loadEnv } from 'dotenv';
loadEnv();
import { OpenRouter, callModel, tool } from '@openrouter/agent';
import { createOpenBoxGovernance } from '@openbox-ai/openbox-openrouter-governance';
import { z } from 'zod';
import mysql from 'mysql2/promise';
import { MongoClient } from 'mongodb';
import { readFile } from 'fs/promises';

const log = (m: string) => console.log(`  [tool] ${m}`);

const mysqlCheck = tool({
  name: 'mysql_check', description: 'Check the MySQL inventory database',
  inputSchema: z.object({ db: z.string() }),
  execute: async ({ db }: { db: string }) => {
    log(`mysql_check(${db})`);
    try {
      const c = await mysql.createConnection({ host: '127.0.0.1', port: 3399, user: 'x', database: db, connectTimeout: 1500 });
      await c.end();
      return { db, reachable: true };
    } catch (e) { return { db, reachable: false, error: (e as Error).message.slice(0, 60) }; }
  },
});

const mongoCheck = tool({
  name: 'mongo_check', description: 'Check the Mongo audit collection',
  inputSchema: z.object({ collection: z.string() }),
  execute: async ({ collection }: { collection: string }) => {
    log(`mongo_check(${collection})`);
    const client = new MongoClient('mongodb://127.0.0.1:27099', { serverSelectionTimeoutMS: 1500 });
    try {
      await client.connect();
      await client.db('audit').collection(collection).findOne({});
      return { collection, reachable: true };
    } catch (e) { return { collection, reachable: false, error: (e as Error).message.slice(0, 60) }; }
      finally { await client.close().catch(() => {}); }
  },
});

const fileCheck = tool({
  name: 'file_check', description: 'Read the service manifest file',
  inputSchema: z.object({ path: z.string() }),
  execute: async ({ path }: { path: string }) => {
    log(`file_check(${path})`);
    const text = await readFile('package.json', 'utf8');
    return { path, bytes: text.length };
  },
});

(async () => {
  const openbox = createOpenBoxGovernance({
    agentName: 'driver-check',
    onApiError: 'fail_closed',
    instrumentFileIo: true,   // off by default; on here to exercise it
  });
  const client = new OpenRouter({ apiKey: process.env.OPENROUTER_API_KEY! });
  const result = await openbox.callModel(callModel, client, {
    model: process.env.OPENROUTER_MODEL!,
    instructions: 'Call all three tools exactly once: mysql_check on "inventory", mongo_check on "events", file_check on "manifest". Report briefly.',
    input: 'Run the driver diagnostic.',
    tools: openbox.tools([mysqlCheck, mongoCheck, fileCheck]),
  });
  console.log(`\n${(await result.getText()).slice(0, 260)}\n`);
  await openbox.close();
})().catch((e) => { console.error('FAILED:', e); process.exitCode = 1; });
