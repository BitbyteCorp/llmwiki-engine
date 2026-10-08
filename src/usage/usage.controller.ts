import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { UsageService } from './usage.service.js';

const usageQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) });

@Controller('api/admin/usage')
@UseGuards(SessionGuard, RolesGuard)
@Roles('admin')
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  aggregate(@Query(new ZodValidationPipe(usageQuerySchema)) query: z.infer<typeof usageQuerySchema>) {
    return this.usage.aggregate(query.days);
  }
}
