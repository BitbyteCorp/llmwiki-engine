import { Controller, Get, Optional, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { WriteJobsService } from '../jobs/write-jobs.service.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import type { User } from '../auth/users.types.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { idSchema, jobsQuerySchema } from './api.dto.js';
import { HistoryService } from './history.service.js';

@Controller('api/jobs')
@UseGuards(SessionGuard, RolesGuard)
export class JobsController {
  constructor(
    private readonly history: HistoryService,
    private readonly jobs: WriteJobsService,
    @Optional() private readonly audit?: AuditService,
  ) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(jobsQuerySchema)) query: z.infer<typeof jobsQuerySchema>,
    @CurrentUser() user: User,
  ) {
    return { jobs: this.history.listJobs(query, user) };
  }

  @Get(':id')
  get(@Param('id', new ZodValidationPipe(idSchema)) id: z.infer<typeof idSchema>, @CurrentUser() user: User) {
    return this.history.getJob(id, user);
  }

  @Post(':id/retry')
  @Roles('editor')
  async retry(@Param('id', new ZodValidationPipe(idSchema)) id: z.infer<typeof idSchema>, @CurrentUser() user: User) {
    try {
      await this.history.getJob(id, user);
      const job = await this.jobs.retry(id);
      this.audit?.record({ actorId: user.id, action: 'job.retry', target: id, outcome: 'success' });
      return { job };
    } catch (error) {
      this.audit?.record({ actorId: user.id, action: 'job.retry', target: id, outcome: 'error' });
      throw error;
    }
  }

  @Post(':id/cancel')
  @Roles('editor')
  async cancel(@Param('id', new ZodValidationPipe(idSchema)) id: z.infer<typeof idSchema>, @CurrentUser() user: User) {
    try {
      await this.history.getJob(id, user);
      const job = await this.jobs.cancel(id);
      this.audit?.record({ actorId: user.id, action: 'job.cancel', target: id, outcome: 'success' });
      return { job };
    } catch (error) {
      this.audit?.record({ actorId: user.id, action: 'job.cancel', target: id, outcome: 'error' });
      throw error;
    }
  }
}
