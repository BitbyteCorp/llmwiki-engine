import { Inject, Injectable } from '@nestjs/common';
import { ApiError, notFound } from '../api/api-error.js';
import type { User } from '../auth/users.types.js';
import { DB } from '../common/tokens.js';
import type { Db } from '../db/index.js';
import type { DreamRun } from '../dreaming/dream-run.types.js';
import { DreamRunsRepository } from '../dreaming/dream-runs.repository.js';
import { KnowledgeRepo, type CommitInfo } from '../knowledge/repo.js';
import type { WriteJob } from '../jobs/write-job.types.js';

export type ActivityKind = 'commit' | 'job' | 'dream' | 'backup';
export interface ActivityQuery { before?: string; limit: number; path?: string; source?: string; type?: ActivityKind }
export interface ActivityItem {
  id: string;
  type: ActivityKind;
  at: string;
  source: string;
  paths: string[];
  summary: string | null;
  commit?: CommitInfo;
  job?: Omit<WriteJob, 'input' | 'error'> & { input?: string; error?: string | null };
  dream?: DreamRun;
  push?: DreamRun['push'];
}
interface Cursor { at: string; type: ActivityKind; id: string }
interface JobRow {
  id: string; user_id: number; kind: WriteJob['kind']; source: WriteJob['source']; client: string | null;
  input: string | null; status: WriteJob['status']; summary: string | null; commits: string; conflicts: string;
  merge_sha: string | null; error: string | null; created_at: string; started_at: string | null; finished_at: string | null;
}
const kinds: ActivityKind[] = ['commit', 'job', 'dream', 'backup'];
// Binary comparison matches SQLite's default text collation, including ID ties.
function compare(a: Cursor, b: Cursor): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  if (a.type !== b.type) return a.type < b.type ? 1 : -1;
  return a.id === b.id ? 0 : a.id < b.id ? 1 : -1;
}

export function decodeActivityCursor(value: string): Cursor {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(decoded) || decoded.length !== 3) throw new Error();
    const [at, type, id] = decoded as unknown[];
    if (typeof at !== 'string' || !Number.isFinite(Date.parse(at)) || typeof type !== 'string' || !kinds.includes(type as ActivityKind) || typeof id !== 'string' || !id) throw new Error();
    return { at: new Date(at).toISOString(), type: type as ActivityKind, id };
  } catch {
    throw new ApiError(400, 'invalid_cursor', 'Invalid activity cursor');
  }
}

