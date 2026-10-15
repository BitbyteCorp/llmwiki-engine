import { describe, expect, it, vi } from 'vitest';
import { createCodexFetch } from './codex-transport.js';
import type { CodexCredentialSource } from './codex.types.js';

const endpoint = 'http://codex.invalid/responses';
const now = 1_800_000_000_000;

function credentials(): CodexCredentialSource {
  return {
    getAccess: vi.fn(async () => ({ accessToken: 'access-token', accountId: 'account-id' })),
    refreshAccess: vi.fn(async () => ({ accessToken: 'refreshed-token', accountId: 'refreshed-account' })),
    isLoggedIn: () => true,
  };
}

const request = {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'gpt-6-luna', input: 'Hello', stream: false }),
};

const completed = {
  id: 'resp_codex', object: 'response', status: 'completed',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '도니 🌙' }] }],
  output_text: '도니 🌙', usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
};

// These fetch implementations are the transport's injected wire boundary; no network requests leave the process.
describe('Codex request and SSE adaptation', () => {
  it('forces the Codex wire contract and returns the completed response as JSON to a nonstream caller', async () => {
    const wire = new TextEncoder().encode(`: keepalive\r\nevent: response.created\r\ndata: {"type":"response.created"}\r\n\r\nevent: response.completed\r\ndata: ${JSON.stringify({ type: 'response.completed', response: completed })}\r\n\r\n`);
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < wire.length; offset += 7) controller.enqueue(wire.slice(offset, offset + 7));
        controller.close();
      },
    }), { headers: { 'content-type': 'text/event-stream', 'content-length': '9999', 'x-request-id': 'codex-request' } }));
    const adapter = createCodexFetch(credentials(), { fetch: fetcher });
    const response = await adapter(endpoint, {
      ...request,
      headers: { ...request.headers, authorization: 'Bearer wrong-token', originator: 'wrong-origin' },
      body: JSON.stringify({ model: 'gpt-6-luna', input: 'Hello', stream: false, store: true,
        max_output_tokens: 100, max_completion_tokens: 100 }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('content-length')).toBeNull();
    expect(response.headers.get('x-request-id')).toBe('codex-request');
    expect(await response.json()).toEqual(completed);
    expect(fetcher).toHaveBeenCalledOnce();
    const sent = new Request(...fetcher.mock.calls[0]!);
    expect(Object.fromEntries(sent.headers)).toMatchObject({
      authorization: 'Bearer access-token', 'chatgpt-account-id': 'account-id',
      originator: 'llmwiki', 'openai-beta': 'responses=experimental',
    });
    const body = await sent.json() as Record<string, unknown>;
    expect(body).toMatchObject({ model: 'gpt-6-luna', input: 'Hello', stream: true, store: false });
    expect(body.instructions).toEqual(expect.any(String));
    expect((body.instructions as string).trim().length).toBeGreaterThan(0);
    expect(body).not.toHaveProperty('max_output_tokens');
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  it('passes a streaming response through before completion and preserves consumer cancellation', async () => {
    const cancel = vi.fn();
    const upstream = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n\n')); },
      cancel,
    }), { headers: { 'content-type': 'text/event-stream' } });
    const fetcher = vi.fn<typeof fetch>(async () => upstream);
    const response = await createCodexFetch(credentials(), { fetch: fetcher })(endpoint, {
      ...request, body: JSON.stringify({ stream: true, instructions: 'Keep this instruction' }),
    });
    expect(response).toBe(upstream);
    const sent = new Request(...fetcher.mock.calls[0]!);
    expect(await sent.json()).toMatchObject({ stream: true, store: false, instructions: 'Keep this instruction' });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('response.created');
    await reader.cancel('consumer stopped');
    expect(cancel).toHaveBeenCalledWith('consumer stopped');
  });

  it.each([
    { name: 'failed response', wire: 'data: {"type":"response.failed","response":{"error":{"message":"Codex failed","code":"server_error"}}}\n\n', message: 'Codex failed' },
    { name: 'incomplete response', wire: 'data: {"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}\n\n', message: 'max_output_tokens' },
    { name: 'error event', wire: 'data: {"type":"error","message":"Upstream unavailable"}\n\n', message: 'Upstream unavailable' },
    { name: 'malformed JSON', wire: 'data: {not-json}\n\n' },
    { name: 'malformed completed payload', wire: 'data: {"type":"response.completed"}\n\n' },
    { name: 'truncated response', wire: 'data: {"type":"response.created"}\n\n' },
    { name: 'premature DONE', wire: 'data: [DONE]\n\n' },
  ])('returns a readable gateway error for a $name rather than a successful partial answer', async ({ wire, message }) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(wire, { headers: { 'content-type': 'text/event-stream' } }));
    const response = await createCodexFetch(credentials(), { fetch: fetcher })(endpoint, request);
    expect(response.status).toBe(502);
    expect(response.headers.get('content-type')).toBe('application/json');
    const body = await response.json() as { error: { message: string; type: string } };
    expect(body.error).toMatchObject({ type: 'server_error', message: expect.any(String) });
    if (message) expect(body.error.message).toContain(message);
  });

  it('aborts a pending nonstream SSE collection and cancels the upstream reader', async () => {
    const started = Promise.withResolvers<void>();
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
      pull() { started.resolve(); }, cancel,
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } }));
    const controller = new AbortController();
    const pending = createCodexFetch(credentials(), { fetch: fetcher })(endpoint, { ...request, signal: controller.signal });
    const reason = new DOMException('Caller cancelled', 'AbortError');
    const rejected = expect(pending).rejects.toBe(reason);
    await started.promise;
    controller.abort(reason);
    await rejected;
    expect(cancel).toHaveBeenCalledWith(reason);
  });

  it('refreshes at most once when the refreshed credentials are also rejected', async () => {
    const source = credentials();
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ error: { message: 'Unauthorized' } }, { status: 401 }));
    const response = await createCodexFetch(source, { fetch: fetcher })(endpoint, request);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { message: 'Unauthorized' } });
    expect(source.refreshAccess).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
    const sent = fetcher.mock.calls.map((args) => new Request(...args));
    expect(sent.map((entry) => entry.headers.get('authorization'))).toEqual(['Bearer access-token', 'Bearer refreshed-token']);
    expect(sent.map((entry) => entry.headers.get('chatgpt-account-id'))).toEqual(['account-id', 'refreshed-account']);
    expect(await sent[1]!.json()).toEqual(await sent[0]!.json());
  });
});

