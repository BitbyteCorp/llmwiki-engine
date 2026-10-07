import { SetMetadata } from '@nestjs/common';
import type { Role } from '../users.types.js';

export const ROLES_KEY = 'auth:minimum-role';

export const Roles = (minimum: Role) => SetMetadata(ROLES_KEY, minimum);
