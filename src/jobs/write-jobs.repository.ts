import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../common/tokens.js';
import type { Db } from '../db/index.js';
import type { WriteJob } from './write-job.types.js';

interface JobRow {
  id: string; user_id: number; source: WriteJob['source']; input: string;
  status: WriteJob['status']; summary: string | null; commits: string;
  merge_sha: string | null; error: string | null;
  created_at: string; started_at: string | null; finished_at: string | null;
}

function toJob(row: JobRow): WriteJob {
  return {
    id: row.id, userId: row.user_id, source: row.source, input: row.input,
    status: row.status, summary: row.summary, commits: JSON.parse(row.commits) as string[],
    mergeSha: row.merge_sha, error: row.error, createdAt: row.created_at,
    startedAt: row.started_at, finishedAt: row.finished_at,
  };
}

@Injectable()
export class WriteJobsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  enqueue(id: string, userId: number, input: string, createdAt: string): void {
    this.db.prepare(`
      INSERT INTO write_jobs (id, user_id, source, input, status, created_at)
      VALUES (?, ?, 'mcp', ?, 'queued', ?)
    `).run(id, userId, input, createdAt);
  }

  get(id: string): WriteJob | null {
    const row = this.db.prepare('SELECT * FROM write_jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  list(opts: { userId?: number; limit?: number; before?: string } = {}): WriteJob[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (opts.userId !== undefined) {
      clauses.push('user_id = ?');
      params.push(opts.userId);
    }
    if (opts.before) {
      const cursor = this.get(opts.before);
      if (cursor) {
        clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
        params.push(cursor.createdAt, cursor.createdAt, cursor.id);
      } else {
        clauses.push('created_at < ?');
        params.push(opts.before);
      }
    }
    const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(200, Math.trunc(opts.limit!))) : 50;
    params.push(limit);
    const rows = this.db.prepare(`
      SELECT * FROM write_jobs ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(...params) as JobRow[];
    return rows.map(toJob);
  }

  failInterrupted(error: string, finishedAt: string): void {
    this.db.prepare(`
      UPDATE write_jobs SET status = 'failed', error = ?, finished_at = ?
      WHERE status IN ('running', 'merging')
    `).run(error, finishedAt);
  }

  next(): WriteJob | null {
    const row = this.db.prepare(`
      SELECT * FROM write_jobs WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1
    `).get() as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  markRunning(id: string, startedAt: string): void {
    this.db.prepare("UPDATE write_jobs SET status = 'running', started_at = ? WHERE id = ?")
      .run(startedAt, id);
  }

  markMerging(id: string, summary: string, commits: string[]): void {
    this.db.prepare("UPDATE write_jobs SET summary = ?, commits = ?, status = 'merging' WHERE id = ?")
      .run(summary, JSON.stringify(commits), id);
  }

  recordMerge(id: string, commits: string[], mergeSha: string): void {
    this.db.prepare('UPDATE write_jobs SET commits = ?, merge_sha = ? WHERE id = ?')
      .run(JSON.stringify(commits), mergeSha, id);
  }

  recordCommits(id: string, commits: string[]): void {
    this.db.prepare('UPDATE write_jobs SET commits = ? WHERE id = ?')
      .run(JSON.stringify(commits), id);
  }

  markSucceeded(id: string, finishedAt: string): void {
    this.db.prepare("UPDATE write_jobs SET status = 'succeeded', finished_at = ? WHERE id = ?")
      .run(finishedAt, id);
  }

  markFailed(id: string, error: string, finishedAt: string): void {
    this.db.prepare("UPDATE write_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
      .run(error, finishedAt, id);
  }
}
