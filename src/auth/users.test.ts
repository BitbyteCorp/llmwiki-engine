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
  for (const migration of ['001_core.sql', '002_auth.sql', '011_platform.sql', '013_acl.sql']) {
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
  ])('$label', ({ existing, allowlist, domains, email, hd, ok }) => {
    const original = existing ? users.create({ email, role: 'editor', name: 'Registered User' }) : null;
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

  it('records each successful login but leaves the last successful login intact on denial', () => {
    const user = users.create({ email: 'user@example.com', role: 'viewer' });
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
  it.each<Role>(['editor', 'viewer'])('rejects demoting the only administrator to %s without changing their name', (role) => {
    const admin = users.create({ email: 'admin@example.com', role: 'admin', name: 'Original' });
    expect(() => users.update(admin.id, { role, name: 'Changed' })).toThrow(expect.objectContaining({ status: 409, code: 'last_admin' }));
    expect(users.getById(admin.id)).toEqual(admin);
  });

  it('rejects deleting the only administrator', () => {
    const admin = users.create({ email: 'admin@example.com', role: 'admin' });
    expect(() => users.delete(admin.id)).toThrow(expect.objectContaining({ status: 409, code: 'last_admin' }));
    expect(users.getById(admin.id)).toEqual(admin);
  });

  it('allows changing the only administrator name and preserving their role', () => {
    const admin = users.create({ email: 'admin@example.com', role: 'admin' });
    expect(users.update(admin.id, { name: 'Renamed', role: 'admin' })).toMatchObject({ name: 'Renamed', role: 'admin' });
  });

  it('allows demotion with another administrator, then protects the remaining administrator', () => {
    const first = users.create({ email: 'first@example.com', role: 'admin' });
    const second = users.create({ email: 'second@example.com', role: 'admin' });
    expect(users.update(first.id, { role: 'editor' }).role).toBe('editor');
    users.delete(first.id);
    expect(users.getById(first.id)).toBeNull();
    expect(() => users.delete(second.id)).toThrow(expect.objectContaining({ code: 'last_admin' }));
  });

  it('allows deleting one administrator, then prevents demotion of the remaining administrator', () => {
    const first = users.create({ email: 'first@example.com', role: 'admin' });
    const second = users.create({ email: 'second@example.com', role: 'admin' });
    users.delete(first.id);
    expect(users.getById(first.id)).toBeNull();
    expect(() => users.update(second.id, { role: 'viewer' })).toThrow(expect.objectContaining({ code: 'last_admin' }));
  });
});

describe('user and settings validation', () => {
  it('canonicalizes email identity and reports duplicate registration as a conflict', () => {
    const user = users.create({ email: ' Admin@Example.com ', role: 'admin' });
    expect(users.getByEmail('ADMIN@example.com')).toEqual(user);
    expect(() => users.create({ email: 'admin@example.com', role: 'viewer' })).toThrow(expect.objectContaining({ status: 409, code: 'conflict' }));
    expect(users.list()).toEqual([user]);
  });

  it.each([
    { email: 'invalid', role: 'viewer' },
    { email: 'valid@example.com', role: 'owner' },
    { email: 'valid@example.com', role: 'viewer', name: 42 },
  ])('rejects invalid registration %#', (input) => {
    expect(() => users.create(input as Parameters<UsersService['create']>[0])).toThrow(expect.objectContaining({ status: 400, code: 'invalid_request' }));
    expect(users.list()).toEqual([]);
  });

  it('rejects invalid roles without altering the user and supports clearing a display name', () => {
    const user = users.create({ email: 'user@example.com', role: 'viewer', name: 'User' });
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
