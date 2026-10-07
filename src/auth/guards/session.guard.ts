import { Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { SessionsService } from '../sessions.service.js';

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionsService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const user = this.sessions.sessionUser(req);
    if (!user) {
      throw new UnauthorizedException({ code: 'unauthorized', message: 'Login required' });
    }
    req.user = user;
    return true;
  }
}
