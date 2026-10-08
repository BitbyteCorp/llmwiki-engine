import { z } from 'zod';
import { ApiError, request, type Message, type MessageUsage } from './api';

export interface ChatMessageInput {
  content: string;
  clientId?: string;
  attachments?: string[];
  context?: { notePath: string; ref?: string; selection?: string };
  model?: string;
  effort?: 'low' | 'medium' | 'high';
}

export interface ChatCitation { path: string; heading?: string; anchor?: string; excerpt?: string; sha?: string }
export type ChatStreamEvent =
  | { id: number; event: 'generation'; data: { generationId: string; userMessageId: string | null } }
  | { id: number; event: 'status'; data: { phase: string } }
  | { id: number; event: 'tool'; data: { name: string; state: 'start' | 'end'; summary: string; path?: string; jobId?: string } }
  | { id: number; event: 'citation'; data: ChatCitation }
  | { id: number; event: 'delta'; data: { text: string; replace?: boolean } }
  | { id: number; event: 'usage'; data: MessageUsage }
  | { id: number; event: 'done'; data: { message: Message } }
  | { id: number; event: 'error'; data: { code: string; message: string } };

export interface ChatStreamHandlers { onEvent: (event: ChatStreamEvent) => void }

const eventNames: Record<string, true> = { generation: true, status: true, tool: true, citation: true, delta: true, usage: true, done: true, error: true };
const cursorPrefix = 'llmwiki.chat.generation.';
class ConnectionLost extends Error {}

const citationSchema = z.object({ path: z.string(), heading: z.string().optional(), anchor: z.string().optional(), excerpt: z.string().optional(), sha: z.string().optional() });
const usageSchema = z.object({ inputTokens: z.number(), cachedInputTokens: z.number().optional(), outputTokens: z.number(), reasoningTokens: z.number() });
const messageSchema = z.object({
  id: z.string(), role: z.literal('assistant'), content: z.string(), citations: z.array(citationSchema),
  attachments: z.array(z.string()), context: z.object({ notePath: z.string(), ref: z.string().optional(), selection: z.string().optional() }).nullable(),
  status: z.enum(['completed', 'running', 'failed', 'cancelled', 'interrupted']), usage: usageSchema.nullable(),
  resumable: z.boolean().optional(),
  model: z.string().nullable(), effort: z.string().nullable(), generationId: z.string().nullable().optional(), createdAt: z.string(),
});
const streamEventSchema = z.discriminatedUnion('event', [
  z.object({ id: z.number(), event: z.literal('generation'), data: z.object({ generationId: z.string(), userMessageId: z.string().nullable() }) }),
  z.object({ id: z.number(), event: z.literal('status'), data: z.object({ phase: z.string() }) }),
  z.object({ id: z.number(), event: z.literal('tool'), data: z.object({ name: z.string(), state: z.enum(['start', 'end']), summary: z.string(), path: z.string().optional(), jobId: z.string().optional() }) }),
  z.object({ id: z.number(), event: z.literal('citation'), data: citationSchema }),
  z.object({ id: z.number(), event: z.literal('delta'), data: z.object({ text: z.string(), replace: z.boolean().optional() }) }),
  z.object({ id: z.number(), event: z.literal('usage'), data: usageSchema }),
  z.object({ id: z.number(), event: z.literal('done'), data: z.object({ message: messageSchema }) }),
  z.object({ id: z.number(), event: z.literal('error'), data: z.object({ code: z.string(), message: z.string() }) }),
]);

function persistCursor(generationId: string, cursor: number): void {
  try { localStorage.setItem(`${cursorPrefix}${generationId}`, String(cursor)); } catch { /* Storage is optional. */ }
}

function backoff(attempt: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const aborted = () => { clearTimeout(timer); reject(signal?.reason ?? new DOMException('Aborted', 'AbortError')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, Math.min(500 * 2 ** Math.min(attempt, 5), 10_000));
  signal?.addEventListener('abort', aborted, { once: true });
  return promise;
}

async function openStream(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  signal?.throwIfAborted();
  let response: Response;
  try { response = await fetch(path, { ...init, credentials: 'same-origin', signal }); }
  catch (error) { signal?.throwIfAborted(); throw new ConnectionLost('답변 연결이 끊어졌습니다.', { cause: error }); }
  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('session-expired'));
    const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(response.status, payload?.error?.code ?? 'chat_request_failed', payload?.error?.message ?? '답변을 요청하지 못했습니다.');
  }
  if (!response.body) throw new Error('답변 스트림을 읽을 수 없습니다.');
  return response;
}

