import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RateLimitService } from './rate-limit.service.js';

const authPaths: Record<string, true> = {
  '/auth/google/login': true, '/auth/google/callback': true, '/auth/dev-login': true,
  '/oauth/authorize': true, '/oauth/register': true, '/oauth/token': true, '/oauth/revoke': true,
};

@Injectable()
export class AuthRateLimitGuard implements CanActivate {
  constructor(private readonly limits: RateLimitService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();
    const path = req.path.replace(/\/$/, '').toLowerCase();
    if (authPaths[path]) {
      await this.limits.consume('auth', req.ip ?? req.socket.remoteAddress ?? 'unknown',
        context.switchToHttp().getResponse<Response>());
    }
    return true;
  }
}