describe('Codex 429 retry hints', () => {
  it.each<{ name: string; headers: Record<string, string>; expected: string | null }>([
    { name: 'Unix reset timestamp in seconds', headers: { 'x-codex-primary-reset-at': '1800000002' }, expected: '2000' },
    { name: 'relative reset in seconds', headers: { 'x-codex-primary-reset-after-seconds': '1.25' }, expected: '1250' },
    { name: 'legacy relative reset in seconds', headers: { 'x-codex-primary-reset-after': '1.5' }, expected: '1500' },
    { name: 'secondary Unix timestamp', headers: { 'x-codex-secondary-reset-at': '1800000003' }, expected: '3000' },
    { name: 'secondary relative reset', headers: { 'x-codex-secondary-reset-after-seconds': '2.5' }, expected: '2500' },
    { name: 'maximum across primary and secondary windows', headers: {
      'x-codex-primary-reset-at': '1800000002', 'x-codex-secondary-reset-after-seconds': '4',
    }, expected: '4000' },
    { name: 'maximum across additional Codex prefixes', headers: {
      'x-codex-primary-reset-after-seconds': '1', 'x-codex-secondary-reset-at': '1800000003',
      'x-codex-review-primary-reset-after-seconds': '5', 'x-codex-spark-secondary-reset-at': '1800000006',
    }, expected: '6000' },
    { name: 'expired absolute reset', headers: { 'x-codex-primary-reset-at': '1799999999' }, expected: '0' },
    { name: 'exactly sixty seconds', headers: { 'x-codex-primary-reset-after-seconds': '60' }, expected: '60000' },
    { name: 'absolute sixty-second boundary', headers: { 'x-codex-primary-reset-at': '1800000060' }, expected: '60000' },
    { name: 'just beyond sixty seconds', headers: { 'x-codex-primary-reset-after-seconds': '60.001' }, expected: null },
    { name: 'absolute reset beyond sixty seconds', headers: { 'x-codex-primary-reset-at': '1800000061' }, expected: null },
    { name: 'longest window beyond sixty seconds despite a shorter candidate', headers: {
      'x-codex-primary-reset-after-seconds': '1', 'x-codex-review-secondary-reset-after-seconds': '61',
    }, expected: null },
    { name: 'invalid values', headers: {
      'x-codex-primary-reset-at': 'not-a-number', 'x-codex-secondary-reset-after-seconds': '-1',
      'x-codex-review-primary-reset-after-seconds': 'Infinity',
    }, expected: null },
    { name: 'valid window alongside invalid values', headers: {
      'x-codex-primary-reset-after-seconds': '-1', 'x-codex-secondary-reset-after-seconds': '0.125',
    }, expected: '125' },
  ])('translates $name without a separate retry or wait', async ({ headers, expected }) => {
    const error = { error: { type: 'rate_limit_error', message: 'Codex rate limit reached' } };
    const upstream = Response.json(error, { status: 429, headers });
    const fetcher = vi.fn<typeof fetch>(async () => upstream);
    const response = await createCodexFetch(credentials(), { fetch: fetcher, now: () => now })(endpoint, request);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after-ms')).toBe(expected);
    for (const [name, value] of Object.entries(headers)) expect(response.headers.get(name)).toBe(value);
    if (expected === null) expect(response).toBe(upstream);
    expect(await response.json()).toEqual(error);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each<Record<string, string>>([{ 'retry-after': '2' }, { 'retry-after-ms': '75' }])('preserves an explicit server retry hint %j', async (headers) => {
    const upstream = Response.json({ error: { message: 'Rate limited' } }, { status: 429,
      headers: { ...headers, 'x-codex-primary-reset-after-seconds': '10' } });
    const fetcher = vi.fn<typeof fetch>(async () => upstream);
    const response = await createCodexFetch(credentials(), { fetch: fetcher, now: () => now })(endpoint, request);
    expect(response).toBe(upstream);
    expect(response.headers.get('retry-after')).toBe(headers['retry-after'] ?? null);
    expect(response.headers.get('retry-after-ms')).toBe(headers['retry-after-ms'] ?? null);
  });

  it('uses the injected current time for each response rather than capturing time when the adapter is created', async () => {
    let clock = now;
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ error: { message: 'Rate limited' } }, {
      status: 429, headers: { 'x-codex-primary-reset-at': '1800000005' },
    }));
    const adapter = createCodexFetch(credentials(), { fetch: fetcher, now: () => clock });
    const first = await adapter(endpoint, request);
    expect(first.headers.get('retry-after-ms')).toBe('5000');
    await first.json();
    clock += 3000;
    const second = await adapter(endpoint, request);
    expect(second.headers.get('retry-after-ms')).toBe('2000');
    await second.json();
  });
});
