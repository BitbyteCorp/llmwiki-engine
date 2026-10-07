import { Controller, Get, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import type { User } from '../auth/users.types.js';

@Controller('api/me')
@UseGuards(SessionGuard, RolesGuard)
export class MeController {
  @Get()
  get(@CurrentUser() user: User) {
    return { user };
  }
}
