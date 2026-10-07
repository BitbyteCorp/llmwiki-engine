import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { User } from '../auth/users.types.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { CatalogService } from '../rag/catalog.service.js';

const tagNotesQuerySchema = z.object({ tag: z.string().trim().min(1).max(200) });

@Controller('api/tags')
@UseGuards(SessionGuard, RolesGuard)
export class TagsController {
  constructor(private readonly catalog: CatalogService) {}

  @Get()
  tags(@CurrentUser() user: User) {
    return this.catalog.tags(user);
  }

  @Get('notes')
  notes(@Query(new ZodValidationPipe(tagNotesQuerySchema)) query: z.infer<typeof tagNotesQuerySchema>, @CurrentUser() user: User) {
    return this.catalog.tagNotes(query.tag, user);
  }
}
