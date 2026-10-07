import 'reflect-metadata';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AclService } from '../acl/acl.service.js';
import { AuditService } from '../audit/audit.service.js';
import { ApiTokensService } from '../auth/api-tokens.service.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { SessionsService } from '../auth/sessions.service.js';
import { UsersRepository } from '../auth/users.repository.js';
import { UsersService } from '../auth/users.service.js';
import type { User } from '../auth/users.types.js';
import { SearchController } from '../api/search.controller.js';
import { GraphController, LinksController } from '../api/links.controller.js';
import { TagsController } from '../api/tags.controller.js';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter.js';
import { CONFIG, DB, LOGGER } from '../common/tokens.js';
import { loadConfig } from '../config.js';
import type { Config } from '../config.js';
import { openDb, runMigrations, type Db } from '../db/index.js';
import { KnowledgeRepo } from '../knowledge/repo.js';
import { CatalogService } from './catalog.service.js';
import { ComparisonService } from './comparison.service.js';
import { IndexerService } from './indexer.service.js';
import { SearchService } from './search.service.js';

const exec = promisify(execFile);
const visible = ['wiki/public/a.md', 'wiki/public/b.md'];
const bridge = 'wiki/hidden/bridge.md';
const remote = 'wiki/public/remote.md';
const shared = '---\ntags: [common]\n---\n# Needle\nShared needle evidence. [[bridge]] [[missing]]\n';

