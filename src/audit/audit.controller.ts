import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { AuditService } from './audit.service.js';

const positiveId = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const auditQuerySchema = z.object({
  before: positiveId.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  actor: positiveId.optional(),
  action: z.string().min(1).max(200).optional(),
});

@Controller('api/admin/audit')
@UseGuards(SessionGuard, RolesGuard)
@Roles('admin')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Query(new ZodValidationPipe(auditQuerySchema)) query: z.infer<typeof auditQuerySchema>) {
    return this.audit.list(query);
  }
}
