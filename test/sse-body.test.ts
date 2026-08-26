/**
 * Core reads token usage and the model id by JSON-parsing the whole span
 * response body (observability/model.go -> extractTokenUsage / detectLLMProvider).
 * The OpenRouter Agent SDK streams the Responses API, so what we capture is an
 * SSE transcript — unparseable as JSON, which silently zeroed every run's token
 * accounting even though the numbers were present in the stream.
 */

import { describe, expect, it } from 'vitest';

import { normalizeSseResponseBody } from '../src/span_processor';

const sse = [
  'data: {"type":"response.created","response":{"id":"gen-1","model":"openai/gpt-4o-mini","status":"in_progress"}}',
  '',
  'data: {"type":"response.in_progress","response":{"id":"gen-1","model":"openai/gpt-4o-mini"}}',
  '',
  'data: {"type":"response.completed","response":{"id":"gen-1","model":"openai/gpt-4o-mini","usage":{"input_tokens":222,"output_tokens":31,"total_tokens":253}}}',
  '',
  'data: [DONE]',
  '',
].join('\n');

describe('normalizeSseResponseBody', () => {
  it('collapses an SSE stream to the terminal response object', () => {
    const out = normalizeSseResponseBody(sse);
    const parsed = JSON.parse(out!);
    expect(parsed.model).toBe('openai/gpt-4o-mini');
    expect(parsed.usage).toEqual({ input_tokens: 222, output_tokens: 31, total_tokens: 253 });
  });

  it('produces a body Core can actually read tokens from', () => {
    // Mirrors Core's own struct: it looks for usage.prompt_tokens (OpenAI) or
    // usage.input_tokens (Anthropic-shaped, which the Responses API uses).
    const parsed = JSON.parse(normalizeSseResponseBody(sse)!) as {
      usage: { prompt_tokens?: number; input_tokens?: number; output_tokens?: number };
    };
    const input = parsed.usage.prompt_tokens ?? parsed.usage.input_tokens;
    expect(input).toBe(222);
    expect(parsed.usage.output_tokens).toBe(31);
  });

  it('prefers the last frame carrying usage, not the first envelope', () => {
    const parsed = JSON.parse(normalizeSseResponseBody(sse)!);
    expect(parsed.status).toBeUndefined(); // that was response.created
    expect(parsed.usage).toBeDefined();
  });

  it('passes plain JSON through untouched', () => {
    const json = '{"usage":{"prompt_tokens":10,"completion_tokens":4},"model":"x"}';
    expect(normalizeSseResponseBody(json)).toBe(json);
  });

  it('passes an SSE stream with no usage through rather than dropping it', () => {
    const noUsage = 'data: {"type":"response.created","response":{"id":"g"}}\n\ndata: [DONE]\n';
    expect(normalizeSseResponseBody(noUsage)).toBe(noUsage);
  });

  it('survives truncated frames', () => {
    const truncated = `${sse}\ndata: {"type":"response.`;
    const parsed = JSON.parse(normalizeSseResponseBody(truncated)!);
    expect(parsed.usage.input_tokens).toBe(222);
  });

  it('leaves null alone', () => {
    expect(normalizeSseResponseBody(null)).toBeNull();
  });
});
