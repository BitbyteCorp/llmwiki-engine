import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AuditService } from './audit.service.js';

@Injectable()
export class AuditHttpService {
  private readonly recorded = new WeakSet<Request>();

  constructor(private readonly audit: AuditService) {}

  record(req: Request, status: number): void {
    if (this.recorded.has(req)) return;
    const path = req.originalUrl.split('?')[0]!.replace(/\/$/, '');
    const userRoute = /^\/api\/admin\/users(?:\/([^/]+))?$/i.exec(path);
    let action: string;
    let target: string;
    if (userRoute && req.method === 'POST' && !userRoute[1]) {
      action = 'user.create';
      target = typeof req.body?.email === 'string' ? `user:${req.body.email.trim().toLowerCase()}` : 'users';
    } else if (userRoute?.[1] && req.method === 'PATCH') {
      action = req.body?.role !== undefined ? 'user.role' : 'user.update';
      target = `user:${userRoute[1]}`;
    } else if (userRoute?.[1] && req.method === 'DELETE') {
      action = 'user.delete';
      target = `user:${userRoute[1]}`;
    } else if (path.toLowerCase() === '/api/admin/settings' && req.method === 'PUT') {
      action = 'settings.update';
      target = 'settings';
    } else {
      return;
    }
    this.audit.record({
      actorId: req.user?.id ?? null, action, target,
      outcome: status < 400 ? 'success' : 'failure',
      summary: `${req.method} ${path}: HTTP ${status}`,
    });
    this.recorded.add(req);
  }
}
