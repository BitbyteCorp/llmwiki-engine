import { Inject, Injectable } from '@nestjs/common';
import type { Statement } from 'better-sqlite3';
import { DB } from '../common/tokens.js';
import type { Db } from '../db/index.js';
import type { AgentCheckpoint } from './agent.types.js';

@Injectable()
export class AgentCheckpointsRepository {
  private readonly saveCheckpoint: Statement<[string, string, string]>;
  private readonly getCheckpoint: Statement<[string], { data: string }>;
  private readonly deleteCheckpoint: Statement<[string]>;
  private readonly copyCheckpoint: Statement<[string, string, string]>;

  constructor(@Inject(DB) db: Db) {
    this.saveCheckpoint = db.prepare(`INSERT INTO agent_checkpoints(owner, data, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(owner) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`);
    this.getCheckpoint = db.prepare('SELECT data FROM agent_checkpoints WHERE owner = ?');
    this.deleteCheckpoint = db.prepare('DELETE FROM agent_checkpoints WHERE owner = ?');
    this.copyCheckpoint = db.prepare(`INSERT INTO agent_checkpoints(owner, data, updated_at)
      SELECT ?, data, ? FROM agent_checkpoints WHERE owner = ?
      ON CONFLICT(owner) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at`);
  }

  save<T extends AgentCheckpoint>(owner: string, checkpoint: T): void {
    this.saveCheckpoint.run(owner, JSON.stringify(checkpoint), new Date().toISOString());
  }

  get<T extends AgentCheckpoint = AgentCheckpoint>(owner: string): T | undefined {
    const row = this.getCheckpoint.get(owner);
    return row ? JSON.parse(row.data) as T : undefined;
  }

  delete(owner: string): void {
    this.deleteCheckpoint.run(owner);
  }

  copy(from: string, to: string): boolean {
    return this.copyCheckpoint.run(to, new Date().toISOString(), from).changes > 0;
  }
}
