import { Inject, Injectable } from '@nestjs/common';
import { fromStorageId, toStorageId } from '../common/ids.js';
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

function toApiRow(row: ApiTokenRow): ApiTokenRow {
  return { ...row, id: fromStorageId(row.id) };
}

@Injectable()
export class ApiTokensRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  insert(row: ApiTokenRow): void {
    this.db.prepare(`INSERT INTO api_tokens
      (id,user_id,name,token_hash,scopes,created_at,expires_at,last_used_at,revoked_at)
      VALUES (@id,@user_id,@name,@token_hash,@scopes,@created_at,@expires_at,@last_used_at,@revoked_at)`).run({ ...row, id: toStorageId(row.id) });
  }

  list(userId?: number): ApiTokenRow[] {
    return ((userId === undefined
      ? this.db.prepare('SELECT * FROM api_tokens ORDER BY created_at DESC, id').all()
      : this.db.prepare('SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC, id').all(userId)) as ApiTokenRow[]).map(toApiRow);
  }

  get(id: string): ApiTokenRow | undefined {
    const row = this.db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(toStorageId(id)) as ApiTokenRow | undefined;
    return row ? toApiRow(row) : undefined;
  }

  byHash(tokenHash: string): ApiTokenRow | undefined {
    const row = this.db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?').get(tokenHash) as ApiTokenRow | undefined;
    return row ? toApiRow(row) : undefined;
  }

  touch(id: string, now: string): void {
    this.db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(now, toStorageId(id));
  }

  revoke(id: string, now: string): void {
    this.db.prepare('UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(now, toStorageId(id));
  }
}
