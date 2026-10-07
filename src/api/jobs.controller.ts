import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import type { User } from '../auth/users.types.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { idSchema, jobsQuerySchema } from './api.dto.js';
import { HistoryService } from './history.service.js';

@Controller('api/jobs')
@UseGuards(SessionGuard, RolesGuard)
export class JobsController {
  constructor(private readonly history: HistoryService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(jobsQuerySchema)) query: z.infer<typeof jobsQuerySchema>,
    @CurrentUser() user: User,
  ) {
    return { jobs: this.history.listJobs(query, user.id) };
  }

  @Get(':id')
  get(@Param('id', new ZodValidationPipe(idSchema)) id: z.infer<typeof idSchema>) {
    return this.history.getJob(id);
  }
}
