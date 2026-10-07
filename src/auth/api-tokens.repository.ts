import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../common/tokens.js';
import type { Db } from '../db/index.js';

export interface ApiTokenRow {
  id: string;
  user_id: number;
  name: string;
  token_hash: string;
  scopes: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

@Injectable()
export class ApiTokensRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  insert(row: ApiTokenRow): void {
    this.db.prepare(`INSERT INTO api_tokens
      (id,user_id,name,token_hash,scopes,created_at,expires_at,last_used_at,revoked_at)
      VALUES (@id,@user_id,@name,@token_hash,@scopes,@created_at,@expires_at,@last_used_at,@revoked_at)`).run(row);
  }

  list(userId?: number): ApiTokenRow[] {
    return (userId === undefined
      ? this.db.prepare('SELECT * FROM api_tokens ORDER BY created_at DESC, id').all()
      : this.db.prepare('SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC, id').all(userId)) as ApiTokenRow[];
  }

  get(id: string): ApiTokenRow | undefined {
    return this.db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(id) as ApiTokenRow | undefined;
  }

  byHash(tokenHash: string): ApiTokenRow | undefined {
    return this.db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').get(tokenHash) as ApiTokenRow | undefined;
  }

  touch(id: string, now: string): void {
    this.db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now, id);
  }

  revoke(id: string, now: string): void {
    this.db.prepare('UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(now, id);
  }
}
