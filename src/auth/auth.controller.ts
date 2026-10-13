import { Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Config } from '../config.js';
import { CONFIG } from '../common/tokens.js';
import { GoogleOidcService } from './google-oidc.service.js';
import type { AuthFlow } from './google-oidc.types.js';
import { OAuthService } from './oauth.service.js';
import { SessionsService } from './sessions.service.js';
import { UsersService } from './users.service.js';
import { AuditService } from '../audit/audit.service.js';
import { passwordLoginSchema, type PasswordLoginDto } from '../api/api.dto.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { LoginRequestsService } from './login-requests.service.js';
import { localLoginPath } from './auth-browser.js';
import { UserServiceError } from './users.types.js';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    private readonly google: GoogleOidcService,
    private readonly sessions: SessionsService,
    private readonly users: UsersService,
    private readonly oauth: OAuthService,
    private readonly loginRequests: LoginRequestsService,
    private readonly audit: AuditService,
  ) {}

  @Get('providers')
  providers(): { google: boolean; password: true } {
    return { google: Boolean(this.config.googleClientId && this.config.googleClientSecret), password: true };
  }

  @Post('password/login')
  async passwordLogin(
    @Body(new ZodValidationPipe(passwordLoginSchema)) body: PasswordLoginDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    this.sessions.assertSameOrigin(req);
    try {
      if (body.request !== undefined) this.loginRequests.get(req, body.request);
      const redirectTo = await this.users.passwordLogin(body.email, body.password, (user) => {
        const redirect = body.request !== undefined
          ? this.oauth.finishAuthorization(user.id, this.loginRequests.get(req, body.request, true))
          : localLoginPath(body.next);
        this.sessions.create(res, user);
        this.audit.record({ actorId: user.id, action: 'auth.password.login', target: `user:${user.id}`, outcome: 'success' });
        return redirect;
      });
      res.status(200).json({ redirectTo });
    } catch (error) {
      this.audit.record({ actorId: null, action: 'auth.password.login', target: 'session', outcome: 'failure' });
      throw error;
    }
  }

  @Get('google/login')
  async login(@Req() req: Request, @Res() res: Response): Promise<void> {
    if (req.query.request !== undefined) {
      if (typeof req.query.request !== 'string') throw new UserServiceError(400, 'invalid_input', 'Expected a login request identifier');
      await this.google.begin(req, res, this.loginRequests.get(req, req.query.request, true));
    } else {
      await this.google.begin(req, res, { kind: 'web', next: localLoginPath(req.query.next, '/') });
    }
  }

  @Get('google/callback')
  async callback(@Req() req: Request, @Res() res: Response): Promise<void> {
    try {
      const { user, flow } = await this.google.callback(req, res);
      this.sessions.create(res, user);
      if (flow.kind === 'web') res.redirect(flow.next);
      else res.redirect(this.oauth.finishAuthorization(user.id, flow));
    } catch (error) {
      const flow = error && typeof error === 'object' && 'flow' in error ? error.flow as AuthFlow : undefined;
      if (flow?.kind === 'mcp') {
        const redirect = new URL(flow.redirectUri);
        redirect.searchParams.set('error', 'access_denied');
        if (flow.state !== undefined) redirect.searchParams.set('state', flow.state);
        redirect.searchParams.set('iss', this.oauth.issuerUrl());
        res.redirect(redirect.href);
      } else throw error;
    }
  }

  @Post('logout')
  logout(@Req() req: Request, @Res() res: Response): void {
    // Logout bypasses SessionGuard, but still mutates the ambient cookie session.
    this.sessions.assertSameOrigin(req);
    this.sessions.destroy(req, res);
    res.status(204).end();
  }

  @Get('dev-login')
  devLogin(@Res() res: Response): void {
    if (!this.config.devLoginEmail || this.config.nodeEnv === 'production') throw new NotFoundException();
    const user = this.users.getByEmail(this.config.devLoginEmail);
    if (!user) throw new ForbiddenException({ code: 'access_denied', message: 'DEV_LOGIN_EMAIL must be an existing user' });
    this.sessions.create(res, user);
    res.redirect('/');
  }
}
