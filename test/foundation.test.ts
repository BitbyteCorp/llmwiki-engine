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
  it('parses the autostart safety switch without treating false as truthy', () => {
    expect(loadConfig({ JOBS_AUTOSTART: 'false' }).jobsAutostart).toBe(false);
    expect(loadConfig({ JOBS_AUTOSTART: 'true' }).jobsAutostart).toBe(true);
    expect(() => loadConfig({ JOBS_AUTOSTART: '0' })).toThrow(/JOBS_AUTOSTART/);
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
        INSERT INTO imports (id, user_id, kind, source, sha, status, raw_paths, error, created_at, updated_at, finished_at)
          VALUES ('unlinked', 1, 'text', 'other', 'hash', 'failed', '["raw/source.md"]', 'extraction failed', '2026-01-01', '2026-01-03', '2026-01-03');
        UPDATE imports SET rowid = 42 WHERE id = 'unlinked';
        CREATE INDEX imports_status_probe ON imports(status);
        CREATE TABLE import_update_probe (id TEXT);
        CREATE TRIGGER imports_update_probe AFTER UPDATE ON imports BEGIN
          INSERT INTO import_update_probe (id) VALUES (new.id);
        END;
        CREATE INDEX write_jobs_summary ON write_jobs(summary);
        CREATE TABLE job_update_probe (id TEXT);
        CREATE TRIGGER write_jobs_update_probe AFTER UPDATE ON write_jobs BEGIN
          INSERT INTO job_update_probe (id) VALUES (new.id);
        END;
      `);
      const jobs = db.prepare('SELECT rowid, * FROM write_jobs ORDER BY rowid').all() as Array<{ kind: string }>;
      const events = db.prepare('SELECT * FROM write_job_events').all();
      const imports = db.prepare('SELECT rowid, * FROM imports ORDER BY rowid').all() as Array<{ job_id: string | null }>;
      const importColumns = db.pragma('table_info(imports)') as Array<{ cid: number; name: string }>;
      const schemaSql = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type IN ('index', 'trigger') ORDER BY name");
      const schema = schemaSql.all();
      const replacedChunkTriggers = ['chunks_insert', 'chunks_delete', 'chunks_update'];
      const expectedSchema = [...schema.filter((entry) => entry.name !== 'imports_job' && !replacedChunkTriggers.includes(String(entry.name))), {
        name: 'write_jobs_dedupe_key_active',
        sql: `CREATE UNIQUE INDEX write_jobs_dedupe_key_active
  ON write_jobs(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status <> 'failed'`,
      }].sort((left, right) => String(left.name) < String(right.name) ? -1 : String(left.name) > String(right.name) ? 1 : 0);
      const foreignKeys = db.pragma('foreign_key_list(write_job_events)');
      runMigrations(db);
      expect(db.prepare('SELECT rowid, * FROM write_jobs ORDER BY rowid').all()).toEqual(jobs.map((job) => ({
        ...job, dedupe_key: null, required_reads: '[]', kind: job.kind === historicalJobKind ? 'agent' : job.kind,
      })));
      expect(db.prepare('SELECT * FROM write_job_events').all()).toEqual(events);
      const retryColumns = ['retained_text', 'filename', 'instructions', 'raw_committed'];
      const upgradedImports = db.prepare('SELECT rowid, * FROM imports ORDER BY rowid').all() as Array<Record<string, unknown>>;
      expect(upgradedImports.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !retryColumns.includes(key)))))
        .toEqual(imports.map(({ job_id: _jobId, ...row }) => row));
      // 025 backfills raw_committed only for imports that already reached an integration job.
      expect(upgradedImports.map((row) => [row.id, row.raw_committed])).toEqual([['import', 1], ['unlinked', 0]]);
      expect((db.pragma('table_info(imports)') as Array<{ name: string }>).filter((column) => !retryColumns.includes(column.name)))
        .toEqual(importColumns.filter((column) => column.name !== 'job_id').map((column, cid) => ({ ...column, cid })));
      expect(db.prepare('SELECT * FROM import_jobs').all()).toEqual([{ import_id: 'import', batch: 0, job_id: 'historical', files: '[]' }]);
      expect(schemaSql.all()).toEqual(expect.arrayContaining(expectedSchema));
      const triggerSql = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?");
      for (const name of replacedChunkTriggers) {
        const trigger = triggerSql.get(name) as { sql: string } | undefined;
        expect(trigger).toBeDefined();
        for (const table of ['chunks_fts', 'chunks_terms']) {
          const deleteColumn = name === 'chunks_insert' ? '' : `${table},`;
          expect(trigger?.sql).toContain(`INSERT INTO ${table}(${deleteColumn}rowid,title,heading,tags,content,description,aliases)`);
        }
        if (name !== 'chunks_delete') expect(trigger?.sql).toContain('new.description,new.aliases');
        if (name !== 'chunks_insert') expect(trigger?.sql).toContain('old.description,old.aliases');
        if (name === 'chunks_update') {
          expect(trigger?.sql).toContain('AFTER UPDATE OF title,heading,tags,content,description,aliases ON chunks');
        }
      }
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'imports_job'").get()).toBeUndefined();
      expect(db.pragma('index_info(import_jobs_job)')).toEqual([{ seqno: 0, cid: 2, name: 'job_id' }]);
      expect(db.pragma('foreign_key_list(write_job_events)')).toEqual(foreignKeys);
      expect(db.pragma('foreign_key_list(imports)')).toEqual([
        { id: 0, seq: 0, table: 'users', from: 'user_id', to: 'id', on_update: 'NO ACTION', on_delete: 'NO ACTION', match: 'NONE' },
      ]);
      expect(db.pragma('foreign_key_list(import_jobs)')).toEqual([
        { id: 0, seq: 0, table: 'imports', from: 'import_id', to: 'id', on_update: 'NO ACTION', on_delete: 'CASCADE', match: 'NONE' },
      ]);
      expect(() => db.exec("INSERT INTO import_jobs VALUES ('import', 0, 'duplicate', '[]')")).toThrow(/UNIQUE/);
      expect(() => db.exec("INSERT INTO import_jobs VALUES ('missing', 0, 'historical', '[]')")).toThrow(/FOREIGN KEY/);
      // 025's raw_committed backfill is itself an UPDATE; only the post-migration update matters here.
      db.exec('DELETE FROM import_update_probe');
      db.exec("UPDATE imports SET error = 'updated' WHERE id = 'import'");
      expect(db.prepare('SELECT * FROM import_update_probe').all()).toEqual([{ id: 'import' }]);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      db.exec("UPDATE write_jobs SET summary = 'updated' WHERE id = 'historical'");
      expect(db.prepare('SELECT * FROM job_update_probe').all()).toEqual([{ id: 'historical' }]);
      db.exec("INSERT INTO write_jobs (id, user_id, source, input, status, created_at) VALUES ('default', 1, 'web', 'input', 'queued', '2026-01-04')");
      expect(db.prepare("SELECT kind FROM write_jobs WHERE id = 'default'").get()).toEqual({ kind: 'agent' });
      expect(() => insert.run('obsolete', historicalJobKind)).toThrow();
      expect(() => db.exec("INSERT INTO write_job_events (job_id, phase, at) VALUES ('missing', 'queued', '2026-01-04')")).toThrow();
      db.exec("DELETE FROM write_jobs WHERE id = 'historical'");
      expect(db.prepare('SELECT * FROM import_jobs').all()).toEqual([{ import_id: 'import', batch: 0, job_id: 'historical', files: '[]' }]);
      db.exec("DELETE FROM imports WHERE id = 'import'");
      expect(db.prepare('SELECT * FROM import_jobs').all()).toEqual([]);
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
  it.each(['ON', 'OFF'])('rolls back an invalid import rebuild and restores foreign_keys = %s', (enforcement) => {
    const db = openDb(':memory:');
    try {
      runMigrations(db);
      db.exec('DROP TABLE import_jobs; DROP TABLE imports');
      db.exec(readFileSync(fileURLToPath(new URL('../src/db/migrations/012_ingest.sql', import.meta.url)), 'utf8'));
      db.prepare('DELETE FROM schema_migrations WHERE name = ?').run('020_import_jobs.sql');
      db.pragma('foreign_keys = OFF');
      db.exec(`INSERT INTO imports (id, user_id, kind, source, status, created_at, updated_at)
        VALUES ('orphan', 999, 'text', 'source', 'failed', '2026-01-01', '2026-01-01')`);
      db.pragma(`foreign_keys = ${enforcement}`);
      expect(() => runMigrations(db)).toThrow(/Foreign key violations after migration 020_import_jobs.sql/);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(enforcement === 'ON' ? 1 : 0);
      expect(db.prepare("SELECT job_id FROM imports WHERE id = 'orphan'").get()).toEqual({ job_id: null });
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'imports_job'").get()).toEqual({ name: 'imports_job' });
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'import_jobs'").get()).toBeUndefined();
      expect(db.prepare("SELECT name FROM schema_migrations WHERE name = '020_import_jobs.sql'").get()).toBeUndefined();
      db.exec("DELETE FROM imports WHERE id = 'orphan'");
      runMigrations(db);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(enforcement === 'ON' ? 1 : 0);
    } finally {
      db.close();
    }
  });
});
