import 'reflect-metadata';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { AclService } from '../../src/acl/acl.service.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { UsersRepository } from '../../src/auth/users.repository.js';
import { UsersService } from '../../src/auth/users.service.js';
import { loadConfig } from '../../src/config.js';
import { openDb, runMigrations } from '../../src/db/index.js';
import { KnowledgeRepo, type Worktree } from '../../src/knowledge/repo.js';
import { CatalogService } from '../../src/rag/catalog.service.js';
import { IndexerService } from '../../src/rag/indexer.service.js';

const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture(legacy = false) {
  const directory = await mkdtemp(join(tmpdir(), 'rag-link-fidelity-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: directory, EMBEDDING_DIMENSIONS: '2' });
  const log = pino({ level: 'silent' });
  const db = openDb(':memory:');
  cleanup.push(() => db.close());
  if (legacy) {
    const migrations = new URL('../../src/db/migrations/', import.meta.url);
    db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    for (const name of readdirSync(migrations).filter((name) => name.endsWith('.sql') && name < '014_').sort()) {
      db.exec(readFileSync(new URL(name, migrations), 'utf8'));
      db.prepare('INSERT INTO schema_migrations(name,applied_at) VALUES (?,?)').run(name, '2026-01-01T00:00:00.000Z');
    }
  } else {
    runMigrations(db);
  }
  const repo = await KnowledgeRepo.open(config, log);
  const indexer = new IndexerService(config, db, log, repo);
  cleanup.push(() => indexer.onModuleDestroy());
  const catalog = new CatalogService(db, new AclService(db, new UsersService(new UsersRepository(db)), new AuditService(db)));
  let sequence = 0;
  const commit = async (edit: (worktree: Worktree) => Promise<void>) => {
    const worktree = await repo.createWorktree(`link-fidelity-${++sequence}`);
    try {
      await edit(worktree);
      await worktree.commit('Update link fixture', { name: 'Link Author', email: 'links@example.test' });
      return await worktree.fastForwardMain();
    } finally {
      await worktree.dispose();
    }
  };
  return { config, db, repo, indexer, catalog, commit };
}

const source = 'wiki/fidelity-source.md';

describe('main-derived wikilink fidelity', () => {
  it('preserves missing target folders, case and optional extension while keeping the first spelling of duplicate keys', async () => {
    const { indexer, catalog, commit } = await fixture();
    await commit(async (worktree) => {
      await worktree.write(source, '# Source\n[[  Projects/Missing.MD #Heading|Display  ]] [[projects/missing|Second alias]] [[Other/Missing]]');
    });
    await indexer.syncToHead();
    expect(catalog.links(source)).toEqual({
      outgoing: [], backlinks: [], unresolved: ['Other/Missing', 'Projects/Missing.MD'],
    });
    expect(catalog.graph(source, 1)).toEqual({
      nodes: [{ path: source, title: 'Source', tags: [] }], edges: [],
    });
  });

  it('selects a folder-qualified duplicate but leaves an ambiguous basename out of outgoing links and graph edges', async () => {
    const { indexer, catalog, commit } = await fixture();
    const ambiguous = 'wiki/fidelity-ambiguous.md';
    await commit(async (worktree) => {
      await worktree.write(source, '# Source\n[[  WIKI/B/Shared.MD#Section|Second  ]]');
      await worktree.write(ambiguous, '# Ambiguous\n[[Shared]]');
      await worktree.write('wiki/a/shared.md', '# First\nFirst duplicate.');
      await worktree.write('wiki/b/shared.md', '# Second\nSecond duplicate.');
    });
    await indexer.syncToHead();
    expect(catalog.links(source)).toEqual({
      outgoing: [{ path: 'wiki/b/shared.md', title: 'Second' }], backlinks: [], unresolved: [],
    });
    expect(catalog.links(ambiguous)).toEqual({ outgoing: [], backlinks: [], unresolved: ['Shared'] });
    expect(catalog.graph(source, 1).edges).toEqual([{ from: source, to: 'wiki/b/shared.md' }]);
    expect(catalog.graph(ambiguous, 1)).toEqual({
      nodes: [{ path: ambiguous, title: 'Ambiguous', tags: [] }], edges: [],
    });
    expect(catalog.links('wiki/a/shared.md').backlinks).toEqual([]);
    expect(catalog.links('wiki/b/shared.md').backlinks).toEqual([{ path: source, title: 'Source' }]);
  });

  it('strips only the file extension when a note name itself ends in .md', async () => {
    const { indexer, catalog, commit } = await fixture();
    await commit(async (worktree) => {
      await worktree.write(source, '# Source\n[[Archive.MD.MD]]');
      await worktree.write('wiki/archive.md.md', '# Intended\nName includes an extension.');
      await worktree.write('wiki/archive.md', '# Different\nDistinct note.');
    });
    await indexer.syncToHead();
    expect(catalog.links(source)).toEqual({
      outgoing: [{ path: 'wiki/archive.md.md', title: 'Intended' }], backlinks: [], unresolved: [],
    });
    expect(catalog.graph(source, 1).edges).toEqual([{ from: source, to: 'wiki/archive.md.md' }]);
  });

  it('re-resolves unchanged source links after target additions, ambiguity, rename and deletion', async () => {
    const { indexer, catalog, commit } = await fixture();
    await commit(async (worktree) => {
      await worktree.write(source, '# Source\n[[Future]] [[raw/Future.md]]');
    });
    await indexer.syncToHead();
    expect(catalog.links(source)).toEqual({ outgoing: [], backlinks: [], unresolved: ['Future', 'raw/Future.md'] });

    await commit(async (worktree) => { await worktree.write('raw/future.md', '# Raw Future\nTarget.'); });
    await indexer.syncToHead();
    expect(catalog.links(source)).toEqual({
      outgoing: [{ path: 'raw/future.md', title: 'Raw Future' }], backlinks: [], unresolved: [],
    });

    await commit(async (worktree) => { await worktree.write('wiki/future.md', '# Wiki Future\nDuplicate.'); });
    await indexer.syncToHead();
    expect(catalog.links(source)).toEqual({
      outgoing: [{ path: 'raw/future.md', title: 'Raw Future' }], backlinks: [], unresolved: ['Future'],
    });
    expect(catalog.graph(source, 1).edges).toEqual([{ from: source, to: 'raw/future.md' }]);

    await commit(async (worktree) => { await worktree.move('raw/future.md', 'raw/renamed.md'); });
    await indexer.syncToHead();
    expect(catalog.links(source)).toEqual({
      outgoing: [{ path: 'wiki/future.md', title: 'Wiki Future' }], backlinks: [], unresolved: ['raw/Future.md'],
    });
    expect(catalog.graph(source, 1).edges).toEqual([{ from: source, to: 'wiki/future.md' }]);

    await commit(async (worktree) => { await worktree.remove('wiki/future.md'); });
    await indexer.syncToHead();
    expect(catalog.links(source)).toEqual({ outgoing: [], backlinks: [], unresolved: ['Future', 'raw/Future.md'] });
    expect(catalog.graph(source, 1).edges).toEqual([]);

    await commit(async (worktree) => { await worktree.write('raw/future.md', '# Returned\nRecreated target.'); });
    await indexer.syncToHead();
    expect(catalog.links(source)).toEqual({
      outgoing: [{ path: 'raw/future.md', title: 'Returned' }], backlinks: [], unresolved: [],
    });
  });

  it('upgrades a legacy index by reparsing original targets even when main HEAD is unchanged', async () => {
    const { config, db, repo, indexer, catalog, commit } = await fixture(true);
    const head = await commit(async (worktree) => {
      await worktree.write(source, '# Source\n[[WIKI/B/Shared.md]] [[Projects/Missing.MD#Heading|Label]]');
      await worktree.write('wiki/a/shared.md', '# First\nFirst duplicate.');
      await worktree.write('wiki/b/shared.md', '# Second\nSecond duplicate.');
    });
    // Simulate the prior indexer's lossy basename keys and first-path resolution.
    const insertNote = db.prepare(`INSERT INTO chunks
      (path,title,heading,content,embedding_text,content_hash,kind,ordinal)
      VALUES (?,?,'','Legacy content','Legacy content',?,'wiki',0)`);
    insertNote.run(source, 'Source', source);
    insertNote.run('wiki/a/shared.md', 'First', 'wiki/a/shared.md');
    insertNote.run('wiki/b/shared.md', 'Second', 'wiki/b/shared.md');
    db.prepare('INSERT INTO links(source_path,target_name,target_path) VALUES (?,?,?)').run(source, 'shared', 'wiki/a/shared.md');
    db.prepare('INSERT INTO links(source_path,target_name,target_path) VALUES (?,?,NULL)').run(source, 'missing');
    db.exec('CREATE VIRTUAL TABLE chunk_vectors USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[2])');
    const setMeta = db.prepare('INSERT INTO index_meta(key,value) VALUES (?,?)');
    setMeta.run('indexed_sha', head);
    setMeta.run('embedding_model', config.embeddingModel);
    setMeta.run('embedding_dimensions', String(config.embeddingDimensions));
    setMeta.run('layout_version', '2');

    runMigrations(db);
    expect(catalog.links(source)).toEqual({
      outgoing: [{ path: 'wiki/a/shared.md', title: 'First' }], backlinks: [], unresolved: ['missing'],
    });
    await indexer.syncToHead();
    expect(await repo.headSha()).toBe(head);
    expect(await indexer.status()).toMatchObject({ indexedSha: head, headSha: head });
    expect(catalog.links(source)).toEqual({
      outgoing: [{ path: 'wiki/b/shared.md', title: 'Second' }], backlinks: [], unresolved: ['Projects/Missing.MD'],
    });
    expect(catalog.graph(source, 1).edges).toEqual([{ from: source, to: 'wiki/b/shared.md' }]);
    // A second synchronization at the same HEAD retains the recovered spelling.
    await indexer.syncToHead();
    expect(catalog.links(source).unresolved).toEqual(['Projects/Missing.MD']);
  });
});
