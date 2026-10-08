'use client';

export interface ChatNoteContext { notePath: string; ref?: string; selection?: string }
/** Request for the Dony chat surface. The workspace shell routes it to the right-side panel or the `/chat` page. */
export interface ChatOpenRequest { conversationId?: string; newThread?: boolean; focusSearch?: boolean }
export const CHAT_OPEN_EVENT = 'llmwiki:chat-open';
const key = 'llmwiki.agent.pending-context';

export function openChat(request: ChatOpenRequest = {}): void {
  window.dispatchEvent(new CustomEvent<ChatOpenRequest>(CHAT_OPEN_EVENT, { detail: request }));
}

/** Keep the note pin until the chat surface starts a new Dony thread. */
export function askAgent(ctx: ChatNoteContext): void {
  sessionStorage.setItem(key, JSON.stringify(ctx));
  openChat({ newThread: true });
}

export function consumeChatContext(): ChatNoteContext | null {
  const value = sessionStorage.getItem(key);
  sessionStorage.removeItem(key);
  if (!value) return null;
  try { return JSON.parse(value) as ChatNoteContext; } catch { return null; }
}
