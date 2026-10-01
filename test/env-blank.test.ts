/**
 * A blank environment variable resolves exactly as an unset one.
 *
 * Templated `.env` files leave lines like `OPENBOX_API_URL=` behind. Those must
 * fall through to the next source, not shadow it with an empty string.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mergeConfig } from '../src/config';
import { envNumber, envString } from '../src/env';
import { DEFAULT_OPENBOX_URL, resolveCredentials } from '../src/transport';

const VARS = [
  'OPENBOX_API_KEY',
  'OPENBOX_API_URL',
  'OPENBOX_URL',
  'OPENBOX_AGENT_DID',
  'OPENBOX_AGENT_PRIVATE_KEY',
  'OPENROUTER_API_KEY',
  'OPENBOX_ATTEST_ROUTING',
  'OPENBOX_PREFLIGHT_ROUTING',
  'OPENBOX_HITL_POLL_INTERVAL_MS',
  'OPENBOX_HITL_TIMEOUT_MS',
  'OPENBOX_SPAN_CONCURRENCY',
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
  for (const v of VARS) delete process.env[v];
});

afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

const BLANKS = ['', '   ', '\t\n'];

describe('envString / envNumber', () => {
  it.each(BLANKS)('treat %j as unset', (blank) => {
    process.env.OPENBOX_URL = blank;
    process.env.OPENBOX_SPAN_CONCURRENCY = blank;
    expect(envString('OPENBOX_URL')).toBeUndefined();
    expect(envNumber('OPENBOX_SPAN_CONCURRENCY')).toBeUndefined();
  });

  it('return set values unchanged', () => {
    process.env.OPENBOX_URL = 'https://core.example';
    process.env.OPENBOX_SPAN_CONCURRENCY = '8';
    expect(envString('OPENBOX_URL')).toBe('https://core.example');
    expect(envNumber('OPENBOX_SPAN_CONCURRENCY')).toBe(8);
  });
});

describe('resolveCredentials', () => {
  it.each(BLANKS)('lets a blank OPENBOX_API_URL (%j) fall through to OPENBOX_URL', (blank) => {
    process.env.OPENBOX_API_KEY = 'obx_test';
    process.env.OPENBOX_API_URL = blank;
    process.env.OPENBOX_URL = 'https://core.example/';
    expect(resolveCredentials().openboxUrl).toBe('https://core.example');
  });

  it('falls back to the default URL when both URL variables are blank', () => {
    process.env.OPENBOX_API_KEY = 'obx_test';
    process.env.OPENBOX_API_URL = '';
    process.env.OPENBOX_URL = ' ';
    expect(resolveCredentials().openboxUrl).toBe(DEFAULT_OPENBOX_URL);
  });

  it('treats a blank API key as missing', () => {
    process.env.OPENBOX_API_KEY = '  ';
    expect(() => resolveCredentials()).toThrow(/API key not set/);
  });

  it('treats a blank DID and private key as unsigned mode', () => {
    process.env.OPENBOX_API_KEY = 'obx_test';
    process.env.OPENBOX_AGENT_DID = ' ';
    process.env.OPENBOX_AGENT_PRIVATE_KEY = '';
    const creds = resolveCredentials();
    expect(creds.agentDid).toBeUndefined();
    expect(creds.agentPrivateKey).toBeUndefined();
  });

  it('still prefers explicit options over the environment', () => {
    process.env.OPENBOX_API_KEY = 'obx_env';
    expect(resolveCredentials({ apiKey: 'obx_explicit' }).apiKey).toBe('obx_explicit');
  });
});

describe('mergeConfig', () => {
  const unset = () => mergeConfig({});

  it.each(BLANKS)('resolves blank (%j) values the same as unset ones', (blank) => {
    const expected = unset();
    for (const v of VARS) process.env[v] = blank;
    const actual = mergeConfig({});

    expect(actual.openrouterApiKey).toBeNull();
    expect(actual.openrouterApiKey).toBe(expected.openrouterApiKey);
    expect(actual.attestRouting).toBe(expected.attestRouting);
    expect(actual.preflightRouting).toBe(expected.preflightRouting);
    expect(actual.hitl).toEqual(expected.hitl);
    expect(actual.spanConcurrency).toBe(expected.spanConcurrency);
  });
});