describe('ACL-aware RAG HTTP with a real repository and index', () => {
  let directory: string;
  let db: Db;
  let fake: { url: string; close(): Promise<void> };
  let app: INestApplication;
  let acl: AclService;
  let alice: User;
  let bob: User;
  let admin: User;
  let repo: KnowledgeRepo;
  let indexer: IndexerService;
  let config: Config;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'llmwiki-acl-rag-'));
    // Load the shared test fixture at runtime; it is outside the production TypeScript root.
    const { startFakeOpenAI } = await import(new URL('../../test/fake-openai.ts', import.meta.url).href);
    fake = await startFakeOpenAI();
    config = loadConfig({ NODE_ENV: 'test', DATA_DIR: directory,
      OPENAI_API_KEY: 'fake-key', OPENAI_BASE_URL: fake.url, EMBEDDING_DIMENSIONS: '32' });
    const log = pino({ enabled: false });
    db = openDb(join(directory, 'engine.sqlite'));
    runMigrations(db);
    const users = new UsersService(new UsersRepository(db));
    admin = users.create({ email: 'admin@example.com', role: 'admin' });
    alice = users.create({ email: 'alice@example.com', role: 'viewer' });
    bob = users.create({ email: 'bob@example.com', role: 'viewer' });
    acl = new AclService(db, users, new AuditService(db));
    acl.create({ prefix: 'wiki/hidden/', subjectType: 'everyone', subject: '', access: 'none' }, admin);
    acl.create({ prefix: 'wiki/hidden/', subjectType: 'user', subject: String(bob.id), access: 'read' }, admin);
    repo = await KnowledgeRepo.open(config, log);
    const root = join(directory, 'knowledge');
    for (const path of await repo.listFiles()) await rm(join(root, path));
    const notes = [
      ...Array.from({ length: 220 }, (_, index) => ({ path: `wiki/hidden/${String(index).padStart(3, '0')}.md`, content: shared })),
      ...visible.map((path) => ({ path, content: shared })),
      { path: bridge, content: '---\ntags: [classified]\n---\n# Secret bridge\nPrivate bridge content. [[remote]]\n' },
      { path: remote, content: '---\ntags: [remote]\n---\n# Remote\nPublic island reachable only through a private bridge.\n' },
    ];
    for (const note of notes) {
      await mkdir(dirname(join(root, note.path)), { recursive: true });
      await writeFile(join(root, note.path), note.content);
    }
    await exec('git', ['add', '--all'], { cwd: root });
    await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'ACL retrieval corpus'], { cwd: root });
    indexer = new IndexerService(config, db, log, repo);
    indexer.init();
    await indexer.syncToHead();
    const module = await Test.createTestingModule({
      controllers: [SearchController, GraphController, LinksController, TagsController],
      providers: [SearchService, CatalogService, ComparisonService, RolesGuard, SessionGuard,
        { provide: CONFIG, useValue: config }, { provide: DB, useValue: db }, { provide: LOGGER, useValue: log },
        { provide: AclService, useValue: acl }, { provide: KnowledgeRepo, useValue: repo },
        { provide: ApiTokensService, useValue: {} },
        { provide: SessionsService, useValue: {
          sessionUser: (req: Request) => ({ alice, bob, admin })[req.get('x-session') as 'alice' | 'bob' | 'admin'] ?? null,
          assertSameOrigin: () => {},
        } },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalFilters(new HttpExceptionFilter(log));
    await app.init();
  }, 30_000);
  afterAll(async () => {
    await app?.close();
    db?.close();
    await fake?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const get = (url: string, user = 'alice') => request(app.getHttpServer()).get(url).set('x-session', user);

  it('filters lexical and vector candidates before their caps and keeps cursors reader-scoped', async () => {
    const first = await get('/api/search?q=needle&tags=common&limit=1').expect(200);
    expect(first.body.mode).toBe('hybrid');
    expect(first.body.degraded).toBeNull();
    expect(first.body.hits.map((hit: { path: string }) => hit.path)).toEqual([visible[0]]);
    expect(first.body.hits[0].related).toEqual([]);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const nextUrl = `/api/search?q=needle&tags=common&limit=1&cursor=${first.body.nextCursor}`;
    await get(nextUrl, 'bob').expect(400);
    await get(nextUrl, 'admin').expect(400);
    const second = await get(nextUrl).expect(200);
    expect(second.body.hits.map((hit: { path: string }) => hit.path)).toEqual([visible[1]]);
    expect(second.body.nextCursor).toBeNull();
    expect(JSON.stringify([first.body, second.body])).not.toContain('wiki/hidden/');
    for (const user of ['bob', 'admin']) {
      const result = await get('/api/search?q=needle&tags=common&limit=1', user).expect(200);
      expect(result.body.hits[0].path).toMatch(/^wiki\/hidden\/\d{3}\.md$/);
    }
    const semanticOnly = await get('/api/search?q=unrelated-vector-query&tags=common&limit=20').expect(200);
    expect(semanticOnly.body.mode).toBe('hybrid');
    expect(semanticOnly.body.hits.map((hit: { path: string }) => hit.path)).toEqual(visible);
    const apiKey = config.openaiApiKey;
    config.openaiApiKey = undefined;
    try {
      for (const q of ['needle', 'ne']) {
        const keyword = await get(`/api/search?q=${q}&tags=common&limit=20`).expect(200);
        expect(keyword.body.mode).toBe('keyword');
        expect(keyword.body.hits.map((hit: { path: string }) => hit.path)).toEqual(visible);
      }
    } finally { config.openaiApiKey = apiKey; }
  });

  it('applies ACL before suggestions, similarity and duplicate ranking, including passages', async () => {
    const suggestions = await get('/api/search/suggest?q=Needle').expect(200);
    expect(suggestions.body.map((note: { path: string }) => note.path)).toEqual(visible);
    const similar = await get(`/api/search/similar?path=${visible[0]}&limit=1`).expect(200);
    expect(similar.body).toEqual([{ path: visible[1], title: 'Needle', score: expect.closeTo(1, 6) }]);
    const duplicate = await get('/api/search/duplicates?limit=1').expect(200);
    expect(duplicate.body).toMatchObject([{ left: { path: visible[0] }, right: { path: visible[1] }, reason: 'exact', passages: [{ left: { excerpt: expect.stringContaining('Shared needle evidence') } }] }]);
    expect(JSON.stringify(duplicate.body)).not.toContain('wiki/hidden/');
    for (const user of ['bob', 'admin']) {
      expect((await get('/api/search/suggest?q=Needle', user).expect(200)).body[0].path).toBe('wiki/hidden/000.md');
      expect((await get(`/api/search/similar?path=${visible[0]}&limit=1`, user).expect(200)).body[0].path).toBe('wiki/hidden/000.md');
      expect((await get('/api/search/duplicates?limit=1', user).expect(200)).body[0]).toMatchObject({ left: { path: 'wiki/hidden/000.md' }, right: { path: 'wiki/hidden/001.md' } });
    }
  });

  it('removes restricted nodes, edges, connectivity, resolved links and tag counts', async () => {
    const links = await get(`/api/links?path=${visible[0]}`).expect(200);
    expect(links.body).toEqual({ outgoing: [], backlinks: [], unresolved: ['missing'] });
    expect((await get(`/api/links?path=${remote}`).expect(200)).body).toEqual({ outgoing: [], backlinks: [], unresolved: [] });
    const neighborhood = await get(`/api/graph?path=${visible[0]}&depth=2`).expect(200);
    expect(neighborhood.body).toEqual({ nodes: [{ path: visible[0], title: 'Needle', tags: ['common'] }], edges: [] });
    const graph = await get('/api/graph').expect(200);
    expect(graph.body.nodes.map((note: { path: string }) => note.path)).toEqual([...visible, remote]);
    expect(graph.body.edges).toEqual([]);
    expect((await get('/api/tags').expect(200)).body).toEqual([{ tag: 'common', count: 2 }, { tag: 'remote', count: 1 }]);
    expect((await get('/api/tags/notes?tag=common').expect(200)).body.map((note: { path: string }) => note.path)).toEqual(visible);
    expect((await get('/api/tags/notes?tag=classified').expect(200)).body).toEqual([]);
    for (const user of ['bob', 'admin']) {
      expect((await get(`/api/links?path=${visible[0]}`, user).expect(200)).body.outgoing).toEqual([{ path: bridge, title: 'Secret bridge' }]);
      const allowed = await get(`/api/graph?path=${visible[0]}&depth=2`, user).expect(200);
      expect(allowed.body.nodes.map((note: { path: string }) => note.path)).toContain(remote);
      expect(allowed.body.edges).toContainEqual({ from: bridge, to: remote });
      expect((await get('/api/tags', user).expect(200)).body).toEqual([{ tag: 'classified', count: 1 }, { tag: 'common', count: 222 }, { tag: 'remote', count: 1 }]);
      expect((await get('/api/tags/notes?tag=classified', user).expect(200)).body).toEqual([{ path: bridge, title: 'Secret bridge' }]);
    }
  });

  it.each(['/api/links', '/api/graph', '/api/search/similar'])('returns not_found for restricted source paths on %s', async (url) => {
    const denied = await get(`${url}?path=${bridge}`).expect(404);
    expect(denied.body.error.code).toBe('not_found');
    await get(`${url}?path=${bridge}`, 'bob').expect(200);
    await get(`${url}?path=${bridge}`, 'admin').expect(200);
  });

  it('preserves snapshots across index changes but invalidates them on policy revisions', async () => {
    const first = await get('/api/search?q=needle&tags=common&limit=1').expect(200);
    const root = join(directory, 'knowledge');
    await rm(join(root, visible[1]!));
    await exec('git', ['add', '--all'], { cwd: root });
    await exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'Remove second page'], { cwd: root });
    await indexer.syncToHead();
    const cursorUrl = `/api/search?q=needle&tags=common&limit=1&cursor=${first.body.nextCursor}`;
    expect((await get(cursorUrl).expect(200)).body.hits.map((hit: { path: string }) => hit.path)).toEqual([visible[1]]);
    const rule = acl.create({ prefix: visible[1]!, subjectType: 'user', subject: String(alice.id), access: 'none' }, admin);
    try {
      const denied = await get(cursorUrl).expect(400);
      expect(denied.body.error.code).toBe('invalid_search');
      expect((await get('/api/search?q=needle&tags=common&limit=20').expect(200)).body.hits.map((hit: { path: string }) => hit.path)).toEqual([visible[0]]);
    } finally { acl.delete(rule.id, admin); }
  });
});
