import type { Command } from 'commander';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';

export type Role = 'admin' | 'editor' | 'viewer';
export interface User {
  id: number;
  email: string;
  name: string | null;
  role: Role;
  createdAt: string;
  lastLoginAt: string | null;
}
export interface Settings {
  allowlistEnabled: boolean;
  allowedDomains: string[];
}

export class UserServiceError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'UserServiceError';
  }
}

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
const userColumns = 'id, email, name, role, created_at AS createdAt, last_login_at AS lastLoginAt';

function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new UserServiceError(400, 'invalid_request', result.error.issues.map((issue) => issue.message).join('; '));
  }
  return result.data;
}

export class UserService {
  private readonly byId;
  private readonly byEmail;
  private readonly allUsers;
  private readonly insertUser;
  private readonly updateUser;
  private readonly removeUser;
  private readonly adminCount;
  private readonly settings;
  private readonly writeSetting;
  private readonly recordLogin;

  constructor(private readonly db: Db) {
    this.byId = db.prepare(`SELECT ${userColumns} FROM users WHERE id = ?`);
    this.byEmail = db.prepare(`SELECT ${userColumns} FROM users WHERE email = ?`);
    this.allUsers = db.prepare(`SELECT ${userColumns} FROM users ORDER BY id`);
    this.insertUser = db.prepare('INSERT INTO users (email, name, role, created_at) VALUES (?, ?, ?, ?)');
    this.updateUser = db.prepare('UPDATE users SET role = ?, name = ? WHERE id = ?');
    this.removeUser = db.prepare('DELETE FROM users WHERE id = ?');
    this.adminCount = db.prepare("SELECT count(*) AS count FROM users WHERE role = 'admin'");
    this.settings = db.prepare('SELECT key, value FROM settings');
    this.writeSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    this.recordLogin = db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?');
  }

  getById(id: number): User | null {
    return (this.byId.get(id) as User | undefined) ?? null;
  }

  getByEmail(email: string): User | null {
    return (this.byEmail.get(validate(emailSchema, email)) as User | undefined) ?? null;
  }

  list(): User[] {
    return this.allUsers.all() as User[];
  }

  create(input: { email: string; name?: string | null; role: Role }): User {
    const value = validate(createSchema, input);
    let id: number;
    try {
      id = Number(this.insertUser.run(value.email, value.name ?? null, value.role, new Date().toISOString()).lastInsertRowid);
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
    return this.db.transaction(() => {
      const user = this.requireById(id);
      const role = value.role ?? user.role;
      if (user.role === 'admin' && role !== 'admin') this.guardLastAdmin();
      this.updateUser.run(role, value.name === undefined ? user.name : value.name, id);
      return this.getById(id)!;
    }).immediate();
  }

  delete(id: number): void {
    this.db.transaction(() => {
      const user = this.requireById(id);
      if (user.role === 'admin') this.guardLastAdmin();
      this.removeUser.run(id);
    }).immediate();
  }

  getSettings(): Settings {
    const values = new Map((this.settings.all() as Array<{ key: string; value: string }>).map(({ key, value }) => [key, JSON.parse(value) as unknown]));
    return {
      allowlistEnabled: validate(z.boolean(), values.get('allowlist_enabled')),
      allowedDomains: validate(z.array(domainSchema), values.get('allowed_domains')),
    };
  }

  setSettings(partial: Partial<Settings>): Settings {
    const value = validate(settingsSchema, partial);
    return this.db.transaction(() => {
      if (value.allowlistEnabled !== undefined) this.writeSetting.run('allowlist_enabled', JSON.stringify(value.allowlistEnabled));
      if (value.allowedDomains !== undefined) this.writeSetting.run('allowed_domains', JSON.stringify(value.allowedDomains));
      return this.getSettings();
    }).immediate();
  }

  canLogin(email: string, hd?: string): { ok: true; user: User } | { ok: false; reason: string } {
    const identity = emailSchema.safeParse(email);
    if (!identity.success) return { ok: false, reason: 'Invalid email address' };
    return this.db.transaction((): { ok: true; user: User } | { ok: false; reason: string } => {
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
      this.recordLogin.run(lastLoginAt, user.id);
      return { ok: true, user: { ...user, lastLoginAt } };
    }).immediate();
  }

  private requireById(id: number): User {
    const user = this.getById(id);
    if (!user) throw new UserServiceError(404, 'not_found', 'User not found');
    return user;
  }

  private guardLastAdmin(): void {
    const { count } = this.adminCount.get() as { count: number };
    if (count <= 1) throw new UserServiceError(409, 'last_admin', 'Cannot delete or demote the last admin');
  }
}

export function registerAuthCommands(program: Command, getCtx: () => Promise<AppContext>): void {
  const users = program.command('user').description('Manage users and recover administrator access');
  users.command('add <email>')
    .description('Register a user')
    .requiredOption('--role <role>', 'admin, editor, or viewer')
    .option('--name <name>', 'Display name')
    .action(async (email: string, options: { role: Role; name?: string }) => {
      const ctx = await getCtx();
      console.log(JSON.stringify(ctx.users.create({ email, role: options.role, name: options.name }), null, 2));
    });
  users.command('role <email> <role>')
    .description('Change a user role')
    .action(async (email: string, role: Role) => {
      const ctx = await getCtx();
      const user = ctx.users.getByEmail(email);
      if (!user) throw new UserServiceError(404, 'not_found', 'User not found');
      console.log(JSON.stringify(ctx.users.update(user.id, { role }), null, 2));
    });
  users.command('list')
    .description('List registered users')
    .action(async () => {
      const ctx = await getCtx();
      console.log(JSON.stringify(ctx.users.list(), null, 2));
    });
}
