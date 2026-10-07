import { Controller, ForbiddenException, Get, Inject, NotFoundException, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Config } from '../config.js';
import { CONFIG } from '../common/tokens.js';
import { GoogleOidcService } from './google-oidc.service.js';
import type { AuthFlow } from './google-oidc.types.js';
import { OAuthService } from './oauth.service.js';
import { SessionsService } from './sessions.service.js';
import { UsersService } from './users.service.js';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    private readonly google: GoogleOidcService,
    private readonly sessions: SessionsService,
    private readonly users: UsersService,
    private readonly oauth: OAuthService,
  ) {}

  @Get('google/login')
  async login(@Req() req: Request, @Res() res: Response): Promise<void> {
    const nextPath = typeof req.query.next === 'string' && /^\/(?!\/)/.test(req.query.next) && !/[\\\r\n]/.test(req.query.next) ? req.query.next : '/';
    await this.google.begin(req, res, { kind: 'web', next: nextPath });
  }

  @Get('google/callback')
  async callback(@Req() req: Request, @Res() res: Response): Promise<void> {
    try {
      const { user, flow } = await this.google.callback(req, res);
      this.sessions.create(res, user);
      if (flow.kind === 'web') res.redirect(flow.next);
      else this.oauth.finishAuthorization(res, user.id, flow);
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
