import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { Config } from '../config.js';
import { bundleMain, git } from '../export/git.js';
import { archivePath, pack, unpack } from './archive.js';

const shaSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
const manifestSchema = z.object({
  version: z.literal(1), schemaVersion: z.string(), migrations: z.array(z.string()).min(1),
  headSha: shaSchema, startedAt: z.iso.datetime(), createdAt: z.iso.datetime(),
  checksums: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
});
export type BackupManifest = z.infer<typeof manifestSchema>;
export interface BackupResult extends BackupManifest { path: string }

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }
function hasTable(db: Database.Database, name: string): boolean {
  return !!db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', name);
}
function snapshotDb(path: string): Database.Database {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try { sqliteVec.load(db); return db; } catch (error) { db.close(); throw error; }
}
function migrations(db: Database.Database): string[] {
  return (db.prepare('SELECT name FROM schema_migrations ORDER BY name').all() as Array<{ name: string }>).map((row) => row.name);
}
function uploadPaths(db: Database.Database): string[] {
  if (!hasTable(db, 'uploads')) return [];
  return (db.prepare('SELECT id FROM uploads ORDER BY id').all() as Array<{ id: string }>).map(({ id }) => {
    const path = `uploads/${id}`;
    if (!archivePath(path)) throw new Error(`Unsafe upload id: ${id}`);
    return path;
  });
}
async function checksum(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
function audit(db: Database.Database, action: string, target: string): void {
  if (hasTable(db, 'audit_events')) new AuditService(db).record({ actorId: null, action, target, outcome: 'success', summary: 'Offline CLI operation' });
}

/** Standalone: never bootstrap Nest, run migrations, or open KnowledgeRepo during restore. */
export class BackupService {
  constructor(private readonly config: Config) {}

  async create(output: string): Promise<BackupResult> {
    const path = resolve(output);
    const directory = await mkdtemp(join(tmpdir(), 'llmwiki-backup-'));
    const startedAt = new Date().toISOString();
    let db: Database.Database | undefined;
    try {
      db = new Database(join(this.config.dataDir, 'llmwiki.db'), { fileMustExist: true });
      sqliteVec.load(db);
      await db.backup(join(directory, 'llmwiki.db'));
      const snapshot = snapshotDb(join(directory, 'llmwiki.db'));
      let applied: string[];
      let uploads: string[];
      try { applied = migrations(snapshot); uploads = uploadPaths(snapshot); } finally { snapshot.close(); }
      if (!applied.length) throw new Error('Database has no recorded schema migrations');
      for (const upload of uploads) {
        const source = join(this.config.dataDir, upload);
        if (!(await lstat(source)).isFile()) throw new Error(`Upload is not a regular file: ${upload}`);
        await mkdir(dirname(join(directory, upload)), { recursive: true });
        // Upload bytes are immutable. Missing/deleted referenced files abort the backup.
        await copyFile(source, join(directory, upload));
      }
      const headSha = await bundleMain(join(this.config.dataDir, 'knowledge'), join(directory, 'knowledge.bundle'));
      const checksums: Record<string, string> = {};
      const files = ['llmwiki.db', 'knowledge.bundle', ...uploads];
      for (const file of files) checksums[file] = await checksum(join(directory, file));
      const manifest: BackupManifest = { version: 1, schemaVersion: applied.at(-1)!, migrations: applied, headSha, startedAt, createdAt: new Date().toISOString(), checksums };
      await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      await pack(directory, ['manifest.json', ...files], path);
      const result = { path, ...manifest };
      await writeFile(join(this.config.dataDir, 'last-backup.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
      audit(db, 'backup.create', path);
      return result;
    } finally { db?.close(); await rm(directory, { recursive: true, force: true }); }
  }

  async verify(archive: string): Promise<BackupResult> {
    const directory = await mkdtemp(join(tmpdir(), 'llmwiki-verify-'));
    try { return { path: resolve(archive), ...await this.extractVerified(archive, directory) }; }
    finally { await rm(directory, { recursive: true, force: true }); }
  }

  private async extractVerified(archive: string, directory: string): Promise<BackupManifest> {
    const files = await unpack(resolve(archive), directory);
    if (!files.includes('manifest.json')) throw new Error('Backup manifest is missing');
    const manifest = manifestSchema.parse(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')));
    const payload = files.filter((path) => path !== 'manifest.json').sort();
    const recorded = Object.keys(manifest.checksums).sort();
    if (JSON.stringify(payload) !== JSON.stringify(recorded) || !recorded.includes('llmwiki.db') || !recorded.includes('knowledge.bundle')) {
      throw new Error('Backup manifest does not match archive members');
    }
    for (const path of recorded) {
      if (!archivePath(path) || await checksum(join(directory, path)) !== manifest.checksums[path]) throw new Error(`Backup checksum mismatch: ${path}`);
    }
    const db = snapshotDb(join(directory, 'llmwiki.db'));
    try {
      if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('Backup database integrity check failed');
      const applied = migrations(db);
      const known = (await readdir(fileURLToPath(new URL('../db/migrations/', import.meta.url)))).filter((path) => path.endsWith('.sql')).sort();
      if (JSON.stringify(applied) !== JSON.stringify(manifest.migrations) || applied.at(-1) !== manifest.schemaVersion) throw new Error('Backup schema version does not match database');
      if (JSON.stringify(applied) !== JSON.stringify(known.slice(0, applied.length))) throw new Error('Backup schema is incompatible with this engine; upgrade the engine before restoring');
      const uploads = uploadPaths(db);
      if (JSON.stringify(uploads) !== JSON.stringify(recorded.filter((path) => path.startsWith('uploads/')))) throw new Error('Backup upload references do not match archive');
    } finally { db.close(); }
    const repo = join(directory, 'knowledge');
    await git(directory, ['init', '-b', 'main', repo]);
    await git(repo, ['bundle', 'verify', join(directory, 'knowledge.bundle')]);
    const heads = (await git(repo, ['bundle', 'list-heads', join(directory, 'knowledge.bundle')])).trim().split('\n');
    if (heads.length !== 1 || heads[0] !== `${manifest.headSha} refs/heads/main`) throw new Error('Backup bundle HEAD does not match manifest');
    return manifest;
  }

  async restore(archive: string, options: { force?: boolean } = {}): Promise<BackupResult> {
    const target = resolve(this.config.dataDir);
    await safeDataDirectory(target);
    await refuseRunning(target);
    let exists = false;
    try { exists = true; if (!(await lstat(target)).isDirectory()) throw new Error('DATA_DIR is not a directory'); }
    catch (error) { if (!missing(error)) throw error; exists = false; }
    if (exists && (await readdir(target)).length && !options.force) throw new Error('DATA_DIR is not empty; use --force only after stopping the server');
    await mkdir(dirname(target), { recursive: true });
    const staging = await mkdtemp(join(dirname(target), `.${basename(target)}-restore-`));
    const previous = `${staging}-previous`;
    let moved = false;
    try {
      const manifest = await this.extractVerified(archive, staging);
      const repo = join(staging, 'knowledge');
      await git(repo, ['fetch', join(staging, 'knowledge.bundle'), 'refs/heads/main']);
      await git(repo, ['checkout', '-B', 'main', 'FETCH_HEAD']);
      if (this.config.knowledgeRepoUrl) await git(repo, ['remote', 'add', 'origin', this.config.knowledgeRepoUrl]);
      const db = new Database(join(staging, 'llmwiki.db'));
      try {
        sqliteVec.load(db);
        if (hasTable(db, 'index_meta')) db.prepare('DELETE FROM index_meta WHERE key = ?').run('indexed_sha');
        audit(db, 'backup.restore', resolve(archive));
        db.pragma('wal_checkpoint(TRUNCATE)');
      } finally { db.close(); }
      await writeFile(join(staging, 'rag-rebuild-required.json'), JSON.stringify({ headSha: manifest.headSha, restoredAt: new Date().toISOString() }) + '\n');
      await rm(join(staging, 'knowledge.bundle'));
      await rm(join(staging, 'manifest.json'));
      // Recheck after validation: --force never overrides an active server.
      await safeDataDirectory(target);
      if (exists && (await readdir(target)).length && !options.force) throw new Error('DATA_DIR became non-empty during restore; refusing replacement');
      await refuseRunning(target);
      if (exists) { await rename(target, previous); moved = true; }
      try { await rename(staging, target); }
      catch (error) { if (moved) { await rename(previous, target); moved = false; } throw error; }
      if (moved) await rm(previous, { recursive: true, force: true });
      return { path: resolve(archive), ...manifest };
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
}

async function safeDataDirectory(target: string): Promise<void> {
  const cwdRelative = relative(target, process.cwd());
  if (target === dirname(target) || target === homedir() || cwdRelative === '' || (!isAbsolute(cwdRelative) && cwdRelative !== '..' && !cwdRelative.startsWith('../'))) {
    throw new Error('Refusing unsafe DATA_DIR restore target');
  }
  let current = target;
  while (current !== dirname(current)) {
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('DATA_DIR restore path must not contain symlinks'); }
    catch (error) { if (!missing(error)) throw error; }
    current = dirname(current);
  }
}

async function refuseRunning(directory: string): Promise<void> {
  try {
    const pid = Number((await readFile(join(directory, 'server.pid'), 'utf8')).trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid server.pid; stop the server and remove the stale marker');
    try { process.kill(pid, 0); throw new Error('Refusing restore while server.pid points to a running process'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  } catch (error) { if (!missing(error)) throw error; }
  // Also protect data opened by an older engine that does not write server.pid.
  let processes: string[];
  try { processes = await readdir('/proc'); } catch { return; }
  for (const pid of processes) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    let fds: string[];
    try { fds = await readdir(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      let path: string;
      try { path = await readlink(`/proc/${pid}/fd/${fd}`); } catch { continue; }
      if (path === join(directory, 'llmwiki.db') || path === join(directory, 'llmwiki.db-wal')) throw new Error(`Refusing restore: process ${pid} has the database open`);
    }
  }
}
