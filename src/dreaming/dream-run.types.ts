export interface DreamRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'succeeded' | 'failed';
  fromSha: string | null;
  toSha: string | null;
  mergeSha: string | null;
  pushed: boolean;
  error: string | null;
}

export interface DreamUserMessage {
  id: string;
  conversation_id: string;
  content: string;
  created_at: string;
}
