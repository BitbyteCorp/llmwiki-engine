import { Controller, Get, Headers, HttpCode, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import type { User } from '../auth/users.types.js';
import { GenerationsService } from './generations.service.js';

@Controller('api/generations')
@UseGuards(SessionGuard, RolesGuard)
export class GenerationsController {
  constructor(private readonly service: GenerationsService) {}

  @Get(':id/events')
  events(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Res() response: Response,
    @Headers('last-event-id') lastEventId?: string,
  ): void {
    this.service.stream(id, user.id, response, lastEventId);
  }

  @Post(':id/cancel')
  @HttpCode(204)
  cancel(
    @Param('id') id: string,
    @CurrentUser() user: User,
  ): void {
    this.service.cancel(id, user.id);
  }
}
