import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { OAuthController } from './oauth.controller.js';
import { GoogleOidcService, GOOGLE_ISSUER, DEFAULT_GOOGLE_ISSUER } from './google-oidc.service.js';
import { OAuthRepository } from './oauth.repository.js';
import { OAuthService } from './oauth.service.js';
import { SessionsService } from './sessions.service.js';
import { UsersRepository } from './users.repository.js';
import { UsersService } from './users.service.js';
import { McpAuthGuard } from './guards/mcp-auth.guard.js';
import { RolesGuard } from './guards/roles.guard.js';
import { SessionGuard } from './guards/session.guard.js';
import { ApiTokensController } from './api-tokens.controller.js';
import { ApiTokensRepository } from './api-tokens.repository.js';
import { ApiTokensService } from './api-tokens.service.js';
import { AuthCleanupService } from './auth-cleanup.service.js';
import { SessionOnlyGuard } from './guards/session-only.guard.js';

@Module({
  controllers: [AuthController, OAuthController, ApiTokensController],
  providers: [
    UsersRepository,
    UsersService,
    SessionsService,
    GoogleOidcService,
    { provide: GOOGLE_ISSUER, useValue: DEFAULT_GOOGLE_ISSUER },
    OAuthRepository,
    OAuthService,
    SessionGuard,
    RolesGuard,
    McpAuthGuard,
    ApiTokensRepository,
    ApiTokensService,
    AuthCleanupService,
    SessionOnlyGuard,
  ],
  // Nest instantiates controller guards in the consuming module's DI scope.
  exports: [UsersService, SessionsService, OAuthService, ApiTokensService, SessionGuard, SessionOnlyGuard, RolesGuard, McpAuthGuard],
})
export class AuthModule {}
