import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { ApiTokensService, createApiTokenSchema } from './api-tokens.service.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import { SessionGuard } from './guards/session.guard.js';
import { SessionOnlyGuard } from './guards/session-only.guard.js';
import type { User } from './users.types.js';

const listSchema = z.object({ all: z.literal('1').optional() }).strict();
const tokenIdSchema = z.uuid();

@Controller('api/tokens')
export class ApiTokensController {
  constructor(private readonly tokens: ApiTokensService) {}

  @Get()
  @UseGuards(SessionGuard)
  list(@CurrentUser() user: User, @Query(new ZodValidationPipe(listSchema)) query: z.infer<typeof listSchema>) {
    return { tokens: this.tokens.list(user, query.all === '1') };
  }

  @Post()
  @UseGuards(SessionOnlyGuard)
  create(@CurrentUser() user: User, @Body(new ZodValidationPipe(createApiTokenSchema)) input: z.infer<typeof createApiTokenSchema>) {
    return this.tokens.create(user, input);
  }

  @Delete(':id')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  revoke(@CurrentUser() user: User, @Param('id', new ZodValidationPipe(tokenIdSchema)) id: string): void {
    this.tokens.revoke(user, id);
  }
}
