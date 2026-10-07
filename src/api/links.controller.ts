import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { User } from '../auth/users.types.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { CatalogService } from '../rag/catalog.service.js';
import { notePathSchema } from './api.dto.js';

const linksQuerySchema = z.object({ path: notePathSchema });
const graphQuerySchema = z.object({
  path: notePathSchema.optional(),
  depth: z.coerce.number().int().min(1).max(5).default(1),
});

@Controller('api/links')
@UseGuards(SessionGuard, RolesGuard)
export class LinksController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  links(@Query(new ZodValidationPipe(linksQuerySchema)) query: z.infer<typeof linksQuerySchema>, @CurrentUser() user: User) {
    return this.catalog.links(query.path, user);
  }
}

@Controller('api/graph')
@UseGuards(SessionGuard, RolesGuard)
export class GraphController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  graph(@Query(new ZodValidationPipe(graphQuerySchema)) query: z.infer<typeof graphQuerySchema>, @CurrentUser() user: User) {
    return this.catalog.graph(query.path, query.depth, user);
  }
}
