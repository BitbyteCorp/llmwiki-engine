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
  graph(@CurrentUser() user: User) {
    return this.catalog.graph(user);
  }
}
