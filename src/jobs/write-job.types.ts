export type JobSource = 'mcp' | 'web' | 'chat' | 'dreaming' | 'import' | 'revert';
export type JobKind = 'agent' | 'direct' | 'revert';
export type JobPhase = 'queued' | 'preparing' | 'editing' | 'committing' | 'merging' | 'resolving_conflict' | 'indexing' | 'cleanup' | 'done' | 'failed';
export interface JobEvent {
  phase: JobPhase;
  at: string;
  detail: Record<string, unknown> | null;
}
export interface WriteJob {
  id: string; userId: number; kind: JobKind; source: JobSource; client: string | null; input: string;
  status: 'queued' | 'running' | 'merging' | 'succeeded' | 'failed';
  summary: string | null; commits: string[]; conflicts: string[]; mergeSha: string | null; error: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
}

export interface SubmitWriteJob {
  userId: number;
  input: string;
  source: JobSource;
  client?: string;
  sourcePaths?: string[];
  requiredReads?: string[];
  dedupeKey?: string;
}
export type SubmittedWriteJob = WriteJob & { reused: boolean };
