import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Test } from '@nestjs/testing';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../../src/config.js';
import { openDb, runMigrations } from '../../src/db/index.js';
import { AclService } from '../../src/acl/acl.service.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { UsersService } from '../../src/auth/users.service.js';
import { UsersRepository } from '../../src/auth/users.repository.js';
import { CONFIG, DB, LOGGER } from '../../src/common/tokens.js';
import { KnowledgeRepo, type FileChange } from '../../src/knowledge/repo.js';
import { IndexerService } from '../../src/rag/indexer.service.js';
import { CatalogService } from '../../src/rag/catalog.service.js';
import { SearchService } from '../../src/rag/search.service.js';
import { UsageService } from '../../src/usage/usage.service.js';
import { UsageRepository } from '../../src/usage/usage.repository.js';
import { startFakeOpenAI } from '../fake-openai.js';

const exec = promisify(execFile);
const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close(); }
  finally { vi.useRealTimers(); }
});

class GitRepoDouble {
  readonly diffs: Array<string | null> = [];
  constructor(readonly directory: string) {}
  async git(...args: string[]): Promise<string> {
    return (await exec('git', ['-C', this.directory, ...args])).stdout.trim();
  }
  async headSha(): Promise<string> { return this.git('rev-parse', 'main'); }
  async listFiles(_prefix?: string, ref = 'main'): Promise<string[]> {
    return (await this.git('ls-tree', '-r', '--name-only', ref)).split('\n').filter((path) => path.endsWith('.md'));
  }
  async readFile(path: string, ref = 'main'): Promise<string | null> {
    try { return (await exec('git', ['-C', this.directory, 'show', `${ref}:${path}`])).stdout; }
    catch { return null; }
  }
  async log({ path, ref = 'main', limit = 1 }: { path: string; ref?: string; limit?: number }) {
    const output = await this.git('log', `--max-count=${limit}`, '--format=%aI%x00%cI%x00%an%x00%ae', ref, '--', path);
    return output.split('\n').filter(Boolean).map((line) => {
      const [date, committedAt, authorName, authorEmail] = line.split('\0');
      return { date, committedAt, authorName, authorEmail };
    });
  }
  async diffNames(from: string | null, to: string): Promise<FileChange[]> {
    this.diffs.push(from);
    if (from === null) return (await this.listFiles(undefined, to)).map((path) => ({ status: 'A', path }));
    return (await this.git('diff', '--name-status', '-M', from, to)).split('\n').filter(Boolean).map((line) => {
      const [status, first, second] = line.split('\t');
      return status.startsWith('R') ? { status: 'R', oldPath: first, path: second } : { status: status as FileChange['status'], path: first };
    });
  }
  async put(path: string, content: string): Promise<void> {
    await mkdir(join(this.directory, path, '..'), { recursive: true });
    await writeFile(join(this.directory, path), content);
  }
  async commit(): Promise<string> {
    await this.git('add', '-A');
    await this.git('commit', '-m', 'fixture');
    return this.headSha();
  }
}