/** Reads only complete SSE frames; a torn final frame is replayed after reconnect. */
async function consumeStream(response: Response, dispatch: (event: ChatStreamEvent) => boolean, signal?: AbortSignal): Promise<void> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';
  let eventId = '';
  let data: string[] = [];
  let terminal = false;
  const aborted = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', aborted, { once: true });

  const processLine = (line: string) => {
    if (!line) {
      const name = eventName, id = eventId, json = data.join('\n');
      eventName = ''; eventId = ''; data = [];
      if (!json || !Object.hasOwn(eventNames, name)) return;
      if (!/^\d+$/u.test(id) || !Number.isSafeInteger(Number(id))) throw new Error('답변 이벤트 순서가 올바르지 않습니다.');
      let payload: unknown;
      try { payload = JSON.parse(json); } catch { throw new Error('답변 스트림의 형식이 올바르지 않습니다.'); }
      const parsed = streamEventSchema.safeParse({ id: Number(id), event: name, data: payload });
      if (!parsed.success) throw new Error('답변 스트림의 형식이 올바르지 않습니다.');
      terminal = dispatch(parsed.data);
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    if (field === 'id') eventId = value;
    if (field === 'data') data.push(value);
  };

  try {
    while (!terminal) {
      signal?.throwIfAborted();
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); }
      catch (error) { signal?.throwIfAborted(); throw new ConnectionLost('답변 연결이 끊어졌습니다.', { cause: error }); }
      signal?.throwIfAborted();
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      let start = 0;
      for (let index = 0; index < buffer.length; index += 1) {
        const character = buffer[index];
        if (character !== '\r' && character !== '\n') continue;
        if (character === '\r' && index + 1 === buffer.length && !chunk.done) break;
        processLine(buffer.slice(start, index));
        if (character === '\r' && buffer[index + 1] === '\n') index += 1;
        start = index + 1;
        if (terminal) break;
      }
      buffer = buffer.slice(start);
      if (chunk.done && !terminal) throw new ConnectionLost('답변 연결이 완료 전에 끊어졌습니다.');
    }
  } finally {
    signal?.removeEventListener('abort', aborted);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function followGeneration(
  initial: { path: string; init: RequestInit; retryInitial: boolean },
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
  knownGenerationId?: string,
): Promise<Message | null> {
  let generationId = knownGenerationId;
  let cursor = 0;
  let attempt = 0;
  let finalMessage: Message | null = null;
  for (;;) {
    signal?.throwIfAborted();
    const path = generationId ? `/api/generations/${encodeURIComponent(generationId)}/events` : initial.path;
    const init: RequestInit = generationId
      ? { headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(cursor) } }
      : initial.init;
    try {
      const response = await openStream(path, init, signal);
      await consumeStream(response, event => {
        if (event.event === 'generation') generationId = event.data.generationId;
        if (event.id <= cursor) return false;
        handlers.onEvent(event);
        cursor = event.id;
        attempt = 0;
        if (generationId) persistCursor(generationId, cursor);
        if (event.event === 'done') { finalMessage = event.data.message; return true; }
        if (event.event === 'error') {
          if (!generationId) throw new ApiError(502, event.data.code, event.data.message);
          return true;
        }
        return false;
      }, signal);
      return finalMessage;
    } catch (error) {
      signal?.throwIfAborted();
      const retryable = error instanceof ConnectionLost || (generationId && error instanceof ApiError && (error.status === 408 || error.status === 429 || error.status >= 500));
      // Message actions are not idempotent before their generation frame arrives.
      if (!retryable || (!generationId && !initial.retryInitial)) throw error;
      await backoff(attempt++, signal);
    }
  }
}

/** Retries an uncertain initial POST with the same idempotency key. Abort only detaches. */
export function sendMessage(id: string, input: ChatMessageInput, handlers: ChatStreamHandlers, signal?: AbortSignal): Promise<Message | null> {
  const body = JSON.stringify({ ...input, clientId: input.clientId ?? crypto.randomUUID() });
  return followGeneration({
    path: `/api/conversations/${encodeURIComponent(id)}/messages`,
    init: { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body },
    retryInitial: true,
  }, handlers, signal);
}

/** Fresh attachment replays from zero to rebuild UI state; live reconnects use their exact cursor. */
export function resumeGeneration(generationId: string, handlers: ChatStreamHandlers, signal?: AbortSignal): Promise<Message | null> {
  return followGeneration({ path: '', init: {}, retryInitial: false }, handlers, signal, generationId);
}

export function streamMessageAction(
  conversationId: string,
  messageId: string,
  action: 'edit' | 'retry' | 'regenerate',
  input: { content?: string },
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
): Promise<Message | null> {
  const path = `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`;
  return followGeneration({
    path: action === 'edit' ? path : `${path}/${action}`,
    init: { method: action === 'edit' ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, ...(action === 'edit' ? { body: JSON.stringify(input) } : {}) },
    retryInitial: false,
  }, handlers, signal);
}

/** Cancellation is deliberately separate from aborting a stream connection. */
export function cancelGeneration(generationId: string, signal?: AbortSignal): Promise<void> {
  return request<void>(`/api/generations/${encodeURIComponent(generationId)}/cancel`, { method: 'POST', signal });
}
