import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../common/tokens.js';
import type { Db } from '../db/index.js';
import type { JobEvent, JobKind, JobPhase, JobSource, WriteJob } from './write-job.types.js';

interface JobRow {
  id: string; user_id: number; kind: JobKind; source: JobSource; client: string | null; input: string; conflicts: string;
  status: WriteJob['status']; summary: string | null; commits: string;
  merge_sha: string | null; error: string | null;
  created_at: string; started_at: string | null; finished_at: string | null;
}

function toJob(row: JobRow): WriteJob {
  return {
    id: row.id, userId: row.user_id, kind: row.kind, source: row.source, client: row.client, input: row.input,
    conflicts: JSON.parse(row.conflicts) as string[],
    status: row.status, summary: row.summary, commits: JSON.parse(row.commits) as string[],
    mergeSha: row.merge_sha, error: row.error, createdAt: row.created_at,
    startedAt: row.started_at, finishedAt: row.finished_at,
  };
}

@Injectable()
export class WriteJobsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  enqueue(id: string, userId: number, input: string, createdAt: string, source: JobSource, client?: string, kind: JobKind = 'agent'): void {
    this.db.prepare(`
      INSERT INTO write_jobs (id, user_id, kind, source, client, input, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)
    `).run(id, userId, kind, source, client ?? null, input, createdAt);
  }

  addEvent(id: string, phase: JobPhase, detail: Record<string, unknown> | null = null, at = new Date().toISOString()): void {
    this.db.prepare('INSERT INTO write_job_events (job_id, phase, at, detail) VALUES (?, ?, ?, ?)')
      .run(id, phase, at, detail === null ? null : JSON.stringify(detail));
  }

  events(id: string): JobEvent[] {
    const rows = this.db.prepare('SELECT phase, at, detail FROM write_job_events WHERE job_id = ? ORDER BY seq')
      .all(id) as Array<{ phase: JobPhase; at: string; detail: string | null }>;
    return rows.map((row) => ({ ...row, detail: row.detail === null ? null : JSON.parse(row.detail) as Record<string, unknown> }));
  }

  recordConflicts(id: string, conflicts: string[]): void {
    this.db.prepare('UPDATE write_jobs SET conflicts = ? WHERE id = ?').run(JSON.stringify(conflicts), id);
  }

  cancelQueued(id: string, at: string): boolean {
    return this.db.prepare("UPDATE write_jobs SET status = 'failed', error = 'canceled', finished_at = ? WHERE id = ? AND status = 'queued'")
      .run(at, id).changes === 1;
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

  failInterrupted(error: string, finishedAt: string): WriteJob[] {
    const interrupted = this.db.prepare("SELECT * FROM write_jobs WHERE status IN ('running', 'merging')").all() as JobRow[];
    this.db.prepare(`
      UPDATE write_jobs SET status = 'failed', error = ?, finished_at = ?
      WHERE status IN ('running', 'merging')
    `).run(error, finishedAt);
    return interrupted.map(toJob);
  }

  next(): WriteJob | null {
    const row = this.db.prepare(`
      SELECT * FROM write_jobs WHERE status = 'queued' AND kind = 'agent' ORDER BY created_at, rowid LIMIT 1
    `).get() as JobRow | undefined;
    return row ? toJob(row) : null;
  }
  queuedDirect(): WriteJob[] {
    return (this.db.prepare("SELECT * FROM write_jobs WHERE status = 'queued' AND kind <> 'agent' ORDER BY created_at, rowid").all() as JobRow[]).map(toJob);
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
