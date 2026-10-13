import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsersRepository } from './users.repository.js';
import { UsersService } from './users.service.js';
import type { Role, Settings } from './users.types.js';

let db: Database.Database;
let users: UsersService;
const loginTime = '2026-10-07T12:00:00.000Z';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(loginTime));
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const migration of ['001_core.sql', '002_auth.sql', '011_platform.sql', '013_acl.sql', '027_user_passwords.sql']) {
    db.exec(readFileSync(new URL(`../db/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  users = new UsersService(new UsersRepository(db));
});

afterEach(() => {
  db?.close();
  vi.useRealTimers();
});

describe('login policy', () => {
  it.each([
    { label: 'registered user with no domain restriction', existing: true, allowlist: true, domains: [], email: 'user@example.com', hd: undefined, ok: true },
    { label: 'unregistered user with allowlist enabled', existing: false, allowlist: true, domains: [], email: 'user@example.com', hd: undefined, ok: false },
    { label: 'unregistered user with allowlist disabled', existing: false, allowlist: false, domains: [], email: 'user@example.com', hd: undefined, ok: true },
    { label: 'registered Workspace user on allowed domain', existing: true, allowlist: true, domains: ['example.com'], email: 'user@example.com', hd: 'example.com', ok: true },
    { label: 'registered user missing Workspace claim', existing: true, allowlist: true, domains: ['example.com'], email: 'user@example.com', hd: undefined, ok: false },
    { label: 'unregistered user missing Workspace claim even with allowlist disabled', existing: false, allowlist: false, domains: ['example.com'], email: 'user@example.com', hd: undefined, ok: false },
    { label: 'registered user with empty Workspace claim', existing: true, allowlist: false, domains: ['example.com'], email: 'user@example.com', hd: '', ok: false },
    { label: 'different email and Workspace domains even when both are allowed', existing: true, allowlist: true, domains: ['example.com', 'other.com'], email: 'user@example.com', hd: 'other.com', ok: false },
    { label: 'allowed Workspace claim cannot authorize disallowed email domain', existing: true, allowlist: false, domains: ['other.com'], email: 'user@example.com', hd: 'other.com', ok: false },
    { label: 'matching disallowed domains', existing: true, allowlist: true, domains: ['other.com'], email: 'user@example.com', hd: 'example.com', ok: false },
    { label: 'subdomain is not the allowed domain', existing: false, allowlist: false, domains: ['example.com'], email: 'user@sub.example.com', hd: 'sub.example.com', ok: false },
    { label: 'allowlist still requires registration after domain approval', existing: false, allowlist: true, domains: ['example.com'], email: 'user@example.com', hd: 'example.com', ok: false },
    { label: 'domain-approved user auto-created when allowlist disabled', existing: false, allowlist: false, domains: ['example.com'], email: 'user@example.com', hd: 'example.com', ok: true },
    { label: 'case-insensitive email and domains', existing: true, allowlist: true, domains: [' EXAMPLE.COM '], email: 'USER@EXAMPLE.COM', hd: 'EXAMPLE.COM', ok: true },
  ])('$label', async ({ existing, allowlist, domains, email, hd, ok }) => {
    const original = existing ? await users.create({ email, role: 'editor', name: 'Registered User' }) : null;
    users.setSettings({ allowlistEnabled: allowlist, allowedDomains: domains });

    const result = users.canLogin(email, hd);

    expect(result.ok).toBe(ok);
    if (result.ok) {
      expect(result.user.email).toBe('user@example.com');
      expect(result.user.role).toBe(existing ? 'editor' : 'viewer');
      expect(result.user.name).toBe(existing ? 'Registered User' : null);
      expect(result.user.lastLoginAt).toBe(loginTime);
      expect(users.getByEmail(email)).toEqual(result.user);
      if (original) expect(result.user.id).toBe(original.id);
    } else {
      expect(users.getByEmail(email)).toEqual(original);
    }
  });

  it('rejects malformed email without creating a user', () => {
    users.setSettings({ allowlistEnabled: false });
    expect(users.canLogin('not-an-email')).toMatchObject({ ok: false });
    expect(users.list()).toEqual([]);
  });

  it('records each successful login but leaves the last successful login intact on denial', async () => {
    const user = await users.create({ email: 'user@example.com', role: 'viewer' });
    users.canLogin(user.email);
    vi.setSystemTime(new Date('2026-10-08T12:00:00.000Z'));
    users.canLogin(user.email);
    expect(users.getById(user.id)?.lastLoginAt).toBe('2026-10-08T12:00:00.000Z');
    users.setSettings({ allowedDomains: ['example.com'] });
    vi.setSystemTime(new Date('2026-10-09T12:00:00.000Z'));
    expect(users.canLogin(user.email, 'other.com')).toMatchObject({ ok: false });
    expect(users.getById(user.id)?.lastLoginAt).toBe('2026-10-08T12:00:00.000Z');
  });
});

describe('administrator protection', () => {
  it.each<Role>(['editor', 'viewer'])('rejects demoting the only administrator to %s without changing their name', async (role) => {
    const admin = await users.create({ email: 'admin@example.com', role: 'admin', name: 'Original' });
    expect(() => users.update(admin.id, { role, name: 'Changed' })).toThrow(expect.objectContaining({ status: 409, code: 'last_admin' }));
    expect(users.getById(admin.id)).toEqual(admin);
  });

  it('rejects deleting the only administrator', async () => {
    const admin = await users.create({ email: 'admin@example.com', role: 'admin' });
    expect(() => users.delete(admin.id)).toThrow(expect.objectContaining({ status: 409, code: 'last_admin' }));
    expect(users.getById(admin.id)).toEqual(admin);
  });

  it('allows changing the only administrator name and preserving their role', async () => {
    const admin = await users.create({ email: 'admin@example.com', role: 'admin' });
    expect(users.update(admin.id, { name: 'Renamed', role: 'admin' })).toMatchObject({ name: 'Renamed', role: 'admin' });
  });

  it('allows demotion with another administrator, then protects the remaining administrator', async () => {
    const first = await users.create({ email: 'first@example.com', role: 'admin' });
    const second = await users.create({ email: 'second@example.com', role: 'admin' });
    expect(users.update(first.id, { role: 'editor' }).role).toBe('editor');
    users.delete(first.id);
    expect(users.getById(first.id)).toBeNull();
    expect(() => users.delete(second.id)).toThrow(expect.objectContaining({ code: 'last_admin' }));
  });

  it('allows deleting one administrator, then prevents demotion of the remaining administrator', async () => {
    const first = await users.create({ email: 'first@example.com', role: 'admin' });
    const second = await users.create({ email: 'second@example.com', role: 'admin' });
    users.delete(first.id);
    expect(users.getById(first.id)).toBeNull();
    expect(() => users.update(second.id, { role: 'viewer' })).toThrow(expect.objectContaining({ code: 'last_admin' }));
  });
});

describe('user and settings validation', () => {
  it('canonicalizes email identity and reports duplicate registration as a conflict', async () => {
    const user = await users.create({ email: ' Admin@Example.com ', role: 'admin' });
    expect(users.getByEmail('ADMIN@example.com')).toEqual(user);
    await expect(users.create({ email: 'admin@example.com', role: 'viewer' })).rejects.toMatchObject({ status: 409, code: 'conflict' });
    expect(users.list()).toEqual([user]);
  });

  it.each([
    { email: 'invalid', role: 'viewer' },
    { email: 'valid@example.com', role: 'owner' },
    { email: 'valid@example.com', role: 'viewer', name: 42 },
  ])('rejects invalid registration %#', async (input) => {
    await expect(users.create(input as Parameters<UsersService['create']>[0])).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
    expect(users.list()).toEqual([]);
  });

  it('rejects invalid roles without altering the user and supports clearing a display name', async () => {
    const user = await users.create({ email: 'user@example.com', role: 'viewer', name: 'User' });
    expect(() => users.update(user.id, { role: 'owner' as Role })).toThrow(expect.objectContaining({ status: 400, code: 'invalid_request' }));
    expect(users.getById(user.id)).toEqual(user);
    expect(users.update(user.id, { name: null })).toMatchObject({ name: null, role: 'viewer' });
  });

  it('reports missing users through update and deletion', () => {
    expect(users.getById(999)).toBeNull();
    expect(users.getByEmail('missing@example.com')).toBeNull();
    expect(() => users.update(999, { role: 'editor' })).toThrow(expect.objectContaining({ status: 404, code: 'not_found' }));
    expect(() => users.delete(999)).toThrow(expect.objectContaining({ status: 404, code: 'not_found' }));
  });

  it('persists partial settings without replacing unrelated settings', () => {
    users.setSettings({ allowedDomains: ['EXAMPLE.COM'] });
    const reopenedService = new UsersService(new UsersRepository(db));
    expect(reopenedService.setSettings({ allowlistEnabled: false })).toEqual({ allowlistEnabled: false, allowedDomains: ['example.com'] });
    expect(users.getSettings()).toEqual({ allowlistEnabled: false, allowedDomains: ['example.com'] });
    expect(users.setSettings({ allowedDomains: [] })).toEqual({ allowlistEnabled: false, allowedDomains: [] });
  });

  it.each([
    { allowlistEnabled: 'false' },
    { allowedDomains: 'example.com' },
    { allowedDomains: [''] },
    { allowedDomains: ['https://example.com'] },
    { allowedDomains: ['user@example.com'] },
    { allowedDomains: ['*.example.com'] },
    { allowedDomains: ['-example.com'] },
    { allowedDomains: ['example..com'] },
    { allowlistEnabled: false, allowedDomains: ['example.com/'] },
    { unknownSetting: true },
  ])('rejects invalid settings atomically %#', (partial) => {
    const before = users.getSettings();
    expect(() => users.setSettings(partial as Partial<Settings>)).toThrow(expect.objectContaining({ status: 400, code: 'invalid_request' }));
    expect(users.getSettings()).toEqual(before);
  });
});

describe('admin-provisioned passwords', () => {
  it('creates with a hash and exposes only a boolean in every user projection', async () => {
    const user = await users.create({ email: 'user@example.com', role: 'viewer', password: 'a secure password' });
    const stored = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as { password_hash: string };
    expect(stored.password_hash).toMatch(/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
    expect(stored.password_hash).not.toContain('a secure password');
    for (const projection of [user, users.getById(user.id), users.getByEmail(user.email), users.list()[0], users.update(user.id, { name: 'Updated' })]) {
      expect(projection).toHaveProperty('hasPassword', true);
      expect(projection).not.toHaveProperty('password_hash');
      expect(projection).not.toHaveProperty('passwordHash');
      expect(projection).not.toHaveProperty('password');
    }
  });

  it('does not create an account when the initial password is weak', async () => {
    await expect(users.create({ email: 'user@example.com', role: 'viewer', password: 'short' }))
      .rejects.toMatchObject({ status: 400, code: 'weak_password' });
    expect(users.list()).toEqual([]);
  });

  it('sets, replaces, and clears a password without changing Google identity', async () => {
    const user = await users.create({ email: 'user@example.com', role: 'editor' });
    expect(user.hasPassword).toBe(false);
    await users.setPassword(user.id, 'first password');
    expect(users.getById(user.id)?.hasPassword).toBe(true);
    await users.setPassword(user.id, 'second password');
    await expect(users.passwordLogin(user.email, 'first password')).rejects.toMatchObject({ code: 'invalid_credentials' });
    await expect(users.passwordLogin(user.email, 'second password')).resolves.toMatchObject({ id: user.id, lastLoginAt: loginTime });
    users.clearPassword(user.id);
    expect(users.getById(user.id)?.hasPassword).toBe(false);
    await expect(users.passwordLogin(user.email, 'second password')).rejects.toMatchObject({ status: 401, code: 'invalid_credentials' });
    expect(users.canLogin(user.email)).toMatchObject({ ok: true, user: { id: user.id, hasPassword: false } });
  });

  it('requires the current password only when one is already set', async () => {
    const user = await users.create({ email: 'user@example.com', role: 'viewer' });
    await users.changePassword(user.id, undefined, 'first password');
    for (const current of [undefined, 'wrong password', 'short']) {
      await expect(users.changePassword(user.id, current, 'second password'))
        .rejects.toMatchObject({ status: 400, code: 'invalid_current_password' });
    }
    await expect(users.passwordLogin(user.email, 'first password')).resolves.toMatchObject({ id: user.id });
    await expect(users.changePassword(user.id, 'first password', 'short'))
      .rejects.toMatchObject({ status: 400, code: 'weak_password' });
    await users.changePassword(user.id, 'first password', 'second password');
    await expect(users.passwordLogin(user.email, 'first password')).rejects.toMatchObject({ code: 'invalid_credentials' });
    await expect(users.passwordLogin(user.email, 'second password')).resolves.toMatchObject({ id: user.id });
  });

  it('returns uniform invalid credentials for unknown users, missing hashes, wrong passwords, and malformed identities', async () => {
    await users.create({ email: 'google@example.com', role: 'viewer' });
    await users.create({ email: 'password@example.com', role: 'viewer', password: 'correct password' });
    for (const [email, password] of [
      ['unknown@example.com', 'correct password'],
      ['google@example.com', 'correct password'],
      ['password@example.com', 'wrong password'],
      ['password@example.com', 'short'],
      ['not-an-email', 'correct password'],
    ]) {
      await expect(users.passwordLogin(email!, password!))
        .rejects.toMatchObject({ status: 401, code: 'invalid_credentials', message: 'Invalid email or password' });
    }
    expect(users.list().every((user) => user.lastLoginAt === null)).toBe(true);
  });

  it.each([true, false])('never auto-provisions a password login with allowlistEnabled=%s', async (allowlistEnabled) => {
    users.setSettings({ allowlistEnabled });
    await expect(users.passwordLogin('new@example.com', 'correct password'))
      .rejects.toMatchObject({ status: 401, code: 'invalid_credentials' });
    expect(users.list()).toEqual([]);
  });

  it('applies email domain policy without a Workspace claim and records only successful login times', async () => {
    const user = await users.create({ email: ' USER@Example.com ', role: 'viewer', password: 'correct password' });
    users.setSettings({ allowedDomains: [' EXAMPLE.COM '] });
    await expect(users.passwordLogin('USER@EXAMPLE.COM', 'correct password'))
      .resolves.toMatchObject({ id: user.id, lastLoginAt: loginTime });
    users.setSettings({ allowedDomains: ['other.com'] });
    vi.setSystemTime(new Date('2026-10-08T12:00:00.000Z'));
    await expect(users.passwordLogin(user.email, 'wrong password')).rejects.toMatchObject({ status: 401, code: 'invalid_credentials' });
    await expect(users.passwordLogin(user.email, 'correct password')).rejects.toMatchObject({ status: 403, code: 'login_denied' });
    expect(users.getById(user.id)?.lastLoginAt).toBe(loginTime);
    users.setSettings({ allowedDomains: [] });
    await expect(users.passwordLogin(user.email, 'correct password'))
      .resolves.toMatchObject({ id: user.id, lastLoginAt: '2026-10-08T12:00:00.000Z' });
  });

  it('reports missing users for password mutations', async () => {
    await expect(users.setPassword(999, 'correct password')).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await expect(users.changePassword(999, undefined, 'correct password')).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect(() => users.clearPassword(999)).toThrow(expect.objectContaining({ status: 404, code: 'not_found' }));
  });

  it('rejects login when an administrator changes the password during scrypt verification', async () => {
    const user = await users.create({ email: 'user@example.com', role: 'viewer', password: 'correct password' });
    const pending = users.passwordLogin(user.email, 'correct password');
    users.clearPassword(user.id);
    await expect(pending).rejects.toMatchObject({ status: 401, code: 'invalid_credentials' });
    expect(users.getById(user.id)?.lastLoginAt).toBeNull();
  });

  it('does not overwrite a concurrently cleared password during self-service change', async () => {
    const user = await users.create({ email: 'user@example.com', role: 'viewer', password: 'correct password' });
    const pending = users.changePassword(user.id, 'correct password', 'replacement password');
    users.clearPassword(user.id);
    await expect(pending).rejects.toMatchObject({ status: 400, code: 'invalid_current_password' });
    expect(users.getById(user.id)?.hasPassword).toBe(false);
  });

  it('does not install a password for a deleted user after hashing finishes', async () => {
    const user = await users.create({ email: 'user@example.com', role: 'viewer' });
    const pending = users.setPassword(user.id, 'replacement password');
    users.delete(user.id);
    await expect(pending).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect(users.list()).toEqual([]);
  });

  it('does not install a first password after a concurrent clear of an already-unset credential', async () => {
    const user = await users.create({ email: 'user@example.com', role: 'viewer' });
    const pending = users.changePassword(user.id, undefined, 'replacement password');
    users.clearPassword(user.id);
    await expect(pending).rejects.toMatchObject({ status: 400, code: 'invalid_current_password' });
    expect(users.getById(user.id)?.hasPassword).toBe(false);
    expect(new UsersRepository(db).getPasswordCredential(user.id)).toEqual({ hash: null, revision: 1 });
  });

  it('detects a null credential ABA change while a first password is hashing', async () => {
    const user = await users.create({ email: 'user@example.com', role: 'viewer' });
    const repository = new UsersRepository(db);
    const pending = users.changePassword(user.id, undefined, 'replacement password');
    repository.setPasswordHash(user.id, 'temporary-credential');
    users.clearPassword(user.id);
    await expect(pending).rejects.toMatchObject({ status: 400, code: 'invalid_current_password' });
    expect(repository.getPasswordCredential(user.id)).toEqual({ hash: null, revision: 2 });
  });

  it('detects a login credential ABA change even when the original hash is restored', async () => {
    const user = await users.create({ email: 'user@example.com', role: 'viewer', password: 'correct password' });
    const repository = new UsersRepository(db);
    const original = repository.getPasswordCredential(user.id)!;
    const pending = users.passwordLogin(user.email, 'correct password');
    users.clearPassword(user.id);
    repository.setPasswordHash(user.id, original.hash);
    await expect(pending).rejects.toMatchObject({ status: 401, code: 'invalid_credentials' });
    expect(users.getById(user.id)?.lastLoginAt).toBeNull();
  });

  it('completes login and session issuance inside the credential-check transaction', async () => {
    const user = await users.create({ email: 'user@example.com', role: 'viewer', password: 'correct password' });
    const result = await users.passwordLogin(user.email, 'correct password', (loggedInUser) => {
      expect(db.inTransaction).toBe(true);
      expect(loggedInUser).toMatchObject({ id: user.id, lastLoginAt: loginTime });
      db.prepare('INSERT INTO web_sessions(id_hash,user_id,expires_at) VALUES(?,?,?)')
        .run('completion-session', user.id, '2099-01-01T00:00:00.000Z');
      return { completedFor: loggedInUser.id };
    });
    expect(result).toEqual({ completedFor: user.id });
    expect(db.prepare('SELECT user_id FROM web_sessions').all()).toEqual([{ user_id: user.id }]);
    expect(users.getById(user.id)?.lastLoginAt).toBe(loginTime);
  });

  it('rolls back last login and completion side effects when login completion fails', async () => {
    const user = await users.create({ email: 'user@example.com', role: 'viewer', password: 'correct password' });
    const failure = new Error('Login completion failed');
    await expect(users.passwordLogin(user.email, 'correct password', () => {
      expect(db.inTransaction).toBe(true);
      db.prepare('INSERT INTO web_sessions(id_hash,user_id,expires_at) VALUES(?,?,?)')
        .run('failed-session', user.id, '2099-01-01T00:00:00.000Z');
      throw failure;
    })).rejects.toBe(failure);
    expect(users.getById(user.id)?.lastLoginAt).toBeNull();
    expect(db.prepare('SELECT * FROM web_sessions').all()).toEqual([]);
  });

  it.each(['set', 'change', 'clear'])('rolls back %s and revocation together when the mutation callback fails', async (operation) => {
    const user = await users.create({ email: 'user@example.com', role: 'viewer', password: 'correct password' });
    const repository = new UsersRepository(db);
    const original = repository.getPasswordCredential(user.id);
    db.prepare('INSERT INTO web_sessions(id_hash,user_id,expires_at) VALUES(?,?,?)')
      .run('existing-session', user.id, '2099-01-01T00:00:00.000Z');
    const failure = new Error('Revocation failed');
    const onChanged = () => {
      expect(db.inTransaction).toBe(true);
      expect(repository.getPasswordCredential(user.id)?.revision).toBe(1);
      db.prepare('DELETE FROM web_sessions WHERE user_id = ?').run(user.id);
      throw failure;
    };
    if (operation === 'set') await expect(users.setPassword(user.id, 'replacement password', onChanged)).rejects.toBe(failure);
    if (operation === 'change') await expect(users.changePassword(user.id, 'correct password', 'replacement password', onChanged)).rejects.toBe(failure);
    if (operation === 'clear') expect(() => users.clearPassword(user.id, onChanged)).toThrow(failure);
    expect(repository.getPasswordCredential(user.id)).toEqual(original);
    expect(db.prepare('SELECT id_hash FROM web_sessions').all()).toEqual([{ id_hash: 'existing-session' }]);
  });
});
