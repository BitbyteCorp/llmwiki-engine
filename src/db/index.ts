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
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('cache_size = -32768');
    db.pragma('mmap_size = 268435456');
    db.pragma('temp_store = MEMORY');
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
    // A SQL marker opts a table rebuild into FK suspension and schema-object preservation.
    const rebuiltTable = sql.match(/^-- rebuild-table: ([a-z_][a-z0-9_]*)$/m)?.[1];
    if (rebuiltTable && db.inTransaction) throw new Error(`Migration ${name} must run outside an existing transaction`);
    const foreignKeys = rebuiltTable ? db.pragma('foreign_keys', { simple: true }) : undefined;
    const preservedSchema = rebuiltTable
      ? db.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL").all(rebuiltTable) as Array<{ sql: string }>
      : [];
    if (rebuiltTable) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(sql);
        for (const entry of preservedSchema) db.exec(entry.sql);
        if (rebuiltTable && (db.pragma('foreign_key_check') as unknown[]).length > 0) {
          throw new Error(`Foreign key violations after migration ${name}`);
        }
        record.run(name, new Date().toISOString());
      })();
    } finally {
      if (rebuiltTable) db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
    }
  }
}
