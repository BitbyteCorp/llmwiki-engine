import type { Citation, TokenUsage } from '../agent/agent.types.js';

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  role?: 'owner' | 'editor' | 'viewer';
  snippet?: string;
}
export interface MessageContext { notePath: string; ref?: string; selection?: string }
export type Usage = TokenUsage;
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: Citation[];
  attachments: string[];
  context: MessageContext | null;
  status: 'completed' | 'running' | 'failed' | 'cancelled' | 'interrupted';
  usage: Usage | null;
  model: string | null;
  effort: string | null;
  generationId?: string | null;
  resumable?: boolean;
  createdAt: string;
}
export interface SubmitMessage {
  content: string;
  attachments?: string[];
  context?: MessageContext;
  clientId?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high';
}
