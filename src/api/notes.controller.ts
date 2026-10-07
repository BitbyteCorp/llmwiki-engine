import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { noteContentQuerySchema, noteResolveQuerySchema } from './api.dto.js';
import { NotesService } from './notes.service.js';

@Controller('api/notes')
@UseGuards(SessionGuard, RolesGuard)
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Get('tree')
  async tree() {
    return { files: await this.notes.tree() };
  }

  @Get('content')
  content(@Query(new ZodValidationPipe(noteContentQuerySchema)) query: z.infer<typeof noteContentQuerySchema>) {
    return this.notes.content(query.path);
  }

  @Get('resolve')
  resolve(@Query(new ZodValidationPipe(noteResolveQuerySchema)) query: z.infer<typeof noteResolveQuerySchema>) {
    return this.notes.resolve(query.name);
  }
}
