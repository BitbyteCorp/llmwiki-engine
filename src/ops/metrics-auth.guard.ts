import { ForbiddenException, Inject, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { SessionsService } from '../auth/sessions.service.js';
import { CONFIG } from '../common/tokens.js';
import type { Config } from '../config.js';

@Injectable()
export class MetricsAuthGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: Config, private readonly sessions: SessionsService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const authorization = request.get('authorization');
    if (authorization !== undefined) {
      const bearer = /^Bearer ([^\s]+)$/i.exec(authorization);
      const token = this.config.metricsToken;
      if (bearer && token && timingSafeEqual(
        createHash('sha256').update(bearer[1]).digest(),
        createHash('sha256').update(token).digest(),
      )) return true;
      throw new UnauthorizedException({ code: 'unauthorized', message: 'Invalid metrics token' });
    }
    const user = this.sessions.sessionUser(request);
    if (!user) throw new UnauthorizedException({ code: 'unauthorized', message: 'Login required' });
    if (user.role !== 'admin') throw new ForbiddenException({ code: 'forbidden', message: 'Admin required' });
    request.user = user;
    return true;
  }
}
