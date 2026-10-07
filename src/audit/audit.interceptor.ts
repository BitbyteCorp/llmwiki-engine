import { HttpException, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { tap } from 'rxjs';
import { ZodError } from 'zod';
import { AuditHttpService } from './audit-http.service.js';

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditHttpService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    return next.handle().pipe(tap({
      complete: () => this.audit.record(req, res.statusCode),
      error: (error: unknown) => {
        const status = error instanceof HttpException ? error.getStatus() : error instanceof ZodError ? 400
          : typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number'
            ? error.status : 500;
        this.audit.record(req, status);
      },
    }));
  }
}
