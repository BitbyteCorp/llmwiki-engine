import { Global, Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { AuthModule } from '../auth/auth.module.js';
import { AuditController } from './audit.controller.js';
import { AuditHttpService } from './audit-http.service.js';
import { AuditInterceptor } from './audit.interceptor.js';
import { AuditService } from './audit.service.js';

@Global()
@Module({
  imports: [AuthModule],
  controllers: [AuditController],
  providers: [AuditService, AuditHttpService, { provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
  exports: [AuditService],
})
export class AuditModule implements NestModule {
  constructor(private readonly audit: AuditHttpService) {}

  configure(consumer: MiddlewareConsumer): void {
    // Interceptors run after guards. Finish fallback includes rejected authentication/authorization.
    consumer.apply((req: Request, res: Response, next: NextFunction) => {
      res.once('finish', () => this.audit.record(req, res.statusCode));
      next();
    }).forRoutes('api/admin/{*path}');
  }
}
