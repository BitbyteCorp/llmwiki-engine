import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { UsersRepository } from './users.repository.js';
import { UserServiceError, type Role, type Settings, type User } from './users.types.js';

const emailSchema = z.string().trim().toLowerCase().pipe(z.email());
const roleSchema = z.enum(['admin', 'editor', 'viewer']);
const nameSchema = z.string().nullable();
const createSchema = z.object({ email: emailSchema, name: nameSchema.optional(), role: roleSchema }).strict();
const updateSchema = z.object({ role: roleSchema.optional(), name: nameSchema.optional() }).strict();
const domainSchema = z.string().trim().toLowerCase().max(253).regex(
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/,
  'Expected a domain name, not an email address or URL',
);
const settingsSchema = z.object({
  allowlistEnabled: z.boolean().optional(),
  allowedDomains: z.array(domainSchema).optional(),
}).strict();

function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new UserServiceError(400, 'invalid_request', result.error.issues.map((issue) => issue.message).join('; '));
  }
  return result.data;
}

@Injectable()
export class UsersService {
  constructor(private readonly repository: UsersRepository) {}

  getById(id: number): User | null {
    return this.repository.getById(id);
  }

  getByEmail(email: string): User | null {
    return this.repository.getByEmail(validate(emailSchema, email));
  }

  list(): User[] {
    return this.repository.list();
  }

  create(input: { email: string; name?: string | null; role: Role }): User {
    const value = validate(createSchema, input);
    let id: number;
    try {
      id = this.repository.create(value.email, value.name ?? null, value.role, new Date().toISOString());
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new UserServiceError(409, 'conflict', 'A user with this email already exists');
      }
      throw error;
    }
    return this.getById(id)!;
  }

  update(id: number, input: { role?: Role; name?: string | null }): User {
    const value = validate(updateSchema, input);
    return this.repository.transaction(() => {
      const user = this.requireById(id);
      const role = value.role ?? user.role;
      if (user.role === 'admin' && role !== 'admin') this.guardLastAdmin();
      this.repository.update(id, role, value.name === undefined ? user.name : value.name);
      return this.getById(id)!;
    });
  }

  delete(id: number): void {
    this.repository.transaction(() => {
      const user = this.requireById(id);
      if (user.role === 'admin') this.guardLastAdmin();
      this.repository.delete(id);
    });
  }

  getSettings(): Settings {
    const values = new Map(this.repository.getSettings().map(({ key, value }) => [key, JSON.parse(value) as unknown]));
    return {
      allowlistEnabled: validate(z.boolean(), values.get('allowlist_enabled')),
      allowedDomains: validate(z.array(domainSchema), values.get('allowed_domains')),
    };
  }

  setSettings(partial: Partial<Settings>): Settings {
    const value = validate(settingsSchema, partial);
    return this.repository.transaction(() => {
      if (value.allowlistEnabled !== undefined) this.repository.setSetting('allowlist_enabled', JSON.stringify(value.allowlistEnabled));
      if (value.allowedDomains !== undefined) this.repository.setSetting('allowed_domains', JSON.stringify(value.allowedDomains));
      return this.getSettings();
    });
  }

  canLogin(email: string, hd?: string): { ok: true; user: User } | { ok: false; reason: string } {
    const identity = emailSchema.safeParse(email);
    if (!identity.success) return { ok: false, reason: 'Invalid email address' };
    return this.repository.transaction((): { ok: true; user: User } | { ok: false; reason: string } => {
      const settings = this.getSettings();
      const emailDomain = identity.data.slice(identity.data.lastIndexOf('@') + 1);
      if (settings.allowedDomains.length > 0 && (
        !settings.allowedDomains.includes(emailDomain) || typeof hd !== 'string' || hd.toLowerCase() !== emailDomain
      )) {
        return { ok: false, reason: 'Email and Google Workspace domain must match an allowed domain' };
      }
      let user = this.getByEmail(identity.data);
      if (!user && settings.allowlistEnabled) return { ok: false, reason: 'Email is not on the allowlist' };
      user ??= this.create({ email: identity.data, role: 'viewer' });
      const lastLoginAt = new Date().toISOString();
      this.repository.setLastLogin(user.id, lastLoginAt);
      return { ok: true, user: { ...user, lastLoginAt } };
    });
  }

  private requireById(id: number): User {
    const user = this.getById(id);
    if (!user) throw new UserServiceError(404, 'not_found', 'User not found');
    return user;
  }

  private guardLastAdmin(): void {
    if (this.repository.countAdmins() <= 1) {
      throw new UserServiceError(409, 'last_admin', 'Cannot delete or demote the last admin');
    }
  }
}
