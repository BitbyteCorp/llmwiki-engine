import { Body, Controller, Delete, Get, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import { AclService } from '../acl/acl.service.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import type { User } from '../auth/users.types.js';
import { NoteWriterService } from '../jobs/note-writer.service.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { noteContentQuerySchema, noteRawQuerySchema, noteResolveQuerySchema, notePutSchema, noteMoveSchema, noteDeleteSchema, noteBlameQuerySchema } from './api.dto.js';
import { NotesService } from './notes.service.js';

@Controller('api/notes')
@UseGuards(SessionGuard, RolesGuard)
export class NotesController {
  constructor(private readonly notes: NotesService, private readonly writer: NoteWriterService, private readonly acl: AclService) {}

  @Get('tree')
  async tree(@CurrentUser() user: User) {
    return { files: await this.notes.tree(user) };
  }

  @Get('content')
  content(@Query(new ZodValidationPipe(noteContentQuerySchema)) query: z.infer<typeof noteContentQuerySchema>, @CurrentUser() user: User) {
    return this.notes.content(query.path, query.ref, user);
  }

  @Get('raw')
  async raw(
    @Query(new ZodValidationPipe(noteRawQuerySchema)) query: z.infer<typeof noteRawQuerySchema>,
    @CurrentUser() user: User,
    @Res() response: Response,
  ): Promise<void> {
    const asset = await this.notes.raw(query.path, query.ref, user);
    response.setHeader('Content-Type', asset.contentType);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    response.setHeader('Cache-Control', 'private, no-store');
    response.send(asset.bytes);
  }

  @Get('resolve')
  resolve(@Query(new ZodValidationPipe(noteResolveQuerySchema)) query: z.infer<typeof noteResolveQuerySchema>, @CurrentUser() user: User) {
    return this.notes.resolve(query.name, user);
  }

  @Get('blame')
  blame(@Query(new ZodValidationPipe(noteBlameQuerySchema)) query: z.infer<typeof noteBlameQuerySchema>, @CurrentUser() user: User) {
    return this.notes.blame(query.path, query.ref, user);
  }

  @Put()
  @Roles('editor')
  async put(@Body(new ZodValidationPipe(notePutSchema)) body: z.infer<typeof notePutSchema>, @CurrentUser() user: User) {
    this.acl.assertWrite(user, body.path);
    const { jobId, mergeSha } = await this.writer.apply({
      userId: user.id, source: 'web', client: 'web', baseSha: body.baseSha, message: body.message,
      ops: [{ op: 'put', path: body.path, content: body.content, create: body.create }],
    });
    return { jobId, mergeSha };
  }

  @Post('move')
  @Roles('editor')
  async move(@Body(new ZodValidationPipe(noteMoveSchema)) body: z.infer<typeof noteMoveSchema>, @CurrentUser() user: User) {
    this.acl.assertWrite(user, body.from);
    this.acl.assertWrite(user, body.to);
    const { jobId, mergeSha } = await this.writer.apply({
      userId: user.id, source: 'web', client: 'web', baseSha: body.baseSha,
      ops: [{ op: 'move', from: body.from, to: body.to }],
    });
    return { jobId, mergeSha };
  }

  @Delete()
  @Roles('editor')
  async remove(@Query(new ZodValidationPipe(noteDeleteSchema)) query: z.infer<typeof noteDeleteSchema>, @CurrentUser() user: User) {
    this.acl.assertWrite(user, query.path);
    const { jobId, mergeSha } = await this.writer.apply({
      userId: user.id, source: 'web', client: 'web', baseSha: query.baseSha,
      ops: [{ op: 'delete', path: query.path }],
    });
    return { jobId, mergeSha };
  }
}
