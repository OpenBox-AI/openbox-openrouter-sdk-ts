/**
 * Waiting for the generation record.
 *
 * OpenRouter publishes a call's generation record after the response, and on
 * 2026-10-01 that took 129s. The lookup used to give up after ~9s, so every
 * run's provenance was lost. It now waits until a deadline, and the run's
 * close (which must wait for it, because Core refuses events once a session
 * has closed) no longer holds up the caller reading the answer.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PROVENANCE_TIMEOUT_MS,
  fetchGenerationRecord,
  provenanceBackoffSchedule,
} from '../src/provenance';

describe('the lookup schedule', () => {
  it('starts quick, then settles at a capped interval', () => {
    const schedule = provenanceBackoffSchedule(60_000);
    expect(schedule.slice(0, 5)).toEqual([300, 700, 1_500, 2_500, 4_000]);
    expect(Math.max(...schedule)).toBe(10_000);
  });

  it('spends exactly the budget it is given', () => {
    for (const deadline of [1_000, 9_000, 60_000, DEFAULT_PROVENANCE_TIMEOUT_MS]) {
      const total = provenanceBackoffSchedule(deadline).reduce((a, b) => a + b, 0);
      expect(total).toBe(deadline);
    }
  });

  it('defaults to minutes, not seconds', () => {
    expect(DEFAULT_PROVENANCE_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
  });
});

describe('fetchGenerationRecord', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function stubGeneration(notFoundFor: number) {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls <= notFoundFor) return new Response('{}', { status: 404 });
      return new Response(
        JSON.stringify({ data: { provider_name: 'OpenAI', model: 'openai/gpt-4o-mini' } }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('keeps looking well past the old ~9s budget', async () => {
    vi.useFakeTimers();
    // 404 for the first 15 lookups: ~9s of quick waits, then ~90s at the cap.
    const fetchMock = stubGeneration(15);

    const pending = fetchGenerationRecord('gen-late', null, { apiKey: 'k', deadlineMs: 180_000 });
    await vi.advanceTimersByTimeAsync(180_000);
    const record = await pending;

    expect(record?.provider).toBe('OpenAI');
    expect(fetchMock).toHaveBeenCalledTimes(16);
  });

  it('gives up at the deadline and returns null', async () => {
    vi.useFakeTimers();
    stubGeneration(Number.POSITIVE_INFINITY);

    const pending = fetchGenerationRecord('gen-never', null, { apiKey: 'k', deadlineMs: 30_000 });
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(pending).resolves.toBeNull();
  });
});
