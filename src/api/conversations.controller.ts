import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import type { User } from '../auth/users.types.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { createConversationSchema, idSchema, messageSchema } from './api.dto.js';
import { ConversationsService } from './conversations.service.js';

@Controller('api/conversations')
@UseGuards(SessionGuard, RolesGuard)
export class ConversationsController {
  constructor(private readonly service: ConversationsService) {}

  @Get()
  list(@CurrentUser() user: User) {
    return { conversations: this.service.list(user.id) };
  }

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createConversationSchema)) input: z.infer<typeof createConversationSchema>,
    @CurrentUser() user: User,
  ) {
    return { conversation: this.service.create(user.id, input.title) };
  }

  @Get(':id')
  get(
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @CurrentUser() user: User,
  ) {
    return this.service.get(id, user.id);
  }

  @Delete(':id')
  @HttpCode(204)
  delete(
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @CurrentUser() user: User,
  ): void {
    this.service.delete(id, user.id);
  }

  @Post(':id/messages')
  @HttpCode(200)
  async sendMessage(
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(messageSchema)) input: z.infer<typeof messageSchema>,
    @CurrentUser() user: User,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const messages = this.service.submitMessage(id, user.id, input.content);
    const controller = new AbortController();
    const abort = () => { controller.abort(); };
    req.on('aborted', abort);
    res.on('close', abort);
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const send = (event: string, data: unknown) => {
      if (!controller.signal.aborted && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    try {
      const message = await this.service.answer(id, user.id, messages, (text) => { send('delta', { text }); }, controller.signal);
      if (!controller.signal.aborted && message) send('done', { message });
    } catch (error) {
      if (!controller.signal.aborted) {
        send('error', { message: error instanceof Error ? error.message : 'Answer failed' });
      }
    } finally {
      req.off('aborted', abort);
      res.off('close', abort);
      if (!res.writableEnded) res.end();
    }
  }
}
