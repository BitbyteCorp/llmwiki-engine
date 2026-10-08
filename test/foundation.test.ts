import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { openDb, runMigrations, type Db } from '../src/db/index.js';

function migrateHistoricalDb(db: Db): string {
  const directory = fileURLToPath(new URL('../src/db/migrations/', import.meta.url));
  db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const record = db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)');
  for (const name of readdirSync(directory).filter((name) => name.endsWith('.sql') && name < '016_').sort()) {
    const sql = readFileSync(join(directory, name), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      record.run(name, '2026-01-01T00:00:00.000Z');
    })();
  }
  const { dflt_value: defaultValue } = db.prepare("SELECT dflt_value FROM pragma_table_info('write_jobs') WHERE name = 'kind'").get() as { dflt_value: string };
  return defaultValue.slice(1, -1);
}

describe('environment safety', () => {
  it('refuses development login in production even with a session secret', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'secret', DEV_LOGIN_EMAIL: 'admin@example.com' })).toThrow(/DEV_LOGIN_EMAIL/);
  });
  it('requires a production session secret', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/SESSION_SECRET/);
  });
  it('selects the first configured model after trimming and dropping empty entries', () => {
    const config = loadConfig({ LLM_MODELS: ' , model-one, , model-two, ', LLM_REASONING_EFFORT: 'high' });
    expect(config.llmModels).toEqual(['model-one', 'model-two']);
    expect(config.llmModel).toBe('model-one');
    expect(config.llmReasoningEffort).toBe('high');
    expect(() => loadConfig({ LLM_MODELS: ' , , ' })).toThrow();
    expect(() => loadConfig({ LLM_REASONING_EFFORT: '' })).toThrow();
  });
  it('uses the default model and agent identity', () => {
    const config = loadConfig({});
    expect(config.llmModels).toEqual(['gpt-6-luna']);
    expect(config.llmModel).toBe('gpt-6-luna');
    expect(config.llmReasoningEffort).toBe('medium');
    expect(config.gitBotName).toBe('도니');
    expect(config.gitBotEmail).toBe('dony@llmwiki.local');
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
  it('upgrades historical jobs without losing rows, indexes, triggers or child references', () => {
    const db = openDb(':memory:');
    try {
      const historicalJobKind = migrateHistoricalDb(db);
      db.prepare('INSERT INTO users (id, email, role, created_at) VALUES (1, ?, ?, ?)').run('writer@example.com', 'editor', '2026-01-01');
      const insert = db.prepare(`INSERT INTO write_jobs
        (id, user_id, kind, source, client, input, status, summary, commits, conflicts, merge_sha, error, created_at, started_at, finished_at)
        VALUES (?, 1, ?, 'import', 'client', 'input', 'failed', 'summary', '["commit"]', '["note.md"]', 'merge', 'error', '2026-01-01', '2026-01-02', '2026-01-03')`);
      insert.run('historical', historicalJobKind);
      insert.run('direct', 'direct');
      insert.run('revert', 'revert');
      db.exec("UPDATE write_jobs SET rowid = 42 WHERE id = 'direct'");
      db.exec(`
        INSERT INTO write_job_events (job_id, phase, at, detail) VALUES ('historical', 'queued', '2026-01-01', '{"retryOf":"earlier"}');
        INSERT INTO imports (id, user_id, kind, source, status, job_id, created_at, updated_at)
          VALUES ('import', 1, 'text', 'source', 'failed', 'historical', '2026-01-01', '2026-01-03');
        CREATE INDEX write_jobs_summary ON write_jobs(summary);
        CREATE TABLE job_update_probe (id TEXT);
        CREATE TRIGGER write_jobs_update_probe AFTER UPDATE ON write_jobs BEGIN
          INSERT INTO job_update_probe (id) VALUES (new.id);
        END;
      `);
      const jobs = db.prepare('SELECT rowid, * FROM write_jobs ORDER BY rowid').all() as Array<{ kind: string }>;
      const events = db.prepare('SELECT * FROM write_job_events').all();
      const imports = db.prepare('SELECT * FROM imports').all();
      const schemaSql = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type IN ('index', 'trigger') ORDER BY name");
      const schema = schemaSql.all();
      const expectedSchema = [...schema, {
        name: 'write_jobs_dedupe_key_active',
        sql: `CREATE UNIQUE INDEX write_jobs_dedupe_key_active
  ON write_jobs(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status <> 'failed'`,
      }].sort((left, right) => String(left.name) < String(right.name) ? -1 : String(left.name) > String(right.name) ? 1 : 0);
      const foreignKeys = db.prepare("SELECT * FROM pragma_foreign_key_list('imports') UNION ALL SELECT * FROM pragma_foreign_key_list('write_job_events')").all();
      runMigrations(db);
      expect(db.prepare('SELECT rowid, * FROM write_jobs ORDER BY rowid').all()).toEqual(jobs.map((job) => ({
        ...job, dedupe_key: null, kind: job.kind === historicalJobKind ? 'agent' : job.kind,
      })));
      expect(db.prepare('SELECT * FROM write_job_events').all()).toEqual(events);
      expect(db.prepare('SELECT * FROM imports').all()).toEqual(imports);
      expect(schemaSql.all()).toEqual(expect.arrayContaining(expectedSchema));
      expect(db.prepare("SELECT * FROM pragma_foreign_key_list('imports') UNION ALL SELECT * FROM pragma_foreign_key_list('write_job_events')").all()).toEqual(foreignKeys);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      db.exec("UPDATE write_jobs SET summary = 'updated' WHERE id = 'historical'");
      expect(db.prepare('SELECT * FROM job_update_probe').all()).toEqual([{ id: 'historical' }]);
      db.exec("INSERT INTO write_jobs (id, user_id, source, input, status, created_at) VALUES ('default', 1, 'web', 'input', 'queued', '2026-01-04')");
      expect(db.prepare("SELECT kind FROM write_jobs WHERE id = 'default'").get()).toEqual({ kind: 'agent' });
      expect(() => insert.run('obsolete', historicalJobKind)).toThrow();
      expect(() => db.exec("INSERT INTO write_job_events (job_id, phase, at) VALUES ('missing', 'queued', '2026-01-04')")).toThrow();
      expect(() => db.exec("DELETE FROM write_jobs WHERE id = 'historical'")).toThrow();
      db.exec("DELETE FROM imports WHERE id = 'import'; DELETE FROM write_jobs WHERE id = 'historical'");
      expect(db.prepare('SELECT * FROM write_job_events').all()).toEqual([]);
      runMigrations(db);
    } finally {
      db.close();
    }
  });
  it('rolls back the job rebuild and restores enforcement when foreign key validation fails', () => {
    const db = openDb(':memory:');
    try {
      const historicalJobKind = migrateHistoricalDb(db);
      db.prepare("INSERT INTO write_jobs (id, user_id, kind, source, input, status, created_at) VALUES ('job', 1, ?, 'web', 'input', 'queued', '2026-01-01')").run(historicalJobKind);
      db.pragma('foreign_keys = OFF');
      db.exec("INSERT INTO write_job_events (job_id, phase, at) VALUES ('missing', 'queued', '2026-01-01')");
      db.pragma('foreign_keys = ON');
      expect(() => runMigrations(db)).toThrow(/Foreign key violations/);
      expect(db.prepare("SELECT kind FROM write_jobs WHERE id = 'job'").get()).toEqual({ kind: historicalJobKind });
      expect(db.prepare('SELECT count(*) AS total FROM schema_migrations').get()).toEqual({ total: 15 });
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      db.exec("DELETE FROM write_job_events WHERE job_id = 'missing'");
      runMigrations(db);
      expect(db.prepare("SELECT kind FROM write_jobs WHERE id = 'job'").get()).toEqual({ kind: 'agent' });
    } finally {
      db.close();
    }
  });
});
