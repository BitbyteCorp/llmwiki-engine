import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../api/api-error.js';
import { AuditService } from '../audit/audit.service.js';
import { ApiTokensRepository, type ApiTokenRow } from './api-tokens.repository.js';
import { UsersService } from './users.service.js';
import type { User } from './users.types.js';

export const createApiTokenSchema = z.object({
  name: z.string().trim().min(1).max(200),
  scopes: z.array(z.enum(['read', 'write'])).min(1).max(2).refine((scopes) => new Set(scopes).size === scopes.length, 'Duplicate scopes'),
  expiresAt: z.iso.datetime().nullable().optional(),
}).strict();
export type ApiTokenScope = 'read' | 'write';

function metadata(row: ApiTokenRow) {
  return { id: row.id, userId: row.user_id, name: row.name, scopes: JSON.parse(row.scopes) as ApiTokenScope[],
    createdAt: row.created_at, expiresAt: row.expires_at, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at };
}

@Injectable()
export class ApiTokensService {
  constructor(
    private readonly repository: ApiTokensRepository,
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  create(user: User, input: z.infer<typeof createApiTokenSchema>) {
    const parsed = createApiTokenSchema.safeParse(input);
    if (!parsed.success) throw new ApiError(400, 'invalid_request', parsed.error.issues.map((issue) => issue.message).join('; '));
    const value = parsed.data;
    const now = new Date().toISOString();
    if (value.expiresAt && Date.parse(value.expiresAt) <= Date.now()) {
      throw new ApiError(400, 'invalid_request', 'Token expiry must be in the future');
    }
    const token = `lwk_${randomBytes(32).toString('base64url')}`;
    const row: ApiTokenRow = { id: randomUUID(), user_id: user.id, name: value.name,
      token_hash: createHash('sha256').update(token).digest('hex'), scopes: JSON.stringify(value.scopes), created_at: now,
      expires_at: value.expiresAt ? new Date(value.expiresAt).toISOString() : null, last_used_at: null, revoked_at: null };
    this.repository.insert(row);
    this.audit.record({ actorId: user.id, action: 'token.create', target: row.id, outcome: 'success', summary: row.name });
    return { ...metadata(row), token };
  }

  list(user: User, all = false) {
    if (all && user.role !== 'admin') throw new ForbiddenException({ code: 'forbidden', message: 'admin role required' });
    return this.repository.list(all ? undefined : user.id).map(metadata);
  }

  revoke(user: User, id: string): void {
    const row = this.repository.get(id);
    if (!row || (row.user_id !== user.id && user.role !== 'admin')) throw new ApiError(404, 'not_found', 'Token not found');
    this.repository.revoke(id, new Date().toISOString());
    this.audit.record({ actorId: user.id, action: 'token.revoke', target: id, outcome: 'success', summary: row.name });
  }

  authenticate(token: string, scope: ApiTokenScope): User {
    if (!/^lwk_[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new UnauthorizedException({ code: 'unauthorized', message: 'Invalid API token' });
    }
    const row = this.repository.byHash(createHash('sha256').update(token).digest('hex'));
    const now = new Date().toISOString();
    if (!row || row.revoked_at || (row.expires_at && row.expires_at <= now)) {
      throw new UnauthorizedException({ code: 'unauthorized', message: 'Invalid or expired API token' });
    }
    const user = this.users.getById(row.user_id);
    if (!user) throw new UnauthorizedException({ code: 'unauthorized', message: 'User no longer exists' });
    if (!(JSON.parse(row.scopes) as ApiTokenScope[]).includes(scope)) {
      throw new ForbiddenException({ code: 'insufficient_scope', message: `${scope} scope required` });
    }
    this.repository.touch(row.id, now);
    return user;
  }
}
