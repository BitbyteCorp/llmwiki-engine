import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { SessionOnlyGuard } from '../auth/guards/session-only.guard.js';
import { SessionsService } from '../auth/sessions.service.js';
import { UsersService } from '../auth/users.service.js';
import type { User } from '../auth/users.types.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { changePasswordSchema, type ChangePasswordDto } from './api.dto.js';

@Controller('api/me')
export class MeController {
  constructor(private readonly users: UsersService, private readonly sessions: SessionsService) {}

  @Get()
  @UseGuards(SessionGuard, RolesGuard)
  get(@CurrentUser() user: User) {
    return { user };
  }

  @Post('password')
  @HttpCode(204)
  @UseGuards(SessionOnlyGuard, RolesGuard)
  async changePassword(
    @CurrentUser() user: User,
    @Req() req: Request,
    @Body(new ZodValidationPipe(changePasswordSchema)) input: ChangePasswordDto,
  ): Promise<void> {
    await this.users.changePassword(user.id, input.currentPassword, input.newPassword, () => {
      this.sessions.revokeUser(user.id, req);
    });
  }
}
