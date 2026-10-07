import { Inject, Injectable } from '@nestjs/common';
import type { Db } from '../db/index.js';
import { DB } from '../common/tokens.js';

export interface AuditRecord {
  actorId: number | null;
  action: string;
  target: string;
  outcome: string;
  summary?: string;
}

export interface AuditEvent extends Omit<AuditRecord, 'summary'> {
  id: number;
  summary: string | null;
  createdAt: string;
}

export interface AuditQuery {
  before?: number;
  limit: number;
  actor?: number;
  action?: string;
}

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Db) {}

  record(input: AuditRecord): void {
    this.db.prepare(`INSERT INTO audit_events (actor_id, action, target, outcome, summary, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      input.actorId, input.action, input.target, input.outcome, input.summary ?? null, new Date().toISOString(),
    );
  }

  list(query: AuditQuery): { events: AuditEvent[]; nextCursor: string | null } {
    const predicates: string[] = [];
    const values: Array<string | number> = [];
    if (query.before !== undefined) { predicates.push('id < ?'); values.push(query.before); }
    if (query.actor !== undefined) { predicates.push('actor_id = ?'); values.push(query.actor); }
    if (query.action !== undefined) { predicates.push('action = ?'); values.push(query.action); }
    const where = predicates.length ? `WHERE ${predicates.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT id, actor_id AS actorId, action, target, outcome, summary,
      created_at AS createdAt FROM audit_events ${where} ORDER BY id DESC LIMIT ?`)
      .all(...values, query.limit + 1) as AuditEvent[];
    const hasMore = rows.length > query.limit;
    if (hasMore) rows.pop();
    return { events: rows, nextCursor: hasMore ? String(rows[rows.length - 1]!.id) : null };
  }
}
