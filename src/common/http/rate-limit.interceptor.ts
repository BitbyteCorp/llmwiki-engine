import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { from, switchMap } from 'rxjs';
import { RateLimitService } from './rate-limit.service.js';

@Injectable()
export class UserRateLimitInterceptor implements NestInterceptor {
  constructor(private readonly limits: RateLimitService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Request>();
    if (!req.user) return next.handle();
    const path = req.path.replace(/\/$/, '').toLowerCase();
    const search = req.method === 'GET' && /^\/api\/search(?:\/|$)/.test(path);
    const chat = ['POST', 'PATCH'].includes(req.method)
      && /^\/api\/conversations\/[^/]+\/messages(?:\/[^/]+(?:\/(?:regenerate|retry|proposal))?)?$/.test(path);
    const write = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
      && (/^\/api\/notes(?:\/|$)/.test(path) || path === '/api/history/revert'
        || /^\/api\/jobs(?:\/|$)/.test(path) || /^\/api\/uploads\/[^/]+\/save$/.test(path));
    const ingest = req.method === 'POST' && path === '/api/imports';
    const mcp = req.method === 'POST' && path === '/mcp' && req.body?.method === 'tools/call'
      && ['search', 'similar_notes', 'write', 'ingest_source'].includes(req.body?.params?.name);
    if (!search && !chat && !write && !ingest && !mcp) return next.handle();
    // Interceptors run after SessionGuard; all affected routes share the resolved user's budget.
    return from(this.limits.consume('user', String(req.user.id), context.switchToHttp().getResponse<Response>()))
      .pipe(switchMap(() => next.handle()));
  }
}
