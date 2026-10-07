import { ForbiddenException, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { SessionsService } from '../sessions.service.js';

@Injectable()
export class SessionOnlyGuard implements CanActivate {
  constructor(private readonly sessions: SessionsService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (req.get('authorization') !== undefined) {
      throw new ForbiddenException({ code: 'session_required', message: 'API tokens can only be created from a web session' });
    }
    const user = this.sessions.sessionUser(req);
    if (!user) throw new UnauthorizedException({ code: 'unauthorized', message: 'Login required' });
    this.sessions.assertSameOrigin(req);
    req.user = user;
    return true;
  }
}
