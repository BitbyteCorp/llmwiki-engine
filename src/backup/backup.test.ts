import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { AclService } from '../acl/acl.service.js';
import { AuditService } from '../audit/audit.service.js';
import { UsersRepository } from '../auth/users.repository.js';
import { UsersService } from '../auth/users.service.js';
import { loadConfig, type Config } from '../config.js';
import { openDb, runMigrations, type Db } from '../db/index.js';
import { ExportService } from '../export/export.service.js';
import { git } from '../export/git.js';
import { BackupService } from './backup.service.js';

const directories: string[] = [];
const databases: Db[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; config: Config; db: Db; head: string }> {
  const root = await mkdtemp(join(tmpdir(), 'llmwiki-backup-test-'));
  directories.push(root);
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: join(root, 'source') });
  await mkdir(join(config.dataDir, 'knowledge', 'wiki'), { recursive: true });
  await mkdir(join(config.dataDir, 'knowledge', 'raw'));
  const repo = join(config.dataDir, 'knowledge');
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'Backup Test']);
  await git(repo, ['config', 'user.email', 'backup@example.com']);
  await writeFile(join(repo, 'wiki', 'note.md'), '# Durable note\n\nA committed fact.\n');
  await writeFile(join(repo, 'raw', 'source.txt'), 'Preserve this raw source\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'Save durable knowledge']);
  const head = (await git(repo, ['rev-parse', 'main'])).trim();
  // Deliberately dirty disk: exports and backups must read committed main instead.
  await writeFile(join(repo, 'wiki', 'note.md'), '# Uncommitted disk edit\n');
  const db = openDb(join(config.dataDir, 'llmwiki.db'));
  databases.push(db);
  runMigrations(db);
  db.prepare('INSERT INTO users(email,role,created_at) VALUES(?,?,?)').run('reader@example.com', 'viewer', '2026-10-07T00:00:00.000Z');
  db.prepare('INSERT INTO uploads(id,user_id,name,media_type,size,created_at) VALUES(?,?,?,?,?,?)').run('backup-upload', 1, 'note.txt', 'text/plain', 15, '2026-10-07T00:00:00.000Z');
  await mkdir(join(config.dataDir, 'uploads'));
  await writeFile(join(config.dataDir, 'uploads', 'backup-upload'), 'attached bytes\n');
  return { root, config, db, head };
}

async function downloadBytes(service: ExportService, options: { format?: 'zip' | 'bundle'; prefix?: string } = {}): Promise<{ bytes: Buffer; filename: string }> {
  const download = await service.prepare(options);
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of download.stream) chunks.push(chunk as Buffer);
    return { bytes: Buffer.concat(chunks), filename: download.filename };
  } finally { download.stream.destroy(); await download.dispose(); }
}

describe('committed knowledge export', () => {
  it('exports only selected main contents with a pinned manifest and short-SHA filename', async () => {
    const { config, head, db } = await fixture();
    const users = new UsersService(new UsersRepository(db));
    const result = await downloadBytes(new ExportService(config, new AclService(db, users, new AuditService(db)), users), { prefix: 'wiki/' });
    const zip = unzipSync(result.bytes);
    expect(Object.keys(zip).sort()).toEqual(['manifest.json', 'wiki/', 'wiki/note.md']);
    expect(strFromU8(zip['wiki/note.md'])).toBe('# Durable note\n\nA committed fact.\n');
    expect(JSON.parse(strFromU8(zip['manifest.json']))).toMatchObject({ headSha: head, prefix: 'wiki', format: 'zip', version: 1 });
    expect(result.filename).toBe(`llmwiki-${head.slice(0, 12)}.zip`);
  });
  it('exports a usable main-history bundle and refuses traversal or filtered bundles', async () => {
    const { config, root, head, db } = await fixture();
    const users = new UsersService(new UsersRepository(db));
    const service = new ExportService(config, new AclService(db, users, new AuditService(db)), users);
    const result = await downloadBytes(service, { format: 'bundle' });
    const bundle = join(root, 'export.bundle');
    await writeFile(bundle, result.bytes);
    expect((await git(join(config.dataDir, 'knowledge'), ['bundle', 'list-heads', bundle])).trim()).toBe(`${head} refs/heads/main`);
    await expect(service.prepare({ prefix: '../escape' })).rejects.toThrow(/repository-relative/);
    await expect(service.prepare({ prefix: 'wiki', format: 'bundle' })).rejects.toThrow(/cannot be prefix-filtered/);
  });
});

