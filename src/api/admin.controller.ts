import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { SessionsService } from '../auth/sessions.service.js';
import { UsersService } from '../auth/users.service.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { createUserSchema, settingsSchema, setPasswordSchema, updateUserSchema, userIdSchema, type SetPasswordDto } from './api.dto.js';

@Controller('api/admin')
@UseGuards(SessionGuard, RolesGuard)
@Roles('admin')
export class AdminController {
  constructor(private readonly users: UsersService, private readonly sessions: SessionsService) {}

  @Get('users')
  listUsers() {
    return { users: this.users.list() };
  }

  @Post('users')
  async createUser(@Body(new ZodValidationPipe(createUserSchema)) input: z.infer<typeof createUserSchema>) {
    return { user: await this.users.create(input) };
  }

  @Patch('users/:id')
  updateUser(
    @Param('id', new ZodValidationPipe(userIdSchema)) id: z.infer<typeof userIdSchema>,
    @Body(new ZodValidationPipe(updateUserSchema)) input: z.infer<typeof updateUserSchema>,
  ) {
    return { user: this.users.update(id, input) };
  }

  @Delete('users/:id')
  @HttpCode(204)
  deleteUser(@Param('id', new ZodValidationPipe(userIdSchema)) id: z.infer<typeof userIdSchema>): void {
    this.users.delete(id);
  }

  @Put('users/:id/password')
  @HttpCode(204)
  async setPassword(
    @Param('id', new ZodValidationPipe(userIdSchema)) id: z.infer<typeof userIdSchema>,
    @Body(new ZodValidationPipe(setPasswordSchema)) input: SetPasswordDto,
  ): Promise<void> {
    await this.users.setPassword(id, input.password, () => {
      this.sessions.revokeUser(id);
    });
  }

  @Delete('users/:id/password')
  @HttpCode(204)
  clearPassword(@Param('id', new ZodValidationPipe(userIdSchema)) id: z.infer<typeof userIdSchema>): void {
    this.users.clearPassword(id, () => {
      this.sessions.revokeUser(id);
    });
  }

  @Get('settings')
  getSettings() {
    return this.users.getSettings();
  }

  @Put('settings')
  setSettings(@Body(new ZodValidationPipe(settingsSchema)) input: z.infer<typeof settingsSchema>) {
    return this.users.setSettings(input);
  }
}
