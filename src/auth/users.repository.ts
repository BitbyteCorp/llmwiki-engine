import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../common/tokens.js';
import type { Db } from '../db/index.js';
import type { Role, User } from './users.types.js';

const userColumns = 'id, email, name, role, created_at AS createdAt, last_login_at AS lastLoginAt, password_hash IS NOT NULL AS hasPassword';

type UserRow = Omit<User, 'hasPassword'> & { hasPassword: number };
const projectUser = (row: UserRow): User => ({ ...row, hasPassword: Boolean(row.hasPassword) });

export interface PasswordCredential {
  hash: string | null;
  revision: number;
}

@Injectable()
export class UsersRepository {
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
  private readonly passwordById;
  private readonly writePassword;

  constructor(@Inject(DB) private readonly db: Db) {
    this.byId = db.prepare(`SELECT ${userColumns} FROM users WHERE id = ?`);
    this.byEmail = db.prepare(`SELECT ${userColumns} FROM users WHERE email = ?`);
    this.allUsers = db.prepare(`SELECT ${userColumns} FROM users ORDER BY id`);
    this.insertUser = db.prepare(`INSERT INTO users (id, email, name, role, created_at, password_hash)
      SELECT highest_id + 1, ?, ?, ?, ?, ? FROM user_id_highwater WHERE id = 1`);
    this.updateUser = db.prepare('UPDATE users SET role = ?, name = ? WHERE id = ?');
    this.removeUser = db.prepare('DELETE FROM users WHERE id = ?');
    this.adminCount = db.prepare("SELECT count(*) AS count FROM users WHERE role = 'admin'");
    this.settings = db.prepare('SELECT key, value FROM settings');
    this.writeSetting = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    this.recordLogin = db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?');
    this.passwordById = db.prepare('SELECT password_hash AS hash, password_revision AS revision FROM users WHERE id = ?');
    this.writePassword = db.prepare('UPDATE users SET password_hash = ?, password_revision = password_revision + 1 WHERE id = ?');
  }

  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation).immediate();
  }

  getById(id: number): User | null {
    const row = this.byId.get(id) as UserRow | undefined;
    return row ? projectUser(row) : null;
  }

  getByEmail(email: string): User | null {
    const row = this.byEmail.get(email) as UserRow | undefined;
    return row ? projectUser(row) : null;
  }

  list(): User[] {
    return (this.allUsers.all() as UserRow[]).map(projectUser);
  }

  create(email: string, name: string | null, role: Role, createdAt: string, passwordHash: string | null = null): number {
    return Number(this.insertUser.run(email, name, role, createdAt, passwordHash).lastInsertRowid);
  }

  getPasswordCredential(id: number): PasswordCredential | null {
    return (this.passwordById.get(id) as PasswordCredential | undefined) ?? null;
  }

  setPasswordHash(id: number, passwordHash: string | null): void {
    this.writePassword.run(passwordHash, id);
  }

  update(id: number, role: Role, name: string | null): void {
    this.updateUser.run(role, name, id);
  }

  delete(id: number): void {
    this.removeUser.run(id);
  }

  countAdmins(): number {
    const { count } = this.adminCount.get() as { count: number };
    return count;
  }

  getSettings(): Array<{ key: string; value: string }> {
    return this.settings.all() as Array<{ key: string; value: string }>;
  }

  setSetting(key: string, value: string): void {
    this.writeSetting.run(key, value);
  }

  setLastLogin(id: number, lastLoginAt: string): void {
    this.recordLogin.run(lastLoginAt, id);
  }
}
