'use client';

export interface ChatNoteContext { notePath: string; ref?: string; selection?: string }
const key = 'llmwiki.luna.pending-context';

/** Keep the note pin when navigating from a reader to a new Luna thread. */
export function askLuna(ctx: ChatNoteContext): void {
  sessionStorage.setItem(key, JSON.stringify(ctx));
  window.location.assign('/chat?new=1');
}

export function consumeChatContext(): ChatNoteContext | null {
  const value = sessionStorage.getItem(key);
  sessionStorage.removeItem(key);
  if (!value) return null;
  try { return JSON.parse(value) as ChatNoteContext; } catch { return null; }
}