@Injectable()
export class ActivityService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly repo: KnowledgeRepo,
    private readonly dreams: DreamRunsRepository,
  ) {}

  listDreams(query: { before?: string; limit: number }) {
    if (query.before && !this.dreams.get(query.before)) notFound('Dream run cursor not found');
    const runs = this.dreams.list({ ...query, limit: query.limit + 1 });
    const hasMore = runs.length > query.limit;
    if (hasMore) runs.pop();
    return { runs, nextCursor: hasMore ? runs.at(-1)!.id : null };
  }

  getDream(id: string): DreamRun {
    return this.dreams.get(id) ?? notFound('Dream run not found');
  }

  private allDreams(): DreamRun[] {
    const result: DreamRun[] = [];
    let before: string | undefined;
    for (;;) {
      const runs = this.dreams.list({ before, limit: 100 });
      result.push(...runs);
      if (runs.length < 100) return result;
      before = runs.at(-1)!.id;
    }
  }

  async journal() {
    const runs = this.allDreams();
    const links = new Map<string, string>();
    // Repository order is newest run first; repeated manual runs keep the newest association.
    for (const run of runs) {
      if (run.mergeSha && run.journalPath && run.changedPaths.includes(run.journalPath) && !links.has(run.journalPath)) {
        links.set(run.journalPath, run.id);
      }
    }
    return (await this.repo.listFiles('journal/'))
      .filter((path) => /^journal\/\d{4}-\d{2}-\d{2}\.md$/.test(path))
      .sort().reverse()
      .map((path) => ({ date: path.slice(8, 18), path, dreamRunId: links.get(path) ?? null }));
  }

  async list(query: ActivityQuery, user: User): Promise<{ items: ActivityItem[]; nextCursor: string | null }> {
    const cursor = query.before ? decodeActivityCursor(query.before) : null;
    const items: ActivityItem[] = [];
    const accept = (item: ActivityItem) => {
      if (query.type && item.type !== query.type) return;
      if (query.source && item.source !== query.source) return;
      if (query.path && !item.paths.includes(query.path)) return;
      if (cursor && compare(item, cursor) <= 0) return;
      let low = 0;
      let high = items.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (compare(items[middle]!, item) < 0) low = middle + 1;
        else high = middle;
      }
      if (low > query.limit) return;
      items.splice(low, 0, item);
      if (items.length > query.limit + 1) items.pop();
    };
    // Git dates need not be monotonic in ancestry order (and ties cross sources).
    // An uncapped log is necessary to avoid silently losing older or merge-side history.
    const commits = (!query.type || query.type === 'commit' || (query.type === 'job' && query.path))
      ? await this.repo.log(query.path, { limit: null }) : [];
    const pathCommits = new Set<string>();
    const pathJobIds = new Set<string>();
    for (const commit of commits) {
      if (query.path) {
        pathCommits.add(commit.sha);
        const jobId = commit.trailers['Wiki-Job'];
        if (jobId) pathJobIds.add(jobId);
      }
      if (!query.type || query.type === 'commit') {
        accept({ id: commit.sha, type: 'commit', at: new Date(commit.committedAt).toISOString(),
          source: commit.trailers['Wiki-Source'] ?? 'git', paths: query.path ? [query.path] : [], summary: commit.subject, commit });
      }
    }
    if (!query.type || query.type === 'job') {
      const clauses: string[] = [];
      const values: Array<string | number> = [user.id, user.role === 'admin' ? 1 : 0, user.id, user.role === 'admin' ? 1 : 0];
      if (cursor) {
        clauses.push('(created_at < ? OR (created_at = ? AND (? > \'job\' OR (? = \'job\' AND id < ?))))');
        values.push(cursor.at, cursor.at, cursor.type, cursor.type, cursor.id);
      }
      if (query.source) { clauses.push('source = ?'); values.push(query.source); }
      if (query.path) {
        clauses.push('(id IN (SELECT value FROM json_each(?)) OR merge_sha IN (SELECT value FROM json_each(?)) OR EXISTS (SELECT 1 FROM json_each(write_jobs.commits) WHERE value IN (SELECT value FROM json_each(?))))');
        const pathCommitJson = JSON.stringify([...pathCommits]);
        values.push(JSON.stringify([...pathJobIds]), pathCommitJson, pathCommitJson);
      }
      const rows = this.db.prepare(`SELECT id, user_id, kind, source, client, status, summary, commits, conflicts,
        merge_sha, created_at, started_at, finished_at,
        CASE WHEN user_id = ? OR ? = 1 THEN input ELSE NULL END AS input,
        CASE WHEN user_id = ? OR ? = 1 THEN error ELSE NULL END AS error
        FROM write_jobs ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
        ORDER BY created_at DESC, id DESC LIMIT ?`).all(...values, query.limit + 1) as JobRow[];
      for (const row of rows) {
        const privileged = row.user_id === user.id || user.role === 'admin';
        const job: ActivityItem['job'] = { id: row.id, userId: row.user_id, kind: row.kind, source: row.source,
          client: row.client, status: row.status, summary: row.summary, commits: JSON.parse(row.commits) as string[],
          conflicts: JSON.parse(row.conflicts) as string[], mergeSha: row.merge_sha, createdAt: row.created_at,
          startedAt: row.started_at, finishedAt: row.finished_at,
          ...(privileged ? { input: row.input!, error: row.error } : {}) };
        accept({ id: row.id, type: 'job', at: row.created_at, source: row.source,
          paths: query.path ? [query.path] : [], summary: row.summary, job });
      }
    }
    if (!query.type || query.type === 'dream' || query.type === 'backup') {
      for (const dream of this.allDreams()) {
        accept({ id: dream.id, type: 'dream', at: dream.startedAt, source: 'dreaming', paths: dream.changedPaths, summary: dream.summary, dream });
        if (dream.push.status !== 'pending') accept({ id: dream.id, type: 'backup', at: dream.push.at ?? dream.finishedAt ?? dream.startedAt,
          source: 'dreaming', paths: dream.changedPaths, summary: dream.push.reason, push: dream.push });
      }
    }
    const hasMore = items.length > query.limit;
    if (hasMore) items.pop();
    const last = items.at(-1);
    const nextCursor = hasMore && last ? Buffer.from(JSON.stringify([last.at, last.type, last.id])).toString('base64url') : null;
    return { items, nextCursor };
  }

  opsJobs() {
    const queue = this.db.prepare(`SELECT
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status IN ('running', 'merging') THEN 1 ELSE 0 END) AS running,
      MIN(CASE WHEN status = 'queued' THEN created_at END) AS oldestQueuedAt FROM write_jobs`)
      .get() as { queued: number | null; running: number | null; oldestQueuedAt: string | null };
    const failedJobs = this.db.prepare(`SELECT id, user_id AS userId, kind, source, client, status, summary,
      error, merge_sha AS mergeSha, created_at AS createdAt, started_at AS startedAt, finished_at AS finishedAt
      FROM write_jobs WHERE status = 'failed' ORDER BY finished_at DESC, id DESC LIMIT 20`).all();
    return { queue: { ...queue, queued: queue.queued ?? 0, running: queue.running ?? 0 }, failedJobs };
  }
}
