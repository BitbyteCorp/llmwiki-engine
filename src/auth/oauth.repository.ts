import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../common/tokens.js';
import type { Db } from '../db/index.js';
import type { AuthorizationCodeRow, ClientMetadata, TokenRow } from './oauth.types.js';

@Injectable()
export class OAuthRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  getClient(id: string): { kind: string; metadata: string; expires_at: string | null } | undefined {
    return this.db.prepare('SELECT kind, metadata, expires_at FROM oauth_clients WHERE client_id = ?').get(id) as
      { kind: string; metadata: string; expires_at: string | null } | undefined;
  }

  cacheClient(client: ClientMetadata, expiresAt: string): void {
    this.db.prepare(`INSERT INTO oauth_clients(client_id,kind,metadata,expires_at) VALUES (?, 'cimd', ?, ?)
      ON CONFLICT(client_id) DO UPDATE SET metadata=excluded.metadata,expires_at=excluded.expires_at`)
      .run(client.client_id, JSON.stringify(client), expiresAt);
  }

  registerClient(client: ClientMetadata): void {
    this.db.prepare("INSERT INTO oauth_clients(client_id,kind,metadata) VALUES (?, 'dcr', ?)")
      .run(client.client_id, JSON.stringify(client));
  }

  insertCode(codeHash: string, row: AuthorizationCodeRow): void {
    this.db.prepare('INSERT INTO oauth_codes(code_hash,client_id,user_id,redirect_uri,challenge,resource,expires_at) VALUES (?,?,?,?,?,?,?)')
      .run(codeHash, row.client_id, row.user_id, row.redirect_uri, row.challenge, row.resource, row.expires_at);
  }

  getCode(codeHash: string): AuthorizationCodeRow | undefined {
    return this.db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(codeHash) as AuthorizationCodeRow | undefined;
  }

  deleteCode(codeHash: string): void {
    this.db.prepare('DELETE FROM oauth_codes WHERE code_hash = ?').run(codeHash);
  }

  insertTokens(access: Omit<TokenRow, 'revoked'>, refresh: Omit<TokenRow, 'revoked'>): void {
    this.db.prepare('INSERT INTO oauth_access_tokens(token_hash,client_id,user_id,family_id,resource,expires_at) VALUES (?,?,?,?,?,?)')
      .run(access.token_hash, access.client_id, access.user_id, access.family_id, access.resource, access.expires_at);
    this.db.prepare('INSERT INTO oauth_refresh_tokens(token_hash,client_id,user_id,family_id,resource,expires_at) VALUES (?,?,?,?,?,?)')
      .run(refresh.token_hash, refresh.client_id, refresh.user_id, refresh.family_id, refresh.resource, refresh.expires_at);
  }

  getAccessToken(tokenHash: string): TokenRow | undefined {
    return this.db.prepare('SELECT * FROM oauth_access_tokens WHERE token_hash=?').get(tokenHash) as TokenRow | undefined;
  }

  getRefreshToken(tokenHash: string): TokenRow | undefined {
    return this.db.prepare('SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?').get(tokenHash) as TokenRow | undefined;
  }

  revokeRefreshToken(tokenHash: string): void {
    this.db.prepare('UPDATE oauth_refresh_tokens SET revoked=1 WHERE token_hash = ?').run(tokenHash);
  }

  revoke(tokenHash: string, clientId: string): void {
    this.db.transaction(() => {
      const refresh = this.db.prepare('SELECT family_id FROM oauth_refresh_tokens WHERE token_hash=? AND client_id=?')
        .get(tokenHash, clientId) as { family_id: string } | undefined;
      if (refresh) {
        this.db.prepare('UPDATE oauth_refresh_tokens SET revoked=1 WHERE family_id=?').run(refresh.family_id);
        this.db.prepare('UPDATE oauth_access_tokens SET revoked=1 WHERE family_id=?').run(refresh.family_id);
      } else {
        this.db.prepare('UPDATE oauth_access_tokens SET revoked=1 WHERE token_hash=? AND client_id=?').run(tokenHash, clientId);
      }
    })();
  }
}
