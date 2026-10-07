import { ApiError, type Message } from './api';

export interface ChatStreamHandlers {
  onDelta: (text: string) => void;
  onDone?: (message: Message) => void;
}

/** Sends one question and resolves only after the server's terminal done event. */
export async function sendMessage(
  id: string,
  content: string,
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
): Promise<Message> {
  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ content }),
    signal,
  });

  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new CustomEvent('session-expired'));
    const payload = await response.json().catch(() => null) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ApiError(
      response.status,
      payload?.error?.code ?? 'chat_request_failed',
      payload?.error?.message ?? '질문을 보내지 못했습니다.',
    );
  }
  if (!response.body) throw new Error('답변 스트림을 읽을 수 없습니다.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data: string[] = [];
  let finalMessage: Message | undefined;

  const dispatch = () => {
    const eventName = event;
    const eventData = data.join('\n');
    event = '';
    data = [];
    if (!eventData || !['delta', 'done', 'error'].includes(eventName)) return;
    signal?.throwIfAborted();
    let payload: unknown;
    try {
      payload = JSON.parse(eventData);
    } catch {
      throw new Error('답변 스트림의 형식이 올바르지 않습니다.');
    }
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('답변 스트림의 형식이 올바르지 않습니다.');
    }
    if (eventName === 'error') {
      const message = 'message' in payload ? payload.message : undefined;
      throw new Error(typeof message === 'string' ? message : '답변 생성에 실패했습니다.');
    }
    if (eventName === 'delta') {
      if (!('text' in payload) || typeof payload.text !== 'string') {
        throw new Error('답변 스트림의 형식이 올바르지 않습니다.');
      }
      handlers.onDelta(payload.text);
      return;
    }
    const message = 'message' in payload ? payload.message : undefined;
    if (
      typeof message !== 'object' || message === null ||
      !('id' in message) || typeof message.id !== 'string' ||
      !('role' in message) || message.role !== 'assistant' ||
      !('content' in message) || typeof message.content !== 'string' ||
      !('createdAt' in message) || typeof message.createdAt !== 'string' ||
      !('citations' in message) || !Array.isArray(message.citations) ||
      !message.citations.every((citation: unknown) => typeof citation === 'string')
    ) {
      throw new Error('완료된 답변의 형식이 올바르지 않습니다.');
    }
    finalMessage = message as Message;
    handlers.onDone?.(finalMessage);
  };

  const processLine = (line: string) => {
    if (!line) {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    if (field === 'data') data.push(value);
  };

  const consume = (atEnd = false) => {
    let start = 0;
    for (let index = 0; index < buffer.length; index += 1) {
      const character = buffer[index];
      if (character !== '\r' && character !== '\n') continue;
      // A CR at the end of a chunk may be the first half of CRLF.
      if (character === '\r' && index + 1 === buffer.length && !atEnd) break;
      processLine(buffer.slice(start, index));
      if (character === '\r' && buffer[index + 1] === '\n') index += 1;
      start = index + 1;
      if (finalMessage) break;
    }
    buffer = buffer.slice(start);
    if (atEnd && !finalMessage) {
      if (buffer) processLine(buffer);
      buffer = '';
      dispatch();
    }
  };

  try {
    while (!finalMessage) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) {
        buffer += decoder.decode();
        consume(true);
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      consume();
    }
    signal?.throwIfAborted();
    if (!finalMessage) throw new Error('답변 연결이 완료 전에 끊어졌습니다. 일부 답변만 표시됩니다.');
    return finalMessage;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
