import Database from 'better-sqlite3';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sqliteVec from 'sqlite-vec';

export type Db = Database.Database;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    sqliteVec.load(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function runMigrations(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const migrationsDir = fileURLToPath(new URL('./migrations/', import.meta.url));
  const applied = db.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>;
  const known = new Set(applied.map(({ name }) => name));
  const record = db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)');
  for (const name of readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort()) {
    if (known.has(name)) continue;
    const sql = readFileSync(join(migrationsDir, name), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      record.run(name, new Date().toISOString());
    })();
  }
}
