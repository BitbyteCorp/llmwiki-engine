import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import type { Server } from 'node:http';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GraphController, LinksController } from '../api/links.controller.js';
import { TagsController } from '../api/tags.controller.js';
import { ApiTokensService } from '../auth/api-tokens.service.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { SessionsService } from '../auth/sessions.service.js';
import type { User } from '../auth/users.types.js';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter.js';
import { DB } from '../common/tokens.js';
import { openDb, runMigrations, type Db } from '../db/index.js';
import { AclService } from '../acl/acl.service.js';
import { AuditService } from '../audit/audit.service.js';
import { UsersService } from '../auth/users.service.js';
import { UsersRepository } from '../auth/users.repository.js';
import { CatalogService } from './catalog.service.js';

let db: Db;
let catalog: CatalogService;
let app: INestApplication | undefined;

function addNote(path: string, title: string, tags: string[] = [], ordinal = 0): void {
  db.prepare(`INSERT INTO chunks
    (path, title, heading, content, embedding_text, content_hash, kind, ordinal, tags, tags_json)
    VALUES (?, ?, '', 'content', 'content', ?, 'wiki', ?, ?, ?)`)
    .run(path, title, `${path}:${ordinal}`, ordinal, tags.join(' '), JSON.stringify(tags));
}

function addLink(source: string, name: string, target: string | null): void {
  db.prepare('INSERT INTO links(source_path, target_name, target_path) VALUES (?, ?, ?)')
    .run(source, name, target);
}

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db);
  catalog = new CatalogService(db, new AclService(db, new UsersService(new UsersRepository(db)), new AuditService(db)));
});

afterEach(async () => {
  if (app) {
    (app.getHttpServer() as Server).closeAllConnections();
    await app.close();
    app = undefined;
  }
  db.close();
});

function seedGraph(): void {
  addNote('wiki/A.md', 'Alpha', ['maps', 'maps', 'project-plan']);
  addNote('wiki/A.md', 'Alpha', ['maps', 'maps', 'project-plan'], 1);
  addNote('wiki/B.md', 'Beta', ['maps', '한글']);
  addNote('wiki/C.md', 'Gamma', ['science']);
  addNote('wiki/D.md', 'Delta');
  addNote('wiki/E.md', 'Epsilon', ['maps']);
  addNote('wiki/F.md', 'Isolated');
  addLink('wiki/A.md', 'beta', 'wiki/B.md');
  addLink('wiki/A.md', 'beta alias', 'wiki/B.md');
  addLink('wiki/A.md', 'unknown', null);
  addLink('wiki/A.md', 'deleted', 'wiki/Deleted.md');
  addLink('wiki/B.md', 'gamma', 'wiki/C.md');
  addLink('wiki/C.md', 'beta', 'wiki/B.md');
  addLink('wiki/C.md', 'delta', 'wiki/D.md');
  addLink('wiki/E.md', 'alpha', 'wiki/A.md');
  addLink('wiki/E.md', 'alpha alias', 'wiki/A.md');
  addLink('wiki/Ghost.md', 'alpha', 'wiki/A.md');
}

const alpha = { path: 'wiki/A.md', title: 'Alpha', tags: ['maps', 'maps', 'project-plan'] };
const beta = { path: 'wiki/B.md', title: 'Beta', tags: ['maps', '한글'] };
const gamma = { path: 'wiki/C.md', title: 'Gamma', tags: ['science'] };
const delta = { path: 'wiki/D.md', title: 'Delta', tags: [] };
const epsilon = { path: 'wiki/E.md', title: 'Epsilon', tags: ['maps'] };
const isolated = { path: 'wiki/F.md', title: 'Isolated', tags: [] };

const firstEdges = [
  { from: 'wiki/A.md', to: 'wiki/B.md' },
  { from: 'wiki/E.md', to: 'wiki/A.md' },
];

