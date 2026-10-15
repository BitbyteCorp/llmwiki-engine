import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../common/tokens.js';
import type { Db } from '../db/index.js';

export interface CodexCredentialRow {
  access_token: string;
  refresh_token: string;
  id_token: string | null;
  account_id: string;
  email: string | null;
  expires_at: string;
  updated_at: string;
}

@Injectable()
export class CodexCredentialsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  get(): CodexCredentialRow | undefined {
    return this.db.prepare('SELECT access_token, refresh_token, id_token, account_id, email, expires_at, updated_at FROM codex_credentials WHERE id = 1')
      .get() as CodexCredentialRow | undefined;
  }

  exists(): boolean {
    return this.db.prepare('SELECT 1 FROM codex_credentials WHERE id = 1').get() !== undefined;
  }

  save(row: CodexCredentialRow): void {
    this.db.prepare(`INSERT INTO codex_credentials (id, access_token, refresh_token, id_token, account_id, email, expires_at, updated_at)
      VALUES (1, @access_token, @refresh_token, @id_token, @account_id, @email, @expires_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET access_token=excluded.access_token, refresh_token=excluded.refresh_token,
      id_token=excluded.id_token, account_id=excluded.account_id, email=excluded.email,
      expires_at=excluded.expires_at, updated_at=excluded.updated_at`).run(row);
  }

  /** Never overwrite a newer CLI login or resurrect credentials deleted while refresh was in flight. */
  replace(previous: CodexCredentialRow, row: CodexCredentialRow): boolean {
    return this.db.prepare(`UPDATE codex_credentials SET access_token=@access_token, refresh_token=@refresh_token,
      id_token=@id_token, account_id=@account_id, email=@email, expires_at=@expires_at, updated_at=@updated_at
      WHERE id=1 AND access_token=@previous_access AND refresh_token=@previous_refresh`)
      .run({ ...row, previous_access: previous.access_token, previous_refresh: previous.refresh_token }).changes === 1;
  }

  delete(): void {
    this.db.prepare('DELETE FROM codex_credentials WHERE id = 1').run();
  }
}
