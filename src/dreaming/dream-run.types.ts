export interface DreamRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'succeeded' | 'failed';
  fromSha: string | null;
  toSha: string | null;
  mergeSha: string | null;
  pushed: boolean;
  summary: string | null;
  changedPaths: string[];
  journalPath: string | null;
  push: {
    status: 'pending' | 'succeeded' | 'skipped' | 'failed';
    remote: string | null;
    sha: string | null;
    at: string | null;
    reason: string | null;
  };
  error: string | null;
}

export interface DreamUserMessage {
  id: string;
  conversation_id: string;
  content: string;
  created_at: string;
}
