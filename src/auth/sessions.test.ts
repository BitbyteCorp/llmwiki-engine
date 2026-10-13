import Database from 'better-sqlite3';
import type { Request, Response } from 'express';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { SessionsService } from './sessions.service.js';
import { UsersRepository } from './users.repository.js';
import { UsersService } from './users.service.js';
import type { User } from './users.types.js';

let db: Database.Database;
let sessions: SessionsService;
let user: User;
let other: User;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-10T12:00:00.000Z'));
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const migration of ['001_core.sql', '002_auth.sql', '011_platform.sql', '013_acl.sql', '027_user_passwords.sql']) {
    db.exec(readFileSync(new URL(`../db/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  const users = new UsersService(new UsersRepository(db));
  sessions = new SessionsService(loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'session-test-secret' }), db, users);
  user = await users.create({ email: 'user@example.com', role: 'viewer' });
  other = await users.create({ email: 'other@example.com', role: 'editor' });
});

afterEach(() => {
  db?.close();
  vi.useRealTimers();
});

function cookie(owner: User): string {
  let value = '';
  sessions.create({ cookie(name: string, secret: string) { value = `${name}=${secret}`; } } as Response, owner);
  return value;
}

function cookieRequest(value?: string): Request {
  return { get: () => value } as unknown as Request;
}

describe('user session revocation', () => {
  it('revokes every target session and leaves other users alone', () => {
    const first = cookie(user);
    const second = cookie(user);
    const unrelated = cookie(other);
    sessions.revokeUser(user.id);
    expect(sessions.sessionUser(cookieRequest(first))).toBeNull();
    expect(sessions.sessionUser(cookieRequest(second))).toBeNull();
    expect(sessions.sessionUser(cookieRequest(unrelated))).toEqual(other);
  });

  it('preserves only the verified current session owned by the target user', () => {
    const current = cookie(user);
    const revoked = cookie(user);
    const unrelated = cookie(other);
    sessions.revokeUser(user.id, cookieRequest(current));
    expect(sessions.sessionUser(cookieRequest(current))).toEqual(user);
    expect(sessions.sessionUser(cookieRequest(revoked))).toBeNull();
    expect(sessions.sessionUser(cookieRequest(unrelated))).toEqual(other);
  });

  it.each(['missing', 'invalid signature', 'different user', 'expired', 'deleted'])('does not preserve a %s keep request', (kind) => {
    const current = cookie(user);
    const second = cookie(user);
    const unrelated = cookie(other);
    let keep: string | undefined = current;
    if (kind === 'missing') keep = undefined;
    if (kind === 'invalid signature') {
      const separator = current.lastIndexOf('.');
      const signature = current.slice(separator + 1);
      keep = `${current.slice(0, separator + 1)}${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`;
    }
    if (kind === 'different user') keep = unrelated;
    if (kind === 'expired') db.prepare('UPDATE web_sessions SET expires_at = ? WHERE user_id = ?').run('2026-10-10T12:00:00.000Z', user.id);
    if (kind === 'deleted') {
      sessions.destroy(cookieRequest(current), { clearCookie() {} } as unknown as Response);
    }
    sessions.revokeUser(user.id, cookieRequest(keep));
    expect(sessions.sessionUser(cookieRequest(current))).toBeNull();
    expect(sessions.sessionUser(cookieRequest(second))).toBeNull();
    expect(sessions.sessionUser(cookieRequest(unrelated))).toEqual(other);
    expect(db.prepare('SELECT user_id FROM web_sessions WHERE user_id = ?').all(user.id)).toEqual([]);
  });
});
