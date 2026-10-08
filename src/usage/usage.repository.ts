import { Inject, Injectable } from '@nestjs/common';
import type { Statement } from 'better-sqlite3';
import { DB } from '../common/tokens.js';
import type { Db } from '../db/index.js';

export interface UsageEntry {
  lane: string;
  model: string;
  /** Opaque, prefixed API references (for example user:42 or job:<base62-id>).
   * These are not foreign keys and must not undergo SQLite identifier conversion. */
  owner?: string | null;
  ref?: string | null;
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface UsageRow {
  day: string;
  lane: string;
  model: string;
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

const DAY_MS = 86_400_000;

@Injectable()
export class UsageRepository {
  private readonly insert: Statement;
  private readonly prune: Statement;
  private readonly totals: Statement<[string, string], UsageRow>;

  constructor(@Inject(DB) private readonly db: Db) {
    this.insert = db.prepare(`INSERT INTO llm_usage
      (at,lane,model,owner,ref,input,cached_input,output,reasoning) VALUES (?,?,?,?,?,?,?,?,?)`);
    this.prune = db.prepare('DELETE FROM llm_usage WHERE at < ?');
    this.totals = db.prepare(`SELECT substr(at,1,10) AS day,lane,model,COUNT(*) AS calls,
      SUM(input) AS inputTokens,SUM(cached_input) AS cachedInputTokens,
      SUM(output) AS outputTokens,SUM(reasoning) AS reasoningTokens
      FROM llm_usage WHERE at >= ? AND at < ? GROUP BY day,lane,model ORDER BY day DESC,lane,model`);
  }

  record(entry: UsageEntry, now = new Date()): void {
    this.db.transaction(() => {
      this.prune.run(new Date(now.getTime() - 90 * DAY_MS).toISOString());
      this.insert.run(now.toISOString(), entry.lane, entry.model, entry.owner ?? null, entry.ref ?? null,
        entry.inputTokens, entry.cachedInputTokens ?? 0, entry.outputTokens, entry.reasoningTokens);
    })();
  }

  aggregate(days: number, now = new Date()): UsageRow[] {
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return this.totals.all(new Date(today - (days - 1) * DAY_MS).toISOString(),
      new Date(today + DAY_MS).toISOString());
  }
}
