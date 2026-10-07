export interface WriteJob {
  id: string; userId: number; source: 'mcp' | 'dreaming'; input: string;
  status: 'queued' | 'running' | 'merging' | 'succeeded' | 'failed';
  summary: string | null; commits: string[]; mergeSha: string | null; error: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
}
