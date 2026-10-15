import type { CodexAccess, CodexCredentialSource } from './codex.types.js';

interface CodexFetchOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

function jsonResponse(response: Response, value: unknown, status = response.status): Response {
  const headers = new Headers(response.headers);
  headers.set('content-type', 'application/json');
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.delete('transfer-encoding');
  return new Response(JSON.stringify(value), { status, headers });
}

function streamError(response: Response, message: string, code = 'codex_stream_error'): Response {
  return jsonResponse(response, { error: { message, type: 'server_error', code } }, 502);
}

/** Codex only serves SSE; ordinary Responses callers still receive a JSON response. */
async function collectResponse(response: Response, signal: AbortSignal): Promise<Response> {
  if (!response.body) return streamError(response, 'Codex response stream is missing');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let data: string[] = [];
  let eventType = '';
  const event = (): Response | undefined => {
    if (!data.length) { eventType = ''; return undefined; }
    const payload = data.join('\n');
    data = [];
    if (payload === '[DONE]') return streamError(response, 'Codex stream ended without response.completed');
    let value: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(payload);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid event');
      value = parsed as Record<string, unknown>;
    } catch {
      return streamError(response, 'Codex returned an invalid SSE event');
    }
    const type = value.type ?? eventType;
    eventType = '';
    if (type === 'response.completed') {
      if (!value.response || typeof value.response !== 'object') return streamError(response, 'Codex completed event has no response');
      return jsonResponse(response, value.response);
    }
    if (type === 'response.failed' || type === 'response.incomplete' || type === 'error') {
      const result = value.response as { error?: { message?: string; code?: string }; incomplete_details?: { reason?: string } } | undefined;
      const error = (value.error ?? result?.error) as { message?: string; code?: string } | undefined;
      return streamError(response, error?.message ?? (typeof value.message === 'string' ? value.message : undefined)
        ?? result?.incomplete_details?.reason ?? `Codex ${String(type)}`, error?.code);
    }
    return undefined;
  };
  const line = (text: string): Response | undefined => {
    if (!text) return event();
    if (text.startsWith(':')) return undefined;
    const colon = text.indexOf(':');
    const field = colon < 0 ? text : text.slice(0, colon);
    const value = colon < 0 ? '' : text.slice(colon + 1).replace(/^ /, '');
    if (field === 'data') data.push(value);
    else if (field === 'event') eventType = value;
    return undefined;
  };
  const abort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      let offset = 0;
      for (let index = 0; index < pending.length; index++) {
        const char = pending[index];
        if (char !== '\r' && char !== '\n') continue;
        // A CRLF separator may be split across chunks.
        if (char === '\r' && index === pending.length - 1 && !chunk.done) break;
        const result = line(pending.slice(offset, index));
        if (result) return result;
        if (char === '\r' && pending[index + 1] === '\n') index++;
        offset = index + 1;
      }
      pending = pending.slice(offset);
      if (chunk.done) {
        const result = pending ? line(pending) : undefined;
        return result ?? event() ?? streamError(response, 'Codex stream ended without response.completed');
      }
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function withRetryHint(response: Response, now: number): Response {
  if (response.status !== 429 || response.headers.has('retry-after') || response.headers.has('retry-after-ms')) return response;
  let delay: number | undefined;
  for (const [name, value] of response.headers) {
    const match = /^x-codex(?:-[a-z0-9-]+)?-(?:primary|secondary)-reset-(at|after(?:-seconds)?)$/.exec(name);
    if (!match || !value.trim()) continue;
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) continue;
    // Upstream rate_limits.rs exposes reset-at as Unix seconds, not a duration.
    // https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/rate_limits.rs
    const milliseconds = match[1] === 'at' ? Math.max(0, seconds * 1000 - now) : seconds * 1000;
    delay = Math.max(delay ?? 0, milliseconds);
  }
  if (delay === undefined || delay > 60_000) return response;
  const headers = new Headers(response.headers);
  headers.set('retry-after-ms', String(Math.ceil(delay)));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function createCodexFetch(source: CodexCredentialSource, opts: CodexFetchOptions = {}): typeof fetch {
  const fetcher = opts.fetch ?? globalThis.fetch;
  return async (input, init) => {
    let request = new Request(input, init);
    let nonStreaming = false;
    if (new URL(request.url).pathname.endsWith('/responses') && request.method === 'POST') {
      const body = await request.json() as Record<string, unknown>;
      nonStreaming = body.stream !== true;
      body.stream = true;
      body.store = false;
      delete body.max_output_tokens;
      delete body.max_completion_tokens;
      if (typeof body.instructions !== 'string' || !body.instructions.trim()) body.instructions = 'You are a helpful assistant.';
      const headers = new Headers(request.headers);
      headers.delete('content-length');
      request = new Request(request, { body: JSON.stringify(body), headers });
    }
    const send = async (access: CodexAccess) => {
      request.signal.throwIfAborted();
      const headers = new Headers(request.headers);
      headers.set('authorization', `Bearer ${access.accessToken}`);
      headers.set('chatgpt-account-id', access.accountId);
      headers.set('originator', 'llmwiki');
      headers.set('OpenAI-Beta', 'responses=experimental');
      return fetcher(new Request(request.clone(), { headers }));
    };
    let response = await send(await source.getAccess());
    if (response.status === 401) {
      await response.body?.cancel();
      request.signal.throwIfAborted();
      response = await send(await source.refreshAccess());
    }
    response = withRetryHint(response, (opts.now ?? Date.now)());
    return nonStreaming && response.ok ? collectResponse(response, request.signal) : response;
  };
}
