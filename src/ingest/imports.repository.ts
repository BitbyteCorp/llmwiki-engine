import { Inject, Injectable } from '@nestjs/common';
import { fromStorageId, toStorageId } from '../common/ids.js';
import { DB } from '../common/tokens.js';
import type { Db } from '../db/index.js';
import type { ImportJob, ImportKind, ImportRecord } from './ingest.types.js';
interface ImportRow {
  id: string; user_id: number; kind: ImportKind; source: string; sha: string | null;
  status: ImportRecord['status']; raw_paths: string; error: string | null;
  created_at: string; updated_at: string; finished_at: string | null;
}
function record(row: ImportRow, jobs: ImportJob[]): ImportRecord {
  return { id: fromStorageId(row.id), userId: row.user_id, kind: row.kind, source: row.source, sha: row.sha,
    status: row.status, rawPaths: JSON.parse(row.raw_paths) as string[], jobs, error: row.error,
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
  submitted(id: string, jobs: { jobId: string; files: string[] }[]): void {
    this.db.transaction(() => {
      const insert = this.db.prepare('INSERT INTO import_jobs (import_id,batch,job_id,files) VALUES (?,?,?,?)');
      jobs.forEach((job, batch) => insert.run(toStorageId(id), batch, toStorageId(job.jobId), JSON.stringify(job.files)));
      this.db.prepare("UPDATE imports SET status='queued',error=NULL,finished_at=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(), toStorageId(id));
    })();
  }
  relink(id: string, batch: number, previousJobId: string, jobId: string): void {
    this.db.prepare('UPDATE import_jobs SET job_id=? WHERE import_id=? AND batch=? AND job_id=?')
      .run(toStorageId(jobId), toStorageId(id), batch, toStorageId(previousJobId));
  }
  private jobs(id: string): ImportJob[] {
    const rows = this.db.prepare(`
      SELECT batches.batch,batches.job_id,batches.files,jobs.status,jobs.error
      FROM import_jobs batches LEFT JOIN write_jobs jobs ON jobs.id=batches.job_id
      WHERE batches.import_id=? ORDER BY batches.batch
    `).all(toStorageId(id)) as Array<{ batch: number; job_id: string; files: string; status: ImportJob['status'] | 'merging' | null; error: string | null }>;
    return rows.map((row) => ({
      batch: row.batch, jobId: fromStorageId(row.job_id),
      status: row.status === 'merging' ? 'running' : row.status ?? 'failed',
      error: row.status === null ? 'Integration job no longer exists' : row.error,
      files: (JSON.parse(row.files) as string[]).length,
    }));
  }
  private record(row: ImportRow): ImportRecord {
    return record(row, this.jobs(fromStorageId(row.id)));
  }
  update(id: string, status: ImportRecord['status'], error: string | null = null): void {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE imports SET status=?,error=?,updated_at=?,finished_at=? WHERE id=? AND (status<>? OR error IS NOT ?)').run(status, error, now, ['succeeded','failed','cancelled'].includes(status) ? now : null, toStorageId(id), status, error);
  }
  get(id: string): ImportRecord | null {
    const row = this.db.prepare('SELECT * FROM imports WHERE id=?').get(toStorageId(id)) as ImportRow | undefined;
    return row ? this.record(row) : null;
  }
  pending(): ImportRecord[] {
    return (this.db.prepare("SELECT * FROM imports WHERE status IN ('extracting','queued','running') OR (status='failed' AND EXISTS (SELECT 1 FROM import_jobs WHERE import_id=imports.id))").all() as ImportRow[]).map((row) => this.record(row));
  }
  forJob(jobId: string): { import: ImportRecord; batch: number }[] {
    const rows = this.db.prepare('SELECT imports.*,import_jobs.batch FROM imports JOIN import_jobs ON imports.id=import_jobs.import_id WHERE import_jobs.job_id=?')
      .all(toStorageId(jobId)) as Array<ImportRow & { batch: number }>;
    return rows.map((row) => ({ import: this.record(row), batch: row.batch }));
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
    return (this.db.prepare(`SELECT * FROM imports ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at DESC,id DESC LIMIT ?`).all(...params) as ImportRow[]).map((row) => this.record(row));
  }
}
