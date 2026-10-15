import { Module } from '@nestjs/common';
import { CodexAuthService } from './codex-auth.service.js';
import { CodexCredentialsRepository } from './codex-credentials.repository.js';
import { CODEX_OAUTH_ISSUER, DEFAULT_CODEX_OAUTH_ISSUER } from './codex-oauth.js';

@Module({
  providers: [
    CodexCredentialsRepository,
    CodexAuthService,
    { provide: CODEX_OAUTH_ISSUER, useValue: DEFAULT_CODEX_OAUTH_ISSUER },
  ],
  exports: [CodexAuthService],
})
export class CodexModule {}
