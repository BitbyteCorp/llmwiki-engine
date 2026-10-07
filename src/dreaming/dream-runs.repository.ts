import { Inject, Injectable } from '@nestjs/common';
import type Database from 'better-sqlite3';
import { DB } from '../common/tokens.js';
import type { DreamRun, DreamUserMessage } from './dream-run.types.js';

interface DreamRunRow {
  id: string; started_at: string; finished_at: string | null; status: DreamRun['status'];
  from_sha: string | null; to_sha: string | null; merge_sha: string | null;
  pushed: number; error: string | null; summary: string | null;
  changed_paths: string; journal_path: string | null;
  push_status: DreamRun['push']['status']; push_remote: string | null;
  push_sha: string | null; push_at: string | null; push_reason: string | null;
}

function toRun(row: DreamRunRow): DreamRun {
  return {
    id: row.id, startedAt: row.started_at, finishedAt: row.finished_at, status: row.status,
    fromSha: row.from_sha, toSha: row.to_sha, mergeSha: row.merge_sha,
    pushed: Boolean(row.pushed), error: row.error, summary: row.summary,
    changedPaths: JSON.parse(row.changed_paths) as string[], journalPath: row.journal_path,
    push: { status: row.push_status, remote: row.push_remote, sha: row.push_sha,
      at: row.push_at, reason: row.push_reason },
  };
}

@Injectable()
export class DreamRunsRepository {
  constructor(@Inject(DB) private readonly db: Database.Database) {}

  create(run: DreamRun): void {
    this.db.prepare('INSERT INTO dream_runs (id, started_at, status) VALUES (?, ?, ?)')
      .run(run.id, run.startedAt, run.status);
  }

  get(id: string): DreamRun | null {
    const row = this.db.prepare('SELECT * FROM dream_runs WHERE id = ?').get(id) as DreamRunRow | undefined;
    return row ? toRun(row) : null;
  }

  list(opts: { before?: string; limit?: number } = {}): DreamRun[] {
    const params: Array<string | number> = [];
    let where = '';
    if (opts.before) {
      const cursor = this.get(opts.before);
      if (cursor) {
        where = 'WHERE (started_at < ? OR (started_at = ? AND id < ?))';
        params.push(cursor.startedAt, cursor.startedAt, cursor.id);
      } else {
        where = 'WHERE started_at < ?';
        params.push(opts.before);
      }
    }
    const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(200, Math.trunc(opts.limit!))) : 50;
    const rows = this.db.prepare(`SELECT * FROM dream_runs ${where} ORDER BY started_at DESC, id DESC LIMIT ?`)
      .all(...params, limit) as DreamRunRow[];
    return rows.map(toRun);
  }

  latest(): DreamRun | null {
    return this.list({ limit: 1 })[0] ?? null;
  }

  running(): DreamRun | null {
    const row = this.db.prepare(`SELECT * FROM dream_runs WHERE status = 'running'
      ORDER BY started_at DESC, id DESC LIMIT 1`).get() as DreamRunRow | undefined;
    return row ? toRun(row) : null;
  }

  backupStatus(): { lastAttempt: DreamRun | null; lastSuccess: DreamRun | null } {
    const attempt = this.db.prepare(`SELECT * FROM dream_runs WHERE push_at IS NOT NULL
      ORDER BY push_at DESC, rowid DESC LIMIT 1`).get() as DreamRunRow | undefined;
    const success = this.db.prepare(`SELECT * FROM dream_runs WHERE push_status = 'succeeded'
      ORDER BY push_at DESC, rowid DESC LIMIT 1`).get() as DreamRunRow | undefined;
    return { lastAttempt: attempt ? toRun(attempt) : null, lastSuccess: success ? toRun(success) : null };
  }

  lastSuccessfulCheckpoint(): string | undefined {
    const row = this.db.prepare(`SELECT to_sha FROM dream_runs
      WHERE status = 'succeeded' AND to_sha IS NOT NULL
      ORDER BY finished_at DESC, rowid DESC LIMIT 1`).get() as { to_sha: string } | undefined;
    return row?.to_sha;
  }

  setInputRange(run: DreamRun): void {
    this.db.prepare('UPDATE dream_runs SET from_sha = ?, to_sha = ? WHERE id = ?')
      .run(run.fromSha, run.toSha, run.id);
  }

  unlearnedUserMessages(startedAt: string): DreamUserMessage[] {
    return this.db.prepare(`SELECT id, conversation_id, content, created_at FROM messages
      WHERE role = 'user' AND learned_at IS NULL AND created_at <= ?
      ORDER BY created_at, id`).all(startedAt) as DreamUserMessage[];
  }

  markLearned(messages: readonly DreamUserMessage[], learnedAt: string): void {
    const mark = this.db.prepare(`UPDATE messages SET learned_at = ?
      WHERE id = ? AND content = ? AND role = 'user' AND learned_at IS NULL`);
    this.db.transaction(() => {
      for (const message of messages) mark.run(learnedAt, message.id, message.content);
    })();
  }

  finish(run: DreamRun): void {
    this.db.prepare(`UPDATE dream_runs SET finished_at = ?, status = ?, from_sha = ?, to_sha = ?,
      merge_sha = ?, pushed = ?, error = ?, summary = ?, changed_paths = ?, journal_path = ?,
      push_status = ?, push_remote = ?, push_sha = ?, push_at = ?, push_reason = ? WHERE id = ?`)
      .run(run.finishedAt, run.status, run.fromSha, run.toSha, run.mergeSha, Number(run.pushed), run.error,
        run.summary, JSON.stringify(run.changedPaths), run.journalPath, run.push.status, run.push.remote,
        run.push.sha, run.push.at, run.push.reason, run.id);
  }
}
