import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openDb, runMigrations } from '../src/db/index.js';

describe('environment safety', () => {
  it('refuses development login in production even with a session secret', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'secret', DEV_LOGIN_EMAIL: 'admin@example.com' })).toThrow(/DEV_LOGIN_EMAIL/);
  });
  it('requires a production session secret', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/SESSION_SECRET/);
  });
});

describe('core database', () => {
  it('preserves user data and settings when migrations run again after reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'llmwiki-foundation-'));
    const path = join(directory, 'nested', 'llmwiki.db');
    let db = openDb(path);
    try {
      runMigrations(db);
      db.prepare('INSERT INTO users (email, role, created_at) VALUES (?, ?, ?)').run('admin@example.com', 'admin', new Date().toISOString());
      db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('false', 'allowlist_enabled');
      db.close();
      db = openDb(path);
      runMigrations(db);
      expect(db.prepare('SELECT email, role FROM users').all()).toEqual([{ email: 'admin@example.com', role: 'admin' }]);
      expect(db.prepare('SELECT value FROM settings WHERE key = ?').get('allowlist_enabled')).toEqual({ value: 'false' });
      expect(db.prepare('SELECT value FROM settings WHERE key = ?').get('allowed_domains')).toEqual({ value: '[]' });
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.prepare('SELECT vec_length(vec_f32(?)) AS dimensions').get('[1,2,3]')).toEqual({ dimensions: 3 });
      expect(() => db.prepare('INSERT INTO users (email, role, created_at) VALUES (?, ?, ?)').run('bad@example.com', 'owner', new Date().toISOString())).toThrow();
    } finally {
      if (db.open) db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
