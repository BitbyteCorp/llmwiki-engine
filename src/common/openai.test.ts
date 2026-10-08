import { createServer, type RequestListener, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createOpenAI, parseRateLimitDuration, rateLimitAwareFetch } from './openai.js';

const servers: Server[] = [];
const embeddingResult = {
  object: 'list', model: 'text-embedding-3-small',
  data: [{ object: 'embedding', index: 0, embedding: [0.25, -0.75] }],
  usage: { prompt_tokens: 1, total_tokens: 1 },
};

function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string | undefined> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(value));
}

async function startServer(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Retry test server did not bind a TCP port');
  return `http://127.0.0.1:${address.port}/v1`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

describe('OpenAI rate-limit durations', () => {
  it.each([
    ['1m30s', 90_000],
    ['120ms', 120],
    ['7.768s', 7_768],
    ['1h2m3s4ms', 3_723_004],
    ['0.5m250ms', 30_250],
    ['0s', 0],
  ])('parses %s into milliseconds', (value, milliseconds) => {
    expect(parseRateLimitDuration(value)).toBe(milliseconds);
  });

  it.each([null, '', '30', '-1s', 'NaNs', 'Infinitys', '1m30', '1s extra', 'prefix1s', '1fortnight'])
    ('rejects incomplete or invalid duration %j', (value) => {
      expect(parseRateLimitDuration(value)).toBeUndefined();
    });
});

describe('OpenAI rate-limit retries', () => {
  it.each([
    { name: 'token reset header', headers: { 'x-ratelimit-reset-tokens': '0.3s' },
      message: 'Token rate limit reached', hintMs: 300, retryAfterMs: '550' },
    { name: 'body-only hint', headers: {},
      message: 'Please try again in 0.2s.', hintMs: 200, retryAfterMs: '450' },
  ])('recovers from a 429 using the $name', async ({ headers, message, hintMs, retryAfterMs }) => {
    const attempts: number[] = [];
    const error = { error: { type: 'rate_limit_error', code: 'rate_limit_exceeded', message } };
    const url = await startServer((req, res) => {
      req.resume();
      if (req.method === 'POST') {
        attempts.push(performance.now());
        if (attempts.length > 1) {
          json(res, 200, embeddingResult);
          return;
        }
      }
      json(res, 429, error, headers);
    });

    // An elapsed lower bound alone would also pass with the SDK's default backoff.
    // Check the public adapter's effective hint as well, using the same real HTTP response.
    const rateLimit = await rateLimitAwareFetch(`${url}/embeddings`);
    expect(rateLimit.status).toBe(429);
    expect(rateLimit.headers.get('retry-after-ms')).toBe(retryAfterMs);
    expect(await rateLimit.json()).toEqual(error);

    const client = createOpenAI({ openaiApiKey: 'test-key', openaiBaseUrl: url, openaiMaxRetries: 1 });
    const result = await client.embeddings.create({
      model: 'text-embedding-3-small', input: 'retry this embedding', encoding_format: 'float',
    });
    expect(result.data[0]!.embedding).toEqual([0.25, -0.75]);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]! - attempts[0]!).toBeGreaterThanOrEqual(hintMs);
  });

  it('allows transient rate limits beyond the SDK default retry count', async () => {
    let attempts = 0;
    const url = await startServer((req, res) => {
      req.resume();
      if (++attempts <= 3) {
        json(res, 429, { error: { type: 'rate_limit_error', message: 'Token rate limit reached' } },
          { 'x-ratelimit-reset-tokens': '0ms' });
      } else json(res, 200, embeddingResult);
    });
    const client = createOpenAI({ openaiApiKey: 'test-key', openaiBaseUrl: url });
    const result = await client.embeddings.create({ model: 'text-embedding-3-small', input: 'eventually succeeds', encoding_format: 'float' });
    expect(result.data[0]!.embedding).toEqual([0.25, -0.75]);
    expect(attempts).toBe(4);
  });

  it('does not retry when the configured retry budget is zero', async () => {
    let attempts = 0;
    const url = await startServer((req, res) => {
      req.resume();
      attempts++;
      json(res, 429, { error: { type: 'rate_limit_error', message: 'Please try again in 0.2s.' } });
    });
    const client = createOpenAI({ openaiApiKey: 'test-key', openaiBaseUrl: url, openaiMaxRetries: 0 });
    await expect(client.embeddings.create({ model: 'text-embedding-3-small', input: 'do not retry' }))
      .rejects.toMatchObject({ status: 429, message: expect.stringContaining('Please try again in 0.2s.') });
    expect(attempts).toBe(1);
  });
});

