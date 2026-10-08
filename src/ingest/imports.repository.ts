import { Inject, Injectable } from '@nestjs/common';
import { fromStorageId, toStorageId } from '../common/ids.js';
import { DB } from '../common/tokens.js';
import type { Db } from '../db/index.js';
import type { ImportKind, ImportRecord } from './ingest.types.js';
interface ImportRow {
  id: string; user_id: number; kind: ImportKind; source: string; sha: string | null;
  status: ImportRecord['status']; raw_paths: string; job_id: string | null; error: string | null;
  created_at: string; updated_at: string; finished_at: string | null;
}
function record(row: ImportRow): ImportRecord {
  return { id: fromStorageId(row.id), userId: row.user_id, kind: row.kind, source: row.source, sha: row.sha,
    status: row.status, rawPaths: JSON.parse(row.raw_paths) as string[], jobId: row.job_id === null ? null : fromStorageId(row.job_id), error: row.error,
    createdAt: row.created_at, updatedAt: row.updated_at, finishedAt: row.finished_at };
}
@Injectable()
export class ImportsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}
  create(id: string, userId: number, kind: ImportKind, source: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO imports (id,user_id,kind,source,status,created_at,updated_at) VALUES (?,?,?,?,'extracting',?,?)`).run(toStorageId(id), userId, kind, source, now, now);
  }
  extracted(id: string, sha: string, paths: string[]): void {
    this.db.prepare('UPDATE imports SET sha=?, raw_paths=?, updated_at=? WHERE id=?').run(sha, JSON.stringify(paths), new Date().toISOString(), toStorageId(id));
  }
  queued(id: string, jobId: string): void {
    this.db.prepare("UPDATE imports SET status='queued', job_id=?, error=NULL, finished_at=NULL, updated_at=? WHERE id=?").run(toStorageId(jobId), new Date().toISOString(), toStorageId(id));
  }
  update(id: string, status: ImportRecord['status'], error: string | null = null): void {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE imports SET status=?,error=?,updated_at=?,finished_at=? WHERE id=? AND (status<>? OR error IS NOT ?)').run(status, error, now, ['succeeded','failed','cancelled'].includes(status) ? now : null, toStorageId(id), status, error);
  }
  get(id: string): ImportRecord | null {
    const row = this.db.prepare('SELECT * FROM imports WHERE id=?').get(toStorageId(id)) as ImportRow | undefined;
    return row ? record(row) : null;
  }
  pending(): ImportRecord[] {
    return (this.db.prepare("SELECT * FROM imports WHERE status IN ('extracting','queued','running') OR (status='failed' AND job_id IS NOT NULL)").all() as ImportRow[]).map(record);
  }
  forJob(jobId: string): ImportRecord[] {
    return (this.db.prepare('SELECT * FROM imports WHERE job_id=?').all(toStorageId(jobId)) as ImportRow[]).map(record);
  }
  latestRetryJobId(jobId: string, userId: number): string | null {
    const row = this.db.prepare(`
      SELECT jobs.id FROM write_job_events events
      JOIN write_jobs jobs ON jobs.id=events.job_id
      WHERE events.phase='queued' AND json_extract(events.detail, '$.retryOf')=?
        AND jobs.user_id=? AND jobs.kind='agent' AND jobs.source='import'
      ORDER BY events.seq DESC LIMIT 1
    `).get(jobId, userId) as { id: string } | undefined;
    return row ? fromStorageId(row.id) : null;
  }
  list(opts: { userId?: number; limit?: number; before?: string }): ImportRecord[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (opts.userId !== undefined) { clauses.push('user_id=?'); params.push(opts.userId); }
    if (opts.before) {
      const cursor = this.get(opts.before);
      if (!cursor || (opts.userId !== undefined && cursor.userId !== opts.userId)) return [];
      clauses.push('(created_at<? OR (created_at=? AND id<?))'); params.push(cursor.createdAt, cursor.createdAt, toStorageId(cursor.id)!);
    }
    params.push(Math.max(1, Math.min(100, opts.limit ?? 50)));
    return (this.db.prepare(`SELECT * FROM imports ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC,id DESC LIMIT ?`).all(...params) as ImportRow[]).map(record);
  }
}
