import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { UsersRepository } from './users.repository.js';
import { UserServiceError, type Role, type Settings, type User } from './users.types.js';
import { hashPassword, verifyPassword } from './password.js';

const emailSchema = z.string().trim().toLowerCase().pipe(z.email());
const roleSchema = z.enum(['admin', 'editor', 'viewer']);
const nameSchema = z.string().nullable();
const createSchema = z.object({ email: emailSchema, name: nameSchema.optional(), role: roleSchema, password: z.string().optional() }).strict();
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

  async create(input: { email: string; name?: string | null; role: Role; password?: string }): Promise<User> {
    const value = validate(createSchema, input);
    const passwordHash = value.password === undefined ? null : await hashPassword(value.password);
    let id: number;
    try {
      id = this.repository.create(value.email, value.name ?? null, value.role, new Date().toISOString(), passwordHash);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new UserServiceError(409, 'conflict', 'A user with this email already exists');
      }
      throw error;
    }
    return this.getById(id)!;
  }

  async setPassword(id: number, password: string, onChanged?: () => void): Promise<void> {
    this.requireById(id);
    const passwordHash = await hashPassword(password);
    this.repository.transaction(() => {
      this.requireById(id);
      this.repository.setPasswordHash(id, passwordHash);
      onChanged?.();
    });
  }

  clearPassword(id: number, onChanged?: () => void): void {
    this.repository.transaction(() => {
      this.requireById(id);
      this.repository.setPasswordHash(id, null);
      onChanged?.();
    });
  }

  async changePassword(id: number, currentPassword: string | undefined, newPassword: string, onChanged?: () => void): Promise<void> {
    const original = this.repository.getPasswordCredential(id);
    if (!original) throw new UserServiceError(404, 'not_found', 'User not found');
    if (original.hash !== null && !await verifyPassword(currentPassword ?? '', original.hash)) {
      throw new UserServiceError(400, 'invalid_current_password', 'Current password is incorrect');
    }
    const passwordHash = await hashPassword(newPassword);
    this.repository.transaction(() => {
      this.requireById(id);
      // Revisions also detect clearing an already-unset password or an ABA change.
      const current = this.repository.getPasswordCredential(id)!;
      if (current.revision !== original.revision || current.hash !== original.hash) {
        throw new UserServiceError(400, 'invalid_current_password', 'Current password is incorrect');
      }
      this.repository.setPasswordHash(id, passwordHash);
      onChanged?.();
    });
  }

  passwordLogin(email: string, password: string): Promise<User>;
  passwordLogin<T>(email: string, password: string, complete: (user: User) => T): Promise<T>;
  async passwordLogin<T>(email: string, password: string, complete?: (user: User) => T): Promise<User | T> {
    const identity = emailSchema.safeParse(email);
    const user = identity.success ? this.repository.getByEmail(identity.data) : null;
    const original = user ? this.repository.getPasswordCredential(user.id) : null;
    const verified = await verifyPassword(password, original?.hash ?? null);
    if (!user || !original || !verified) {
      throw new UserServiceError(401, 'invalid_credentials', 'Invalid email or password');
    }
    return this.repository.transaction(() => {
      const currentUser = this.repository.getById(user.id);
      const current = this.repository.getPasswordCredential(user.id);
      if (!currentUser || !current || current.revision !== original.revision || current.hash !== original.hash) {
        throw new UserServiceError(401, 'invalid_credentials', 'Invalid email or password');
      }
      const settings = this.getSettings();
      const emailDomain = currentUser.email.slice(currentUser.email.lastIndexOf('@') + 1);
      if (settings.allowedDomains.length > 0 && !settings.allowedDomains.includes(emailDomain)) {
        throw new UserServiceError(403, 'login_denied', 'Email domain is not allowed');
      }
      const lastLoginAt = new Date().toISOString();
      this.repository.setLastLogin(currentUser.id, lastLoginAt);
      const loggedInUser = { ...currentUser, lastLoginAt };
      // Session/code issuance must finish synchronously under the credential-check lock.
      return complete ? complete(loggedInUser) : loggedInUser;
    });
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
      if (!user) {
        const id = this.repository.create(identity.data, null, 'viewer', new Date().toISOString());
        user = this.getById(id)!;
      }
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
