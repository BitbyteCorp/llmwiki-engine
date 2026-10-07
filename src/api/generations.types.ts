export type GenerationEvent = 'generation' | 'status' | 'tool' | 'citation' | 'delta' | 'usage' | 'done' | 'error';
export type GenerationStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export interface Generation {
  id: string;
  conversationId: string;
  userMessageId: string | null;
  assistantMessageId: string | null;
  userId: number;
  clientId: string | null;
  status: GenerationStatus;
  model: string | null;
  effort: string | null;
  createdAt: string;
  finishedAt: string | null;
}
