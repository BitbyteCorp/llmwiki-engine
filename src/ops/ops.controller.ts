import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { activityQuerySchema, dreamsQuerySchema, idSchema, reindexSchema } from '../api/api.dto.js';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import type { User } from '../auth/users.types.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { DreamRunsRepository } from '../dreaming/dream-runs.repository.js';
import { DreamingService } from '../dreaming/dreaming.service.js';
import { WriteJobsService } from '../jobs/write-jobs.service.js';
import { IndexerService } from '../rag/indexer.service.js';
import { ActivityService } from './activity.service.js';

@Controller('api')
@UseGuards(SessionGuard, RolesGuard)
export class OpsController {
  constructor(
    private readonly activity: ActivityService,
    private readonly dreams: DreamRunsRepository,
    private readonly dreaming: DreamingService,
    private readonly jobs: WriteJobsService,
    private readonly indexer: IndexerService,
    private readonly audit: AuditService,
  ) {}

  @Get('dreams')
  listDreams(@Query(new ZodValidationPipe(dreamsQuerySchema)) query: z.infer<typeof dreamsQuerySchema>, @CurrentUser() user: User) {
    return this.activity.listDreams(query, user);
  }

  @Get('dreams/:id')
  getDream(@Param('id', new ZodValidationPipe(idSchema)) id: string, @CurrentUser() user: User) {
    return this.activity.getDream(id, user);
  }

  @Get('backup/status')
  backupStatus(@CurrentUser() user: User) {
    return this.activity.backupStatus(user);
  }

  @Get('activity')
  async listActivity(
    @Query(new ZodValidationPipe(activityQuerySchema)) query: z.infer<typeof activityQuerySchema>,
    @CurrentUser() user: User,
  ) {
    const page = await this.activity.list(query, user);
    return { ...page, items: await Promise.all(page.items.map(async (item) => item.job
      ? { ...item, job: { ...item.job, resumable: await this.jobs.isResumable(this.jobs.get(item.job.id)!) } }
      : item)) };
  }

  @Get('journal')
  journal(@CurrentUser() user: User) {
    return this.activity.journal(user);
  }

  @Get('admin/ops')
  @Roles('admin')
  async ops() {
    const { queue, failedJobs } = this.activity.opsJobs();
    return { queue, failedJobs: await Promise.all(failedJobs.map(async (job) => ({
      ...job, resumable: await this.jobs.isResumable(this.jobs.get(job.id)!),
    }))), index: await this.indexer.status(),
      dreams: { last: this.dreams.latest(), running: this.dreams.running() }, backup: this.dreams.backupStatus() };
  }

  @Post('admin/dreams/run')
  @Roles('admin')
  async runDream(@CurrentUser() user: User) {
    try {
      const run = await this.dreaming.runManual();
      this.audit.record({ actorId: user.id, action: 'dream.run', target: run.id,
        outcome: run.status === 'failed' ? 'failed' : 'succeeded' });
      return run;
    } catch (error) {
      this.audit.record({ actorId: user.id, action: 'dream.run', target: 'dreaming', outcome: 'failed' });
      throw error;
    }
  }

  @Post('admin/jobs/:id/retry')
  @Roles('admin')
  async retryJob(@Param('id', new ZodValidationPipe(idSchema)) id: string, @CurrentUser() user: User) {
    try {
      const job = await this.jobs.retry(id);
      this.audit.record({ actorId: user.id, action: 'job.retry', target: id, outcome: 'succeeded' });
      return { job: { ...job, resumable: await this.jobs.isResumable(job) } };
    } catch (error) {
      this.audit.record({ actorId: user.id, action: 'job.retry', target: id, outcome: 'failed' });
      throw error;
    }
  }

  @Post('admin/jobs/:id/cancel')
  @Roles('admin')
  async cancelJob(@Param('id', new ZodValidationPipe(idSchema)) id: string, @CurrentUser() user: User) {
    try {
      const job = await this.jobs.cancel(id);
      this.audit.record({ actorId: user.id, action: 'job.cancel', target: id, outcome: 'succeeded' });
      return { job: { ...job, resumable: await this.jobs.isResumable(job) } };
    } catch (error) {
      this.audit.record({ actorId: user.id, action: 'job.cancel', target: id, outcome: 'failed' });
      throw error;
    }
  }

  @Post('admin/index/reindex')
  @Roles('admin')
  async reindex(
    @Body(new ZodValidationPipe(reindexSchema)) input: z.infer<typeof reindexSchema>,
    @CurrentUser() user: User,
  ) {
    try {
      await this.indexer.reindex({ full: input.full ?? false });
      const status = await this.indexer.status();
      this.audit.record({ actorId: user.id, action: 'index.reindex', target: 'index', outcome: 'succeeded' });
      return status;
    } catch (error) {
      this.audit.record({ actorId: user.id, action: 'index.reindex', target: 'index', outcome: 'failed' });
      throw error;
    }
  }
}