const allEdges = [
  { from: 'wiki/A.md', to: 'wiki/B.md' },
  { from: 'wiki/B.md', to: 'wiki/C.md' },
  { from: 'wiki/C.md', to: 'wiki/B.md' },
  { from: 'wiki/C.md', to: 'wiki/D.md' },
  { from: 'wiki/E.md', to: 'wiki/A.md' },
];

describe('CatalogService', () => {
  it('returns distinct outgoing notes, backlinks and unresolved names without dangling notes', () => {
    seedGraph();
    expect(catalog.links('wiki/A.md')).toEqual({
      outgoing: [{ path: 'wiki/B.md', title: 'Beta' }],
      backlinks: [{ path: 'wiki/E.md', title: 'Epsilon' }],
      unresolved: ['deleted', 'unknown'],
    });
    expect(catalog.links('wiki/F.md')).toEqual({ outgoing: [], backlinks: [], unresolved: [] });
  });

  it('traverses links in either direction by bounded depth and preserves directed edges through cycles', () => {
    seedGraph();
    expect(catalog.graph('wiki/A.md', 1)).toEqual({ nodes: [alpha, beta, epsilon], edges: firstEdges });
    expect(catalog.graph('wiki/A.md', 2)).toEqual({
      nodes: [alpha, beta, gamma, epsilon],
      edges: [allEdges[0], allEdges[1], allEdges[2], allEdges[4]],
    });
    expect(catalog.graph('wiki/A.md', 3)).toEqual({ nodes: [alpha, beta, gamma, delta, epsilon], edges: allEdges });
    expect(catalog.graph()).toEqual({ nodes: [alpha, beta, gamma, delta, epsilon, isolated], edges: allEdges });
    expect(catalog.graph('wiki/Deleted.md', 5)).toEqual({ nodes: [], edges: [] });
  });

  it('does not share mutable link summaries, graph nodes, tags or edges between responses', () => {
    seedGraph();
    const links = catalog.links('wiki/A.md');
    links.outgoing[0]!.title = 'Mutated outgoing';
    links.backlinks[0]!.path = 'wiki/Mutated.md';
    links.unresolved.push('Mutated missing');
    const graph = catalog.graph('wiki/A.md', 1);
    graph.nodes[0]!.title = 'Mutated node';
    graph.nodes[0]!.tags.push('mutated-tag');
    graph.edges[0]!.to = 'wiki/Mutated.md';
    graph.nodes.splice(1);
    expect(catalog.links('wiki/A.md')).toEqual({
      outgoing: [{ path: 'wiki/B.md', title: 'Beta' }],
      backlinks: [{ path: 'wiki/E.md', title: 'Epsilon' }],
      unresolved: ['deleted', 'unknown'],
    });
    expect(catalog.graph('wiki/A.md', 1)).toEqual({ nodes: [alpha, beta, epsilon], edges: firstEdges });
  });

  it('counts distinct notes per tag and matches NFKC, lowercase, hash-prefixed normalized facets', () => {
    seedGraph();
    expect(catalog.tags()).toEqual([
      { tag: 'maps', count: 3 },
      { tag: 'project-plan', count: 1 },
      { tag: 'science', count: 1 },
      { tag: '한글', count: 1 },
    ]);
    expect(catalog.tagNotes('  #ＭＡＰＳ  ')).toEqual([
      { path: 'wiki/A.md', title: 'Alpha' },
      { path: 'wiki/B.md', title: 'Beta' },
      { path: 'wiki/E.md', title: 'Epsilon' },
    ]);
    expect(catalog.tagNotes('#PROJECT PLAN')).toEqual([{ path: 'wiki/A.md', title: 'Alpha' }]);
    expect(catalog.tagNotes('map')).toEqual([]);
  });

  it('suggests title and path matches with prefixes first and treats SQL wildcard characters literally', () => {
    addNote('wiki/0-substring.md', 'About Navigation');
    addNote('wiki/1-prefix.md', 'Navigation');
    addNote('wiki/navigation-guide.md', 'Guide');
    addNote('wiki/literal.md', '100%_\\ complete');
    addNote('wiki/1-prefix.md', 'Navigation', [], 1);
    expect(catalog.suggest('  NAVIGATION  ')).toEqual([
      { path: 'wiki/1-prefix.md', title: 'Navigation' },
      { path: 'wiki/0-substring.md', title: 'About Navigation' },
      { path: 'wiki/navigation-guide.md', title: 'Guide' },
    ]);
    expect(catalog.suggest('%_\\')).toEqual([{ path: 'wiki/literal.md', title: '100%_\\ complete' }]);
    expect(catalog.suggest('  ')).toEqual([]);
    const matches = Array.from({ length: 25 }, (_, i) => ({
      path: `wiki/limit-${String(i).padStart(2, '0')}.md`, title: 'Limit match',
    }));
    for (const note of matches) addNote(note.path, note.title);
    expect(catalog.suggest('Limit')).toEqual(matches.slice(0, 20));
  });
});

