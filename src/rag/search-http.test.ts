import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { CONFIG, DB, LOGGER } from '../common/tokens.js';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter.js';
import { openDb, runMigrations, type Db } from '../db/index.js';
import { AclService } from '../acl/acl.service.js';
import { AuditService } from '../audit/audit.service.js';
import { UsersService } from '../auth/users.service.js';
import { UsersRepository } from '../auth/users.repository.js';
import { SessionsService } from '../auth/sessions.service.js';
import { ApiTokensService } from '../auth/api-tokens.service.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { SearchController } from '../api/search.controller.js';
import { LinksController, GraphController } from '../api/links.controller.js';
import { TagsController } from '../api/tags.controller.js';
import { SearchService } from './search.service.js';
import { CatalogService } from './catalog.service.js';
import { ComparisonService } from './comparison.service.js';
import { NOTE_TYPES } from '../knowledge/note-metadata.js';

const paths = ['wiki/alpha.md', 'wiki/beta.md', 'journal/day.md'];
describe('search workspace HTTP', () => {
  let app: INestApplication;
  let db: Db;
  beforeEach(async () => {
    db = openDb(':memory:');
    runMigrations(db);
    const put = db.prepare(`INSERT INTO chunks(path,title,heading,content,embedding_text,content_hash,kind,ordinal,tags,tags_json,anchor,updated_at,author,normalized_hash)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    put.run(paths[0], 'Alpha 저장', '검색', '저장 데이터 검색', 'alpha', 'a', 'wiki', 0, 'search', '["search"]', '검색', '2026-10-01T00:00:00.000Z', 'Ada <ada@example.com>', 'same');
    put.run(paths[1], 'Beta', '', '저장 데이터 검색', 'beta', 'b', 'wiki', 0, 'search', '["search"]', null, '2026-10-02T00:00:00.000Z', 'Bob <bob@example.com>', 'same');
    put.run(paths[2], 'Journal', '', '일기 기록', 'journal', 'c', 'journal', 0, 'journal', '["journal"]', null, null, null, 'different');
    db.prepare('UPDATE chunks SET note_type=?,description=?,aliases=?,aliases_json=? WHERE path=?')
      .run('guide', 'Durable storage procedure', '영속 보관', '["영속 보관"]', paths[0]);
    db.prepare('UPDATE chunks SET note_type=? WHERE path=?').run('concept', paths[1]);
    const link = db.prepare('INSERT INTO links(source_path,target_name,target_path) VALUES(?,?,?)');
    link.run(paths[0], 'beta', paths[1]); link.run(paths[1], 'day', paths[2]); link.run(paths[0], 'missing', null);
    const log = pino({ enabled: false });
    const module = await Test.createTestingModule({
      controllers: [SearchController, LinksController, GraphController, TagsController],
      providers: [SearchService, CatalogService, ComparisonService, SessionGuard, RolesGuard,
        { provide: AclService, useValue: new AclService(db, new UsersService(new UsersRepository(db)), new AuditService(db)) },
        { provide: CONFIG, useValue: loadConfig({ NODE_ENV: 'test', EMBEDDING_DIMENSIONS: '2' }) },
        { provide: DB, useValue: db }, { provide: LOGGER, useValue: log },
        { provide: ApiTokensService, useValue: { authenticate: () => { throw new Error('No bearer fixture'); } } },
        { provide: SessionsService, useValue: {
          sessionUser: (req: Request) => req.get('x-session') === 'viewer' ? { id: 1, email: 'viewer@example.com', name: 'Viewer', role: 'viewer' } : null,
          assertSameOrigin: () => {},
        } },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new HttpExceptionFilter(log));
    await app.init();
  });
  afterEach(async () => { vi.restoreAllMocks(); await app.close(); db.close(); });

  it('serves enriched filtered hits and quick-open suggestions to a viewer', async () => {
    const result = await request(app.getHttpServer()).get('/api/search').query({ q: '저장', type: 'guide', folder: 'wiki', tags: 'SEARCH', author: 'Ada', from: '2026-10-01', to: '2026-10-01' }).set('x-session', 'viewer').expect(200);
    expect(result.body).toMatchObject({ mode: 'keyword', degraded: { reason: 'no_api_key' }, nextCursor: null,
      hits: [{ path: paths[0], type: 'guide', description: 'Durable storage procedure', anchor: '검색', excerpt: '저장 데이터 검색', tags: ['search'], updatedAt: '2026-10-01T00:00:00.000Z', highlights: [[0, 2]] }] });
    const suggest = await request(app.getHttpServer()).get('/api/search/suggest?q=Al').set('x-session', 'viewer').expect(200);
    expect(suggest.body.map((note: { path: string }) => note.path)).toEqual([paths[0], paths[2]]);
  });

  it.each(NOTE_TYPES)('accepts and passes through the singular type filter %s', async (type) => {
    const result = await request(app.getHttpServer()).get('/api/search').query({ q: '저장', type })
      .set('x-session', 'viewer').expect(200);
    const expected = type === 'guide' ? [paths[0]] : type === 'concept' ? [paths[1]] : [];
    expect(result.body.hits.map((hit: { path: string }) => hit.path)).toEqual(expected);
    for (const hit of result.body.hits) expect(hit.type).toBe(type);
    if (type === 'concept') expect(result.body.hits[0].description).toBeNull();
  });

  it.each(['영속', 'durable storage', '관'])('finds alias and summary-only lexical hits for %s', async (q) => {
    const result = await request(app.getHttpServer()).get('/api/search').query({ q, type: 'guide' })
      .set('x-session', 'viewer').expect(200);
    expect(result.body.hits).toEqual([expect.objectContaining({
      path: paths[0], type: 'guide', description: 'Durable storage procedure',
    })]);
  });

  it('returns null metadata fields for notes without metadata', async () => {
    const result = await request(app.getHttpServer()).get('/api/search').query({ q: '일기' })
      .set('x-session', 'viewer').expect(200);
    expect(result.body.hits).toEqual([expect.objectContaining({ path: paths[2], type: null, description: null })]);
  });

  it('serves directional links, the full graph and distinct note tag facets', async () => {
    const links = await request(app.getHttpServer()).get('/api/links').query({ path: paths[1] }).set('x-session', 'viewer').expect(200);
    expect(links.body).toEqual({ outgoing: [{ path: paths[2], title: 'Journal' }], backlinks: [{ path: paths[0], title: 'Alpha 저장' }], unresolved: [] });
    const alpha = await request(app.getHttpServer()).get('/api/links').query({ path: paths[0] }).set('x-session', 'viewer').expect(200);
    expect(alpha.body.unresolved).toEqual(['missing']);
    const graph = await request(app.getHttpServer()).get('/api/graph').set('x-session', 'viewer').expect(200);
    expect(graph.body.nodes.map((node: { path: string }) => node.path)).toEqual([paths[2], paths[0], paths[1]]);
    expect(graph.body.edges).toEqual([{ from: paths[0], to: paths[1] }, { from: paths[1], to: paths[2] }]);
    const facets = await request(app.getHttpServer()).get('/api/tags').set('x-session', 'viewer').expect(200);
    expect(facets.body).toEqual([{ tag: 'journal', count: 1 }, { tag: 'search', count: 2 }]);
    const notes = await request(app.getHttpServer()).get('/api/tags/notes?tag=SEARCH').set('x-session', 'viewer').expect(200);
    expect(notes.body).toEqual([{ path: paths[0], title: 'Alpha 저장' }, { path: paths[1], title: 'Beta' }]);
  });

  it('keeps duplicates read-only and does not return linked-only semantic neighbors', async () => {
    const pairs = await request(app.getHttpServer()).get('/api/search/duplicates?limit=1').set('x-session', 'viewer').expect(200);
    expect(pairs.body).toMatchObject([{ left: { path: paths[0] }, right: { path: paths[1] }, reason: 'exact', score: 1,
      passages: [{ left: { excerpt: '저장 데이터 검색' }, right: { excerpt: '저장 데이터 검색' } }] }]);
    const similar = await request(app.getHttpServer()).get('/api/search/similar').query({ path: paths[0] }).set('x-session', 'viewer').expect(200);
    expect(similar.body).toEqual([]);
    expect((db.prepare('SELECT COUNT(*) AS count FROM chunks').get() as { count: number }).count).toBe(3);
  });

  it('keeps the unscoped duplicates HTTP default over all readable notes, including raw sources', async () => {
    db.prepare(`INSERT INTO chunks(path,title,heading,content,embedding_text,content_hash,kind,ordinal,normalized_hash)
      VALUES(?,?,?,?,?,?,?,?,?)`).run('raw/source.md', 'Source', '', '저장 데이터 검색', 'raw', 'raw-source', 'raw', 0, 'same');
    const response = await request(app.getHttpServer()).get('/api/search/duplicates').set('x-session', 'viewer').expect(200);
    expect(response.body.map(({ left, right }: { left: { path: string }; right: { path: string } }) => [left.path, right.path])).toEqual([
      ['raw/source.md', paths[0]], ['raw/source.md', paths[1]], [paths[0], paths[1]],
    ]);
  });

  it('rejects duplicate results invalidated by a policy change with the public search error', async () => {
    vi.spyOn(app.get(ComparisonService), 'duplicates').mockRejectedValueOnce(new RangeError('Search policy changed; retry the query'));
    const response = await request(app.getHttpServer()).get('/api/search/duplicates').set('x-session', 'viewer').expect(400);
    expect(response.body).toMatchObject({ error: { code: 'invalid_search', message: 'Search policy changed; retry the query' } });
    expect(response.body).not.toHaveProperty('passages');
  });

  it.each(['/api/search?q=저장', '/api/search/suggest?q=a', '/api/search/similar?path=wiki/alpha.md', '/api/search/duplicates', '/api/links?path=wiki/alpha.md', '/api/graph', '/api/tags', '/api/tags/notes?tag=search'])('requires authentication for %s', async (url) => {
    const response = await request(app.getHttpServer()).get(url).expect(401);
    expect(response.body.error.code).toBe('unauthorized');
  });

  it.each(['/api/search', '/api/search?q=a&limit=0', '/api/search?q=a&limit=101', '/api/search?q=a&limit=1.5', '/api/search?q=a&from=bad', '/api/search?q=a&type=unknown', '/api/search?q=a&type=wiki', '/api/search?q=a&type=', '/api/search?q=a&type=Guide', '/api/search?q=a&type=guide,entity', '/api/search?q=a&type=guide&type=entity', '/api/search/similar?path=../x.md', '/api/search/duplicates?limit=0', '/api/links', '/api/tags/notes'])('validates query inputs for %s', async (url) => {
    const response = await request(app.getHttpServer()).get(url).set('x-session', 'viewer').expect(400);
    expect(response.body.error.code).toBe('invalid_input');
  });

  it('rejects invalid cursors with a public error instead of a server failure', async () => {
    const response = await request(app.getHttpServer()).get('/api/search?q=저장&cursor=bad.1').set('x-session', 'viewer').expect(400);
    expect(response.body.error.code).toBe('invalid_search');
  });
});