describe('OpenAI rate-limit HTTP adaptation', () => {
  it.each([
    { headers: { 'x-ratelimit-reset-tokens': '0.3s', 'x-ratelimit-reset-requests': '1m30s' }, expected: '90250' },
    { headers: { 'x-ratelimit-reset-tokens': '7.768s', 'x-ratelimit-reset-requests': '120ms' }, expected: '8018' },
    { headers: { 'x-ratelimit-reset-tokens': 'invalid', 'x-ratelimit-reset-requests': '120ms' }, expected: '370' },
    { headers: { 'x-ratelimit-reset-tokens': 'invalid', 'x-ratelimit-reset-requests': 'invalid' }, expected: '750' },
  ])('uses the maximum valid reset header before the body hint: $headers', async ({ headers, expected }) => {
    const error = { error: { message: 'Please try again in 0.5s.' } };
    const url = await startServer((_req, res) => json(res, 429, error, headers));
    const response = await rateLimitAwareFetch(url);
    expect(response.headers.get('retry-after-ms')).toBe(expected);
    expect(await response.json()).toEqual(error);
  });

  it.each([
    { 'retry-after': '2' },
    { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' },
    { 'retry-after-ms': '75' },
  ])('preserves a server-provided retry header %j', async (retryHeader) => {
    const error = { error: { message: 'Please try again in 30s.' } };
    const url = await startServer((_req, res) => json(res, 429, error, {
      ...retryHeader, 'x-ratelimit-reset-tokens': '1m',
    }));
    const response = await rateLimitAwareFetch(url);
    expect(response.headers.get('retry-after')).toBe(retryHeader['retry-after'] ?? null);
    expect(response.headers.get('retry-after-ms')).toBe(retryHeader['retry-after-ms'] ?? null);
    expect(await response.json()).toEqual(error);
  });

  it('leaves a 429 without usable retry hints unchanged and readable', async () => {
    const error = { error: { message: 'Rate limit exceeded' } };
    const url = await startServer((_req, res) => json(res, 429, error, { 'x-ratelimit-reset-tokens': 'invalid' }));
    const response = await rateLimitAwareFetch(url);
    expect(response.headers.get('retry-after-ms')).toBeNull();
    expect(await response.json()).toEqual(error);
  });

  it('returns non-429 streaming data before the server completes the response', async () => {
    let streamingResponse: ServerResponse | undefined;
    const url = await startServer((_req, res) => {
      streamingResponse = res;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-ratelimit-reset-tokens': '1m' });
      res.write('data: first\n\n');
    });
    const response = await rateLimitAwareFetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('retry-after-ms')).toBeNull();
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: first\n\n');
    streamingResponse!.end('data: last\n\n');
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: last\n\n');
    expect((await reader.read()).done).toBe(true);
  });

  it('propagates cancellation to an in-flight HTTP request', async () => {
    let received!: () => void;
    const requestReceived = new Promise<void>((resolve) => { received = resolve; });
    const url = await startServer((req, _res) => { req.resume(); received(); });
    const controller = new AbortController();
    const pending = rateLimitAwareFetch(url, { signal: controller.signal });
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await requestReceived;
    controller.abort();
    await rejection;
  });
});
