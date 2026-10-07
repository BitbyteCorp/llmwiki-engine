import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../common/tokens.js';
import type { Db } from '../db/index.js';
import type { Role, User } from './users.types.js';

const userColumns = 'id, email, name, role, created_at AS createdAt, last_login_at AS lastLoginAt';

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

  constructor(@Inject(DB) private readonly db: Db) {
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

  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation).immediate();
  }

  getById(id: number): User | null {
    return (this.byId.get(id) as User | undefined) ?? null;
  }

  getByEmail(email: string): User | null {
    return (this.byEmail.get(email) as User | undefined) ?? null;
  }

  list(): User[] {
    return this.allUsers.all() as User[];
  }

  create(email: string, name: string | null, role: Role, createdAt: string): number {
    return Number(this.insertUser.run(email, name, role, createdAt).lastInsertRowid);
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
