import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { CONFIG, DB } from '../common/tokens.js';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';

@Injectable()
export class AuthCleanupService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  constructor(@Inject(CONFIG) private readonly config: Config, @Inject(DB) private readonly db: Db) {}

  onModuleInit(): void {
    this.cleanup();
    this.timer = setInterval(() => this.cleanup(), this.config.authCleanupIntervalMs ?? 300_000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  cleanup(): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM web_sessions WHERE expires_at <= ?').run(now);
      this.db.prepare('DELETE FROM auth_pending WHERE expires_at <= ?').run(now);
      this.db.prepare('DELETE FROM mcp_login_requests WHERE expires_at <= ?').run(now);
      this.db.prepare('DELETE FROM oauth_codes WHERE expires_at <= ?').run(now);
      this.db.prepare('DELETE FROM oauth_access_tokens WHERE expires_at <= ? OR revoked = 1').run(now);
      this.db.prepare('DELETE FROM oauth_refresh_tokens WHERE expires_at <= ?').run(now);
      // A rotated refresh token remains a revocation handle for its live family.
      // Removing it sooner would change /oauth/revoke semantics after cleanup.
      this.db.prepare(`DELETE FROM oauth_refresh_tokens AS old WHERE old.revoked = 1
        AND NOT EXISTS (SELECT 1 FROM oauth_refresh_tokens AS live WHERE live.family_id = old.family_id AND live.revoked = 0)
        AND NOT EXISTS (SELECT 1 FROM oauth_access_tokens AS live WHERE live.family_id = old.family_id AND live.revoked = 0)`).run();
      this.db.prepare('DELETE FROM api_tokens WHERE expires_at <= ? OR revoked_at IS NOT NULL').run(now);
    })();
  }
}
