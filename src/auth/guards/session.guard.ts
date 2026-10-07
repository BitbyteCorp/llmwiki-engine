import { Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { ApiTokensService } from '../api-tokens.service.js';
import { SessionsService } from '../sessions.service.js';

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionsService, private readonly tokens: ApiTokensService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const authorization = req.get('authorization');
    if (authorization !== undefined) {
      const match = /^Bearer (lwk_[A-Za-z0-9_-]{43})$/i.exec(authorization);
      if (!match) throw new UnauthorizedException({ code: 'unauthorized', message: 'Invalid REST bearer token' });
      req.user = this.tokens.authenticate(match[1], ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? 'read' : 'write');
      return true;
    }
    const user = this.sessions.sessionUser(req);
    if (!user) throw new UnauthorizedException({ code: 'unauthorized', message: 'Login required' });
    this.sessions.assertSameOrigin(req);
    req.user = user;
    return true;
  }
}
