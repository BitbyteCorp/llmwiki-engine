import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { historyQuerySchema, shaSchema } from './api.dto.js';
import { HistoryService } from './history.service.js';

@Controller('api')
@UseGuards(SessionGuard, RolesGuard)
export class HistoryController {
  constructor(private readonly history: HistoryService) {}

  @Get('history')
  async list(@Query(new ZodValidationPipe(historyQuerySchema)) query: z.infer<typeof historyQuerySchema>) {
    return { commits: await this.history.listCommits(query) };
  }

  @Get('commits/:sha')
  get(@Param('sha', new ZodValidationPipe(shaSchema)) sha: z.infer<typeof shaSchema>) {
    return this.history.getCommit(sha);
  }
}
