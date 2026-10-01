/**
 * Requests to OpenBox Core never follow a redirect.
 *
 * On a cross-origin redirect `fetch` drops `Authorization` but re-sends every
 * custom header, so following one would hand the X-OpenBox-* signing headers to
 * the redirect target, and its body would be read as Core's governance answer.
 */

import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { GovernanceClient } from '../src/client';
import { FetchTransport, SoftGovernanceError } from '../src/transport';

// A valid 32-byte Ed25519 seed, so requests carry the full signing header set.
const SEED = Buffer.alloc(32, 7).toString('base64');

const servers: Server[] = [];

function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

/** A Core that redirects every request to `target`, which records what reached it. */
async function redirectingCore(status = 302) {
  const reached: IncomingHttpHeaders[] = [];
  const target = await listen((req, res) => {
    reached.push(req.headers);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ verdict: 'allow' }));
  });
  const core = await listen((_req, res) => {
    res.statusCode = status;
    res.setHeader('location', `${target}/api/v1/governance/evaluate`);
    res.end();
  });
  const transport = new FetchTransport({
    openboxUrl: core,
    apiKey: 'obx_test',
    agentDid: 'did:aip:00000000-0000-0000-0000-000000000000',
    agentPrivateKey: SEED,
  });
  return { transport, reached, target };
}

describe('FetchTransport redirects', () => {
  it.each([301, 302, 303, 307, 308])('refuses a %i without contacting the target', async (status) => {
    const { transport, reached, target } = await redirectingCore(status);

    const attempt = transport.request({ method: 'POST', path: '/api/v1/governance/evaluate', body: {} });

    await expect(attempt).rejects.toBeInstanceOf(SoftGovernanceError);
    await expect(attempt).rejects.toThrow(new RegExp(`redirected \\(${status} to ${target}`));
    expect(reached).toHaveLength(0);
  });

  it('fails closed on a redirect when onApiError is fail_closed', async () => {
    const { transport, reached } = await redirectingCore();
    const client = new GovernanceClient(transport, 'trace-1');

    await expect(
      client.evaluateEvent({ event_type: 'ActivityStarted' } as never, 'fail_closed'),
    ).rejects.toBeInstanceOf(SoftGovernanceError);
    expect(reached).toHaveLength(0);
  });

  it('never reads a redirect target\'s body as a verdict when failing open', async () => {
    const { transport, reached } = await redirectingCore();
    const client = new GovernanceClient(transport, 'trace-1');

    // fail_open means "no answer from Core", the same as an outage — not the
    // target's { verdict: 'allow' }.
    await expect(
      client.evaluateEvent({ event_type: 'ActivityStarted' } as never, 'fail_open'),
    ).resolves.toBeNull();
    expect(reached).toHaveLength(0);
  });
});
