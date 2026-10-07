import { Body, Controller, Delete, Get, Post, Put, Query, UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import type { User } from '../auth/users.types.js';
import { NoteWriterService } from '../jobs/note-writer.service.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { noteContentQuerySchema, noteResolveQuerySchema, notePutSchema, noteMoveSchema, noteDeleteSchema, noteBlameQuerySchema } from './api.dto.js';
import { NotesService } from './notes.service.js';

@Controller('api/notes')
@UseGuards(SessionGuard, RolesGuard)
export class NotesController {
  constructor(private readonly notes: NotesService, private readonly writer: NoteWriterService) {}

  @Get('tree')
  async tree() {
    return { files: await this.notes.tree() };
  }

  @Get('content')
  content(@Query(new ZodValidationPipe(noteContentQuerySchema)) query: z.infer<typeof noteContentQuerySchema>) {
    return this.notes.content(query.path, query.ref);
  }

  @Get('resolve')
  resolve(@Query(new ZodValidationPipe(noteResolveQuerySchema)) query: z.infer<typeof noteResolveQuerySchema>) {
    return this.notes.resolve(query.name);
  }

  @Get('blame')
  blame(@Query(new ZodValidationPipe(noteBlameQuerySchema)) query: z.infer<typeof noteBlameQuerySchema>) {
    return this.notes.blame(query.path, query.ref);
  }

  @Put()
  @Roles('editor')
  async put(@Body(new ZodValidationPipe(notePutSchema)) body: z.infer<typeof notePutSchema>, @CurrentUser() user: User) {
    const { jobId, mergeSha } = await this.writer.apply({
      userId: user.id, source: 'web', client: 'web', baseSha: body.baseSha, message: body.message,
      ops: [{ op: 'put', path: body.path, content: body.content, create: body.create }],
    });
    return { jobId, mergeSha };
  }

  @Post('move')
  @Roles('editor')
  async move(@Body(new ZodValidationPipe(noteMoveSchema)) body: z.infer<typeof noteMoveSchema>, @CurrentUser() user: User) {
    const { jobId, mergeSha } = await this.writer.apply({
      userId: user.id, source: 'web', client: 'web', baseSha: body.baseSha,
      ops: [{ op: 'move', from: body.from, to: body.to }],
    });
    return { jobId, mergeSha };
  }

  @Delete()
  @Roles('editor')
  async remove(@Query(new ZodValidationPipe(noteDeleteSchema)) query: z.infer<typeof noteDeleteSchema>, @CurrentUser() user: User) {
    const { jobId, mergeSha } = await this.writer.apply({
      userId: user.id, source: 'web', client: 'web', baseSha: query.baseSha,
      ops: [{ op: 'delete', path: query.path }],
    });
    return { jobId, mergeSha };
  }
}
