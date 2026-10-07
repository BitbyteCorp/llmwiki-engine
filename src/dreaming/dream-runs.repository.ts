import { Inject, Injectable } from '@nestjs/common';
import type Database from 'better-sqlite3';
import { DB } from '../common/tokens.js';
import type { DreamRun, DreamUserMessage } from './dream-run.types.js';

@Injectable()
export class DreamRunsRepository {
  constructor(@Inject(DB) private readonly db: Database.Database) {}

  create(run: DreamRun): void {
    this.db.prepare('INSERT INTO dream_runs (id, started_at, status) VALUES (?, ?, ?)')
      .run(run.id, run.startedAt, run.status);
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
      WHERE id = ? AND role = 'user' AND learned_at IS NULL`);
    this.db.transaction(() => {
      for (const message of messages) mark.run(learnedAt, message.id);
    })();
  }

  finish(run: DreamRun): void {
    this.db.prepare(`UPDATE dream_runs SET finished_at = ?, status = ?, from_sha = ?, to_sha = ?,
      merge_sha = ?, pushed = ?, error = ? WHERE id = ?`)
      .run(run.finishedAt, run.status, run.fromSha, run.toSha, run.mergeSha, Number(run.pushed), run.error, run.id);
  }
}
