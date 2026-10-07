import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { SearchService } from '../rag/search.service.js';
import { searchQuerySchema } from './api.dto.js';

@Controller('api/search')
@UseGuards(SessionGuard, RolesGuard)
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  async get(@Query(new ZodValidationPipe(searchQuerySchema)) query: z.infer<typeof searchQuerySchema>) {
    return { hits: await this.search.search(query.q, { limit: query.limit }) };
  }
}
