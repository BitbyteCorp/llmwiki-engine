import type { WriteJob } from '../jobs/write-job.types.js';
export type WikiEvent =
  | { type: 'job.updated'; jobId: string; userId: number; status: WriteJob['status']; phase?: string }
  | { type: 'main.updated'; sha: string; paths: string[]; jobId?: string }
  | { type: 'index.updated'; sha: string | null; status: 'syncing' | 'ready' | 'error' }
  | { type: 'dream.updated'; runId: string; status: string }
  | { type: 'conversation.updated'; conversationId: string; messageId?: string }
  | { type: 'conversation.presence'; conversationId: string; users: Array<{ id: number; name: string; typing: boolean }> };
/** 'all' = every authenticated session. userIds = only those users; admins=true also delivers to every admin. */
export type EventAudience = 'all' | { userIds: number[]; admins?: boolean };
