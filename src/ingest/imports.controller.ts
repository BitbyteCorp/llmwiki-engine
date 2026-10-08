import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { idSchema, limitSchema } from '../api/api.dto.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import type { User } from '../auth/users.types.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { IngestService } from './ingest.service.js';
import { ingestSchema } from './ingest.types.js';
const listSchema = z.object({ limit: limitSchema, before: idSchema.optional() });
@Controller('api/imports')
@UseGuards(SessionGuard, RolesGuard)
export class ImportsController {
  constructor(private readonly ingestService: IngestService) {}
  @Post()
  @Roles('editor')
  ingest(@Body(new ZodValidationPipe(ingestSchema)) body: z.infer<typeof ingestSchema>, @CurrentUser() user: User) {
    return this.ingestService.ingest({ ...body, userId: user.id });
  }
  @Post(':id/retry')
  @Roles('editor')
  retry(@Param('id', new ZodValidationPipe(idSchema)) id: string, @CurrentUser() user: User) {
    return this.ingestService.retry(id, user.id, user.role === 'admin');
  }
  @Get()
  @Roles('viewer')
  list(@Query(new ZodValidationPipe(listSchema)) query: z.infer<typeof listSchema>, @CurrentUser() user: User) {
    return { imports: this.ingestService.list(user.id, user.role === 'admin', query) };
  }
  @Get(':id')
  @Roles('viewer')
  get(@Param('id', new ZodValidationPipe(idSchema)) id: string, @CurrentUser() user: User) {
    return this.ingestService.get(id, user.id, user.role === 'admin');
  }
}