describe('backup archive roundtrip', () => {
  it('snapshots a live WAL database, verifies, and restores main, user data, uploads, and RAG rebuild state', async () => {
    const { config, root, head, db } = await fixture();
    db.prepare('INSERT INTO index_meta(key,value) VALUES(?,?)').run('indexed_sha', head);
    const archive = join(root, 'backup.zip');
    const service = new BackupService(config);
    const result = await service.create(archive);
    expect(result.headSha).toBe(head);
    expect((await service.verify(archive)).checksums).toEqual(result.checksums);
    const restoredConfig = { ...config, dataDir: join(root, 'restored') };
    await new BackupService(restoredConfig).restore(archive);
    const restored = openDb(join(restoredConfig.dataDir, 'llmwiki.db'));
    databases.push(restored);
    expect(restored.prepare('SELECT email,role FROM users').all()).toEqual([{ email: 'reader@example.com', role: 'viewer' }]);
    expect(await readFile(join(restoredConfig.dataDir, 'uploads', 'backup-upload'), 'utf8')).toBe('attached bytes\n');
    expect(await readFile(join(restoredConfig.dataDir, 'knowledge', 'wiki', 'note.md'), 'utf8')).toBe('# Durable note\n\nA committed fact.\n');
    expect((await git(join(restoredConfig.dataDir, 'knowledge'), ['rev-parse', 'main'])).trim()).toBe(head);
    expect(restored.prepare('SELECT value FROM index_meta WHERE key = ?').get('indexed_sha')).toBeUndefined();
    expect(JSON.parse(await readFile(join(restoredConfig.dataDir, 'rag-rebuild-required.json'), 'utf8'))).toMatchObject({ headSha: head });
    expect(JSON.parse(await readFile(join(config.dataDir, 'last-backup.json'), 'utf8'))).toMatchObject({ path: archive, headSha: head });
  });
  it('rejects corruption and unsafe archive members before replacing existing data', async () => {
    const { config, root } = await fixture();
    const archive = join(root, 'backup.zip');
    const service = new BackupService(config);
    await service.create(archive);
    const entries = unzipSync(await readFile(archive));
    entries['llmwiki.db'][0] ^= 1;
    const corrupted = join(root, 'corrupted.zip');
    await writeFile(corrupted, zipSync(entries));
    await expect(service.verify(corrupted)).rejects.toThrow(/checksum mismatch/);
    const malicious = join(root, 'malicious.zip');
    await writeFile(malicious, zipSync({ '../escape': strToU8('outside') }));
    await expect(service.verify(malicious)).rejects.toThrow(/Unsafe/);
    const target = join(root, 'existing');
    await mkdir(target);
    await writeFile(join(target, 'keep'), 'untouched');
    const restore = new BackupService({ ...config, dataDir: target });
    await expect(restore.restore(archive)).rejects.toThrow(/not empty/);
    await expect(restore.restore(corrupted, { force: true })).rejects.toThrow(/checksum mismatch/);
    expect(await readFile(join(target, 'keep'), 'utf8')).toBe('untouched');
    await writeFile(join(target, 'server.pid'), String(process.pid));
    await expect(restore.restore(archive, { force: true })).rejects.toThrow(/running process/);
    await rm(join(target, 'server.pid'));
    await restore.restore(archive, { force: true });
    expect(await readFile(join(target, 'knowledge', 'wiki', 'note.md'), 'utf8')).toBe('# Durable note\n\nA committed fact.\n');
  });
  it('rejects incompatible schemas and preserves existing output archives', async () => {
    const { config, root, db } = await fixture();
    const existing = join(root, 'existing.zip');
    await writeFile(existing, 'do not overwrite');
    const service = new BackupService(config);
    await expect(service.create(existing)).rejects.toThrow(/EEXIST/);
    expect(await readFile(existing, 'utf8')).toBe('do not overwrite');
    db.prepare('INSERT INTO schema_migrations(name,applied_at) VALUES(?,?)').run('999_future.sql', '2026-10-07T00:00:00.000Z');
    const future = join(root, 'future.zip');
    await service.create(future);
    await expect(service.verify(future)).rejects.toThrow(/incompatible/);
  });
});
