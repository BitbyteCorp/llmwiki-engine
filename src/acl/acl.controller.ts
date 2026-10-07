import { Body, Controller, Delete, Get, HttpCode, HttpException, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { z } from 'zod';
import { aclCheckQuerySchema, aclCreateSchema, aclRuleIdSchema } from '../api/api.dto.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { UsersService } from '../auth/users.service.js';
import type { User } from '../auth/users.types.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { AclService } from './acl.service.js';

@Controller('api/admin/acl')
@UseGuards(SessionGuard, RolesGuard)
@Roles('admin')
export class AclController {
  constructor(private readonly acl: AclService, private readonly users: UsersService) {}

  @Get()
  list() {
    return { rules: this.acl.list() };
  }

  @Post()
  create(@CurrentUser() actor: User, @Body(new ZodValidationPipe(aclCreateSchema)) input: z.infer<typeof aclCreateSchema>) {
    return { rule: this.acl.create(input, actor) };
  }

  @Get('check')
  check(@Query(new ZodValidationPipe(aclCheckQuerySchema)) query: z.infer<typeof aclCheckQuerySchema>) {
    const user = this.users.getById(query.userId);
    if (!user) throw new HttpException({ error: { code: 'not_found', message: 'Not found.' } }, 404);
    return this.acl.explain(user, query.path);
  }

  @Delete(':id')
  @HttpCode(204)
  delete(@CurrentUser() actor: User, @Param('id', new ZodValidationPipe(aclRuleIdSchema)) id: number): void {
    this.acl.delete(id, actor);
  }
}
