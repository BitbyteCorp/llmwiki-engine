import { ForbiddenException, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ROLES_KEY } from '../decorators/roles.decorator.js';
import type { Role } from '../users.types.js';

const rank: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const minRole = this.reflector.getAllAndOverride<Role>(ROLES_KEY, [context.getHandler(), context.getClass()]) ?? 'viewer';
    const req = context.switchToHttp().getRequest<Request>();
    if (!req.user || rank[req.user.role] < rank[minRole]) {
      throw new ForbiddenException({ code: 'forbidden', message: `${minRole} role required` });
    }
    return true;
  }
}