describe('catalog REST routes', () => {
  async function origin(): Promise<string> {
    const module = await Test.createTestingModule({
      controllers: [LinksController, GraphController, TagsController],
      providers: [
        CatalogService, SessionGuard, RolesGuard,
        { provide: AclService, useValue: new AclService(db, new UsersService(new UsersRepository(db)), new AuditService(db)) },
        { provide: DB, useValue: db },
        { provide: ApiTokensService, useValue: {} },
        { provide: SessionsService, useValue: {
          sessionUser: (req: Request): User | null => req.get('x-session') ? {
            id: 1, email: 'viewer@example.com', name: 'Viewer', role: 'viewer',
            createdAt: '2026-01-01T00:00:00.000Z', lastLoginAt: null,
          } : null,
          assertSameOrigin: () => {},
        } },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalFilters(new HttpExceptionFilter(pino({ level: 'silent' })));
    await app.listen(0, '127.0.0.1');
    const address = (app.getHttpServer() as Server).address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    return `http://127.0.0.1:${address.port}`;
  }

  it('allows viewer sessions to browse links, graph and tag facets', async () => {
    seedGraph();
    const base = await origin();
    const headers = { 'x-session': 'viewer' };
    const links = await fetch(`${base}/api/links?path=wiki/A.md`, { headers });
    expect(links.status).toBe(200);
    expect(await links.json()).toEqual({
      outgoing: [{ path: 'wiki/B.md', title: 'Beta' }],
      backlinks: [{ path: 'wiki/E.md', title: 'Epsilon' }],
      unresolved: ['deleted', 'unknown'],
    });
    const graph = await fetch(`${base}/api/graph?path=wiki/A.md&depth=2`, { headers });
    expect(await graph.json()).toEqual({
      nodes: [alpha, beta, gamma, epsilon],
      edges: [allEdges[0], allEdges[1], allEdges[2], allEdges[4]],
    });
    expect(await (await fetch(`${base}/api/tags`, { headers })).json()).toEqual([
      { tag: 'maps', count: 3 }, { tag: 'project-plan', count: 1 },
      { tag: 'science', count: 1 }, { tag: '한글', count: 1 },
    ]);
    expect(await (await fetch(`${base}/api/tags/notes?tag=%23PROJECT%20PLAN`, { headers })).json())
      .toEqual([{ path: 'wiki/A.md', title: 'Alpha' }]);
  });

  it('requires sessions and rejects absent parameters, unsafe paths and depth outside 1 through 5', async () => {
    const base = await origin();
    for (const route of ['/api/links?path=wiki/A.md', '/api/graph', '/api/tags', '/api/tags/notes?tag=maps']) {
      const response = await fetch(`${base}${route}`);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: 'unauthorized', message: expect.any(String) } });
    }
    for (const route of [
      '/api/links', '/api/links?path=../private.md', '/api/tags/notes', '/api/tags/notes?tag=%20',
      '/api/graph?depth=0', '/api/graph?depth=6', '/api/graph?depth=1.5', '/api/graph?depth=nope',
    ]) {
      const response = await fetch(`${base}${route}`, { headers: { 'x-session': 'viewer' } });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'invalid_input', message: expect.any(String) } });
    }
  });
});
