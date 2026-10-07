import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import type { User } from '../auth/users.types.js';
import { NoteWriterService } from '../jobs/note-writer.service.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { historyQuerySchema, shaSchema, historyCompareQuerySchema, commitParentQuerySchema, historyRevertSchema } from './api.dto.js';
import { HistoryService } from './history.service.js';

@Controller('api')
@UseGuards(SessionGuard, RolesGuard)
export class HistoryController {
  constructor(private readonly history: HistoryService, private readonly writer: NoteWriterService) {}

  @Get('history')
  async list(@Query(new ZodValidationPipe(historyQuerySchema)) query: z.infer<typeof historyQuerySchema>, @CurrentUser() user: User) {
    return { commits: await this.history.listCommits(query, user) };
  }

  @Get('history/commits/:sha')
  get(
    @Param('sha', new ZodValidationPipe(shaSchema)) sha: z.infer<typeof shaSchema>,
    @Query(new ZodValidationPipe(commitParentQuerySchema)) query: z.infer<typeof commitParentQuerySchema>,
    @CurrentUser() user: User,
  ) {
    return this.history.getCommit(sha, query.parent, user);
  }

  @Get('history/compare')
  compare(@Query(new ZodValidationPipe(historyCompareQuerySchema)) query: z.infer<typeof historyCompareQuerySchema>, @CurrentUser() user: User) {
    return this.history.compare(query.base, query.head, query.path, user);
  }

  @Post('history/revert')
  @Roles('editor')
  async revert(@Body(new ZodValidationPipe(historyRevertSchema)) body: z.infer<typeof historyRevertSchema>, @CurrentUser() user: User) {
    await this.history.assertRevert(user, body.sha, body.paths);
    const result = await this.writer.applyRevert({ userId: user.id, ...body, client: 'web' });
    if ('jobId' in result) return { jobId: result.jobId, mergeSha: result.mergeSha };
    return result;
  }
}