async function fixture(key = false, overrides: Partial<Config> = {}, legacy = false) {
  const directory = await mkdtemp(join(tmpdir(), 'llmwiki-rag-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const repo = new GitRepoDouble(directory);
  await repo.git('init', '-b', 'main');
  await repo.git('config', 'user.email', 'test@example.com');
  await repo.git('config', 'user.name', 'Test');
  const db = openDb(':memory:');
  cleanup.push(() => db.close());
  if (legacy) {
    db.exec('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    db.prepare('INSERT INTO schema_migrations(name,applied_at) VALUES (?,?)')
      .run('026_note_metadata.sql', '2026-01-01T00:00:00.000Z');
    runMigrations(db);
    db.prepare('DELETE FROM schema_migrations WHERE name = ?').run('026_note_metadata.sql');
  } else {
    runMigrations(db);
  }
  const fake = key ? await startFakeOpenAI([], { embeddingUsage: { promptTokens: 13, totalTokens: 17 } }) : null;
  if (fake) cleanup.push(() => fake.close());
  const config = loadConfig({ NODE_ENV: 'test', EMBEDDING_DIMENSIONS: '8',
    ...(fake ? { OPENAI_API_KEY: 'fake', OPENAI_BASE_URL: fake.url } : {}) });
  Object.assign(config, overrides);
  const log = pino({ level: 'silent' });
  const app = await Test.createTestingModule({
    providers: [
      IndexerService, SearchService, CatalogService, UsageService, UsageRepository,
      { provide: AclService, useValue: new AclService(db, new UsersService(new UsersRepository(db)), new AuditService(db)) },
      { provide: CONFIG, useValue: config },
      { provide: DB, useValue: db },
      { provide: LOGGER, useValue: log },
      { provide: KnowledgeRepo, useValue: repo },
    ],
  }).compile();
  cleanup.push(() => app.close());
  if (!legacy) await app.init();
  const indexer = app.get(IndexerService);
  const search = app.get(SearchService);
  const catalog = app.get(CatalogService);
  return { config, db, log, repo, fake, indexer, search, catalog, usage: app.get(UsageService) };
}

describe('main-derived index', () => {
  it('records indexing and query embeddings once per provider response, not cache reuse', async () => {
    const { repo, indexer, search, usage, fake } = await fixture(true);
    await repo.put('wiki/storage.md', '# Storage\nDurable storage keeps records.');
    await repo.commit();
    await indexer.syncToHead();
    expect(usage.aggregate().rows).toEqual([expect.objectContaining({
      lane: 'embedding', model: 'text-embedding-3-small', calls: 1, inputTokens: 17,
      cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0,
    })]);
    expect((await search.search('storage')).map((hit) => hit.path)).toEqual(['wiki/storage.md']);
    await search.search('storage');
    await indexer.rebuild();
    expect(fake!.requests.map(({ path }) => path)).toEqual(['/v1/embeddings', '/v1/embeddings']);
    expect(usage.aggregate().rows).toEqual([expect.objectContaining({
      lane: 'embedding', model: 'text-embedding-3-small', calls: 2, inputTokens: 34,
      cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0,
    })]);
  });

  it('leaves paused startup unindexed without embedding requests, but permits explicit incremental and full reindexing', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { repo, db, indexer, fake } = await fixture(true, { jobsAutostart: false, indexPollSeconds: 0.02 });
    await repo.put('wiki/paused.md', '# Paused\nStartup must not embed this note.');
    const first = await repo.commit();
    vi.advanceTimersByTime(100);
    expect(await indexer.status()).toMatchObject({ indexedSha: null, headSha: first, syncing: false });
    expect(fake!.requests).toEqual([]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'chunk_vectors'").get()).toEqual({ name: 'chunk_vectors' });

    expect(await indexer.reindex({ full: false })).toEqual({ indexedSha: first, changedFiles: 1 });
    expect(fake!.requests.map(({ path }) => path)).toEqual(['/v1/embeddings']);
    expect(db.prepare('SELECT vector_pending FROM chunks').get()).toEqual({ vector_pending: 0 });
    await repo.put('wiki/paused.md', '# Paused\nOnly explicit indexing may embed this changed note.');
    const second = await repo.commit();
    vi.advanceTimersByTime(100);
    expect(await indexer.status()).toMatchObject({ indexedSha: first, headSha: second, syncing: false });
    expect(fake!.requests).toHaveLength(1);
    expect(await indexer.reindex({ full: true })).toEqual({ indexedSha: second, changedFiles: 1 });
    expect(db.prepare('SELECT content FROM chunks').get()).toEqual({ content: '# Paused\nOnly explicit indexing may embed this changed note.' });
    expect(db.prepare('SELECT vector_pending FROM chunks').get()).toEqual({ vector_pending: 0 });
    expect(fake!.requests).toHaveLength(2);
  });

  it.each([true, undefined])('polls and embeds external changes when autostart is %s', async (jobsAutostart) => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { repo, indexer, fake } = await fixture(true, { jobsAutostart, indexPollSeconds: 0.02 });
    await repo.put('wiki/polled.md', '# Polled\nBackground indexing remains enabled.');
    const head = await repo.commit();
    vi.advanceTimersByTime(20);
    await vi.waitFor(async () => {
      expect(await indexer.status()).toMatchObject({ indexedSha: head, headSha: head, syncing: false, pendingVectors: 0 });
    });
    expect(fake!.requests.map(({ path }) => path)).toEqual(['/v1/embeddings']);
  });

  it('indexes add/modify/delete/rename and resolves links against the latest basenames', async () => {
    const { repo, db, indexer, search } = await fixture();
    await repo.put('wiki/start.md', '# Start\n저장소는 검색된다. [[Target|대상]] [[Future]]');
    await repo.put('wiki/target.md', '# Target\n기존 대상');
    await repo.put('MEMORY.md', '# Memory\n비밀저장소');
    await repo.put('index.md', '# Index\n색인문서');
    const first = await repo.commit();
    expect(await indexer.syncToHead()).toEqual({ indexedSha: first, changedFiles: 3 });
    expect((await search.search('저장소'))[0]).toMatchObject({ path: 'wiki/start.md', related: ['wiki/target.md'] });
    expect(db.prepare("SELECT path,kind FROM chunks WHERE path = 'index.md'").get()).toEqual({ path: 'index.md', kind: 'other' });
    expect(db.prepare("SELECT id FROM chunks WHERE path = 'MEMORY.md'").get()).toBeUndefined();

    await repo.put('wiki/start.md', '# Start\n변경본문 [[Renamed]] [[Future]]');
    await rename(join(repo.directory, 'wiki/target.md'), join(repo.directory, 'wiki/renamed.md'));
    await repo.put('raw/future.md', '# Future\n추가원문');
    const second = await repo.commit();
    expect(await indexer.syncToHead()).toEqual({ indexedSha: second, changedFiles: 3 });
    expect(repo.diffs).toEqual([null, first]);
    expect(await search.search('저장소')).toEqual([]);
    expect((await search.search('변경본문'))[0].related).toEqual(['raw/future.md', 'wiki/renamed.md']);
    expect(db.prepare("SELECT id FROM chunks WHERE path = 'wiki/target.md'").get()).toBeUndefined();

    await rm(join(repo.directory, 'wiki/renamed.md'));
    await repo.commit();
    await indexer.syncToHead();
    expect((await search.search('변경본문'))[0].related).toEqual(['raw/future.md']);
    expect(db.prepare("SELECT target_path FROM links WHERE target_name = 'renamed'").get()).toEqual({ target_path: null });
  });

  it('persists metadata on every chunk and embeds descriptions and deduplicated aliases without changing source offsets', async () => {
    const { repo, db, indexer, search, fake } = await fixture(true);
    const markdown = '---\ntitle: Canonical\ntype: concept\ndescription: "  Durable records synopsis  "\naliases: ["  DRC  ", "durable-records", "drc", ""]\n---\n# Body title\nFirst section.\n## Details\nSecond section.';
    await repo.put('wiki/metadata.md', markdown);
    await repo.commit();
    await indexer.syncToHead();
    const chunks = db.prepare(`SELECT title,note_type,description,aliases,aliases_json,content,source_start,source_end
      FROM chunks WHERE path = ? ORDER BY ordinal`).all('wiki/metadata.md');
    expect(chunks).toHaveLength(2);
    for (const chunk of chunks as Array<{ content: string; source_start: number; source_end: number }>) {
      expect(chunk).toMatchObject({
        title: 'Canonical', note_type: 'concept', description: 'Durable records synopsis',
        aliases: 'DRC durable-records', aliases_json: '["DRC","durable-records"]',
      });
      expect(markdown.slice(chunk.source_start, chunk.source_end)).toBe(chunk.content);
    }
    expect(fake!.requests[0].body.input).toEqual([
      'Canonical\n설명: Durable records synopsis\n별칭: DRC, durable-records\n\n# Body title\nFirst section.\n',
      'Canonical > Details\n설명: Durable records synopsis\n별칭: DRC, durable-records\n\n## Details\nSecond section.',
    ]);
    expect((await search.search('DRC')).map((hit) => hit.path)).toEqual(['wiki/metadata.md']);
    expect((await search.search('synopsis')).map((hit) => hit.path)).toEqual(['wiki/metadata.md']);
    for (const table of ['chunks_fts', 'chunks_terms']) {
      expect(db.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${table} MATCH ?`).get('aliases:DRC')).toEqual({ count: 2 });
      expect(db.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${table} MATCH ?`).get('description:synopsis')).toEqual({ count: 2 });
    }
  });

  it.each([
    ['missing', ''],
    ['unknown', 'type: unknown\ndescription: 42\naliases: scalar\n'],
    ['wrong casing', 'type: Concept\ndescription: "   "\naliases: []\n'],
    ['non-string', 'type: [concept]\ndescription: [synopsis]\naliases: ["Usable", false, null, ""]\n'],
  ])('stores null for %s metadata instead of inventing a note type or description', async (_name, fields) => {
    const { repo, db, indexer } = await fixture();
    await repo.put('wiki/invalid.md', `---\n${fields}---\n# Fallback\nBody.`);
    await repo.commit();
    await indexer.syncToHead();
    expect(db.prepare('SELECT note_type,description,aliases,aliases_json FROM chunks').get())
      .toEqual({ note_type: null, description: null, aliases: '', aliases_json: '[]' });
  });

  it('preserves the full trimmed description in storage and embedding input', async () => {
    const { repo, db, indexer, fake } = await fixture(true);
    const description = `Summary ${'요'.repeat(350)}`;
    await repo.put('wiki/full-description.md', `---\ndescription: "  ${description}  "\n---\n# Title\nBody.`);
    await repo.commit();
    await indexer.syncToHead();
    expect(db.prepare('SELECT description FROM chunks').get()).toEqual({ description });
    expect(fake!.requests[0].body.input).toEqual([`Title\n설명: ${description}\n\n# Title\nBody.`]);
  });

  it('keeps both lexical metadata channels synchronized on field updates and note deletion', async () => {
    const { repo, db, indexer } = await fixture();
    await repo.put('wiki/lexical.md', '---\ndescription: OriginalSummary\naliases: [OriginalAlias]\n---\n# Title\nBody.');
    await repo.commit();
    await indexer.syncToHead();
    db.prepare('UPDATE chunks SET description = ?, aliases = ? WHERE path = ?')
      .run('ReplacementSummary', 'ReplacementAlias', 'wiki/lexical.md');
    for (const table of ['chunks_fts', 'chunks_terms']) {
      expect(db.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${table} MATCH ?`).get('description:OriginalSummary')).toEqual({ count: 0 });
      expect(db.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${table} MATCH ?`).get('aliases:OriginalAlias')).toEqual({ count: 0 });
      expect(db.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${table} MATCH ?`).get('description:ReplacementSummary')).toEqual({ count: 1 });
      expect(db.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${table} MATCH ?`).get('aliases:ReplacementAlias')).toEqual({ count: 1 });
    }
    await rm(join(repo.directory, 'wiki/lexical.md'));
    await repo.commit();
    await indexer.syncToHead();
    for (const table of ['chunks_fts', 'chunks_terms']) {
      expect(db.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${table} MATCH ?`).get('description:ReplacementSummary')).toEqual({ count: 0 });
      expect(db.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${table} MATCH ?`).get('aliases:ReplacementAlias')).toEqual({ count: 0 });
    }
  });

  it('invalidates embeddings for metadata changes and reuses the replacement cache on a same-HEAD rebuild', async () => {
    const { repo, db, indexer, search, fake } = await fixture(true);
    const body = '# Stable\nUnchanged body.';
    await repo.put('wiki/cache.md', `---\ndescription: Original synopsis\naliases: [OriginalAlias]\n---\n${body}`);
    await repo.commit();
    await indexer.syncToHead();
    const oldHash = db.prepare('SELECT content_hash FROM chunks').get();
    await repo.put('wiki/cache.md', `---\ndescription: Replacement synopsis\naliases: [ReplacementAlias]\n---\n${body}`);
    const head = await repo.commit();
    await indexer.syncToHead();
    expect(fake!.requests).toHaveLength(2);
    expect(fake!.requests[1].body.input).toEqual(['Stable\n설명: Replacement synopsis\n별칭: ReplacementAlias\n\n# Stable\nUnchanged body.']);
    expect(db.prepare('SELECT content_hash FROM chunks').get()).not.toEqual(oldHash);
    for (const table of ['chunks_fts', 'chunks_terms']) {
      expect(db.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${table} MATCH ?`).get('aliases:OriginalAlias')).toEqual({ count: 0 });
      expect(db.prepare(`SELECT count(*) AS count FROM ${table} WHERE ${table} MATCH ?`).get('description:Original')).toEqual({ count: 0 });
    }
    await indexer.rebuild();
    expect(await repo.headSha()).toBe(head);
    expect(fake!.requests).toHaveLength(2);
    expect(db.prepare('SELECT count(*) AS count FROM chunk_vectors').get()).toEqual({ count: 1 });
    expect((await search.search('ReplacementAlias')).map((hit) => hit.path)).toEqual(['wiki/cache.md']);
  });

  it('indexes frontmatter related and source wikilinks alongside body links without treating external sources as note links', async () => {
    const { repo, indexer, catalog, search } = await fixture();
    await repo.put('wiki/source.md', '---\nrelated: ["[[RelatedName#Section|label]]"]\nsource: ["[[raw/Evidence.md]]", "https://example.com/evidence"]\n---\n# Source\nSearchable body [[Body]]');
    await repo.put('wiki/related.md', '---\naliases: [RelatedName]\n---\n# Related\nRelated note.');
    await repo.put('raw/evidence.md', '# Evidence\nEvidence note.');
    await repo.put('wiki/body.md', '# Body\nBody note.');
    await repo.commit();
    await indexer.syncToHead();
    expect(catalog.links('wiki/source.md')).toEqual({
      outgoing: [
        { path: 'raw/evidence.md', title: 'Evidence' },
        { path: 'wiki/body.md', title: 'Body' },
        { path: 'wiki/related.md', title: 'Related' },
      ], backlinks: [], unresolved: [],
    });
    expect(catalog.links('wiki/related.md').backlinks).toEqual([{ path: 'wiki/source.md', title: 'Source' }]);
    expect(catalog.links('raw/evidence.md').backlinks).toEqual([{ path: 'wiki/source.md', title: 'Source' }]);
    expect(catalog.graph().edges).toEqual([
      { from: 'wiki/source.md', to: 'raw/evidence.md' },
      { from: 'wiki/source.md', to: 'wiki/body.md' },
      { from: 'wiki/source.md', to: 'wiki/related.md' },
    ]);
    expect((await search.search('Searchable'))[0].related).toEqual(['raw/evidence.md', 'wiki/body.md', 'wiki/related.md']);
  });

  it('migrates legacy FTS layouts and rebuilds note metadata without a new HEAD commit', async () => {
    const { config, repo, db, indexer, search } = await fixture(false, {}, true);
    await repo.put('wiki/legacy.md', '---\ntype: guide\ndescription: Migration synopsis\naliases: [MigrationAlias]\n---\n# Legacy\nOriginal body.');
    const head = await repo.commit();
    db.prepare(`INSERT INTO chunks(path,title,heading,content,embedding_text,content_hash,kind,ordinal)
      VALUES ('wiki/legacy.md','Legacy','','Original body.','Legacy\n\nOriginal body.','old','wiki',0)`).run();
    const setMeta = db.prepare('INSERT OR REPLACE INTO index_meta(key,value) VALUES (?,?)');
    setMeta.run('indexed_sha', head);
    setMeta.run('embedding_model', config.embeddingModel);
    setMeta.run('embedding_dimensions', String(config.embeddingDimensions));
    setMeta.run('layout_version', '3');
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vectors USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[8])');
    runMigrations(db);
    expect(db.prepare("SELECT value FROM index_meta WHERE key = 'layout_version'").get()).toBeUndefined();
    expect(db.prepare('SELECT note_type,description,aliases,aliases_json FROM chunks').get())
      .toEqual({ note_type: null, description: null, aliases: null, aliases_json: '[]' });
    expect(await indexer.syncToHead()).toEqual({ indexedSha: head, changedFiles: 1 });
    expect(repo.diffs).toEqual([null]);
    expect(await repo.headSha()).toBe(head);
    expect(db.prepare("SELECT value FROM index_meta WHERE key = 'layout_version'").get()).toEqual({ value: '4' });
    expect(db.prepare('SELECT note_type,description,aliases,aliases_json FROM chunks').get())
      .toEqual({ note_type: 'guide', description: 'Migration synopsis', aliases: 'MigrationAlias', aliases_json: '["MigrationAlias"]' });
    expect((await search.search('MigrationAlias'))[0]).toMatchObject({ path: 'wiki/legacy.md' });
    expect((await search.search('synopsis'))[0]).toMatchObject({ path: 'wiki/legacy.md' });
    expect(await indexer.syncToHead()).toEqual({ indexedSha: head, changedFiles: 0 });
    expect(repo.diffs).toEqual([null]);
  });

  it('reuses embeddings for unchanged sections, same-title renames and explicit rebuilds', async () => {
    const { repo, db, indexer, fake } = await fixture(true);
    await repo.put('wiki/a.md', '---\ntitle: Stable\n---\n## One\n첫번째 내용\n## Two\n두번째 내용');
    await repo.commit();
    await indexer.syncToHead();
    expect(fake!.requests).toHaveLength(1);
    expect(fake!.requests[0].body.input).toHaveLength(2);
    await repo.put('wiki/a.md', '---\ntitle: Stable\n---\n## One\n첫번째 수정된 내용\n## Two\n두번째 내용');
    await repo.commit();
    await indexer.syncToHead();
    expect(fake!.requests).toHaveLength(2);
    expect(fake!.requests[1].body.input).toHaveLength(1);
    await rename(join(repo.directory, 'wiki/a.md'), join(repo.directory, 'wiki/b.md'));
    await repo.commit();
    await indexer.syncToHead();
    await indexer.rebuild();
    expect(fake!.requests).toHaveLength(2);
    expect(db.prepare('SELECT count(*) AS count FROM chunk_vectors').get()).toEqual({ count: 2 });
    expect(db.prepare('SELECT count(*) AS count FROM chunks WHERE vector_pending = 1').get()).toEqual({ count: 0 });
  });

  it('fills pending vectors when credentials become available without a new commit', async () => {
    const { repo, config, db, indexer } = await fixture();
    await repo.put('journal/day.md', '# Day\n저장소는 오늘도 성장한다.');
    const head = await repo.commit();
    await indexer.syncToHead();
    expect(db.prepare('SELECT vector_pending FROM chunks').get()).toEqual({ vector_pending: 1 });
    const fake = await startFakeOpenAI();
    cleanup.push(() => fake.close());
    config.openaiApiKey = 'fake';
    config.openaiBaseUrl = fake.url;
    expect(await indexer.syncToHead()).toEqual({ indexedSha: head, changedFiles: 0 });
    expect(fake.requests).toHaveLength(1);
    expect(repo.diffs).toEqual([null]);
    expect(db.prepare('SELECT vector_pending FROM chunks').get()).toEqual({ vector_pending: 0 });
    expect(db.prepare('SELECT count(*) AS count FROM chunk_vectors').get()).toEqual({ count: 1 });
  });

  it('fully rebuilds after either model or dimension changes and records the new configuration', async () => {
    const { repo, config, db, indexer, fake } = await fixture(true);
    await repo.put('wiki/a.md', '# Title\n테스트 내용');
    await repo.commit();
    await indexer.syncToHead();
    config.embeddingModel = 'another-model';
    await indexer.syncToHead();
    config.embeddingDimensions = 16;
    await indexer.syncToHead();
    expect(repo.diffs).toEqual([null, null, null]);
    expect(fake!.requests.map(({ body }) => [body.model, body.dimensions])).toEqual([
      ['text-embedding-3-small', 8], ['another-model', 8], ['another-model', 16],
    ]);
    expect(db.prepare("SELECT value FROM index_meta WHERE key = 'embedding_dimensions'").get()).toEqual({ value: '16' });
    expect(db.prepare('SELECT vec_length(embedding) AS dimensions FROM chunk_vectors').get()).toEqual({ dimensions: 16 });
  });

  it('serializes simultaneous syncs so the second sees the committed index SHA', async () => {
    const { repo, indexer, fake } = await fixture(true);
    await repo.put('wiki/a.md', '# Title\n테스트 내용');
    const head = await repo.commit();
    const results = await Promise.all([indexer.syncToHead(), indexer.syncToHead(), indexer.syncToHead()]);
    expect(results).toEqual([{ indexedSha: head, changedFiles: 1 }, { indexedSha: head, changedFiles: 0 }, { indexedSha: head, changedFiles: 0 }]);
    expect(repo.diffs).toEqual([null]);
    expect(fake!.requests).toHaveLength(1);
  });
});
