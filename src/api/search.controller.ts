import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { User } from '../auth/users.types.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { SearchService } from '../rag/search.service.js';
import { CatalogService } from '../rag/catalog.service.js';
import { ComparisonService } from '../rag/comparison.service.js';
import { ApiError } from './api-error.js';
import { searchQuerySchema, searchSuggestQuerySchema, searchSimilarQuerySchema, searchDuplicatesQuerySchema } from './api.dto.js';

@Controller('api/search')
@UseGuards(SessionGuard, RolesGuard)
export class SearchController {
  constructor(private readonly search: SearchService, private readonly catalog: CatalogService,
    private readonly comparison: ComparisonService) {}

  @Get()
  async get(@Query(new ZodValidationPipe(searchQuerySchema)) query: z.infer<typeof searchQuerySchema>, @CurrentUser() user: User) {
    try { return await this.search.query(query.q, { ...query, user }); }
    catch (error) {
      if (error instanceof RangeError) throw new ApiError(400, 'invalid_search', error.message);
      throw error;
    }
  }

  @Get('suggest')
  suggest(@Query(new ZodValidationPipe(searchSuggestQuerySchema)) query: z.infer<typeof searchSuggestQuerySchema>, @CurrentUser() user: User) {
    return this.catalog.suggest(query.q, user);
  }

  @Get('similar')
  similar(@Query(new ZodValidationPipe(searchSimilarQuerySchema)) query: z.infer<typeof searchSimilarQuerySchema>, @CurrentUser() user: User) {
    return this.comparison.similar(query.path, query.limit, user);
  }

  @Get('duplicates')
  async duplicates(@Query(new ZodValidationPipe(searchDuplicatesQuerySchema)) query: z.infer<typeof searchDuplicatesQuerySchema>, @CurrentUser() user: User) {
    try { return await this.comparison.duplicates(query.limit, user); }
    catch (error) {
      if (error instanceof RangeError) throw new ApiError(400, 'invalid_search', error.message);
      throw error;
    }
  }
}
