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
import { embedTexts } from '../../src/rag/embeddings.js';
import { SearchService } from '../../src/rag/search.service.js';
import type { SearchHit, SearchOptions } from '../../src/rag/types.js';
import { UsageService } from '../../src/usage/usage.service.js';
import { UsageRepository } from '../../src/usage/usage.repository.js';
import { startFakeOpenAI } from '../fake-openai.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function fixture(overrides: Partial<Config> = {}) {
  const db = openDb(':memory:');
  cleanup.push(() => { db.close(); });
  runMigrations(db);
  const config = { ...loadConfig({ NODE_ENV: 'test', EMBEDDING_DIMENSIONS: '2' }), ...overrides };
  const log = pino({ enabled: false });
  const users = new UsersService(new UsersRepository(db));
  const acl = new AclService(db, users, new AuditService(db));
  const app = await Test.createTestingModule({
    providers: [
      SearchService, UsageService, UsageRepository,
      { provide: AclService, useValue: acl },
      { provide: CONFIG, useValue: config },
      { provide: DB, useValue: db },
      { provide: LOGGER, useValue: log },
    ],
  }).compile();
  cleanup.push(() => app.close());
  await app.init();
  const search = app.get(SearchService);
  let nextId = 0;
  function chunk(input: { path: string; content: string; title?: string; heading?: string;
    kind?: SearchHit['kind']; ordinal?: number; vector?: number[]; pending?: boolean;
    anchor?: string; type?: SearchHit['type']; tags?: string[]; updatedAt?: string; author?: string }) {
    const id = ++nextId;
    db.prepare(`INSERT INTO chunks
      (id, path, title, heading, content, embedding_text, content_hash, kind, ordinal, vector_pending,
       anchor, note_type, tags, tags_json, updated_at, author)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.path, input.title ?? '노트', input.heading ?? '', input.content,
        input.content, String(id), input.kind ?? 'wiki', input.ordinal ?? 0,
        input.vector && !input.pending ? 0 : 1, input.anchor ?? null, input.type ?? null,
        (input.tags ?? []).join(' '), JSON.stringify(input.tags ?? []), input.updatedAt ?? null, input.author ?? null);
    if (input.vector) {
      db.prepare('INSERT INTO chunk_vectors(chunk_id, embedding) VALUES (?, ?)')
        .run(BigInt(id), Buffer.from(new Float32Array(input.vector).buffer));
    }
    return id;
  }
  return { db, config, search, chunk, users, acl, usage: app.get(UsageService) };
}

async function vectorFixture(query: string) {
  const fake = await startFakeOpenAI([], { embeddingUsage: { promptTokens: 13, totalTokens: 17 } });
  cleanup.push(() => fake.close());
  const f = await fixture({ openaiApiKey: 'test-key', openaiBaseUrl: fake.url });
  f.db.exec('CREATE VIRTUAL TABLE chunk_vectors USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[2])');
  const meta = f.db.prepare('INSERT INTO index_meta(key, value) VALUES (?, ?)');
  meta.run('embedding_model', f.config.embeddingModel);
  meta.run('embedding_dimensions', String(f.config.embeddingDimensions));
  const [queryVector] = await embedTexts(f.config, [query]);
  return { ...f, queryVector: queryVector!, fake };
}

describe('SearchService', () => {
  it.each(['expansion', 'reranking'])('cancels an in-flight %s request without returning fallback results', async (stage) => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fake = await startFakeOpenAI(async (_request, index) => {
      if (index === 0) {
        started.resolve();
        await release.promise;
      }
      return '[]';
    });
    cleanup.push(() => fake.close());
    const f = await fixture({ openaiApiKey: 'test-key', openaiBaseUrl: fake.url,
      searchExpand: stage === 'expansion' ? 'llm' : 'off', searchRerank: 'llm' });
    f.chunk({ path: 'wiki/one.md', content: 'storage one' });
    f.chunk({ path: 'wiki/two.md', content: 'storage two' });
    const controller = new AbortController();
    const reason = new Error('Search cancelled');
    const outcome = f.search.search('storage', {}, controller.signal).then(
      (hits) => ({ hits }), (error: unknown) => ({ error }),
    );
    // Real HTTP abort latency is the contract; fake timers cannot drive the socket lifecycle.
    const startedTimer = setTimeout(() => started.reject(new Error('Search never reached Responses')), 2000);
    let abortTimer: NodeJS.Timeout | undefined;
    try {
      await started.promise;
      controller.abort(reason);
      const deadline = new Promise<'timeout'>((resolve) => {
        abortTimer = setTimeout(() => resolve('timeout'), 500);
      });
      expect(await Promise.race([outcome, deadline])).toEqual({ error: reason });
      expect(fake.requests.map((request) => request.path)).toEqual(['/v1/responses']);
    } finally {
      clearTimeout(startedTimer);
      clearTimeout(abortTimer);
      release.resolve();
      await outcome;
    }
  });

  it('matches Korean substrings and returns both incoming and outgoing one-hop links', async () => {
    const f = await fixture();
    f.chunk({ path: 'wiki/storage.md', title: '지식 관리', heading: '관리 > 보존', content: '저장소는 main을 보존한다.' });
    const link = f.db.prepare('INSERT INTO links(source_path, target_name, target_path) VALUES (?, ?, ?)');
    link.run('wiki/storage.md', 'outgoing', 'wiki/outgoing.md');
    link.run('wiki/storage.md', 'outgoing-alias', 'wiki/outgoing.md');
    link.run('wiki/incoming.md', 'storage', 'wiki/storage.md');
    link.run('wiki/storage.md', 'self', 'wiki/storage.md');
    link.run('wiki/storage.md', 'missing', null);
    link.run('wiki/outgoing.md', 'second-hop', 'wiki/second-hop.md');
    expect(await f.search.search('저장소')).toMatchObject([{
      path: 'wiki/storage.md', title: '지식 관리', heading: '관리 > 보존',
      snippet: '저장소는 main을 보존한다.',
      kind: 'wiki', related: ['wiki/incoming.md', 'wiki/outgoing.md'], via: null,
    }]);
  });

  it.each(['wiki', 'journal', 'other'] as const)('excludes even stronger raw evidence when %s has an original lexical match', async (kind) => {
    const f = await fixture();
    const path = kind === 'other' ? 'reference.md' : `${kind}/storage.md`;
    f.chunk({ path: 'raw/source.md', kind: 'raw', title: 'Storage', content: 'Storage policy.' });
    f.chunk({ path, kind, title: 'Garden', content: 'An incidental storage reference.' });
    const hits = await f.search.search('storage');
    expect(hits.map((hit) => hit.path)).toEqual([path]);
    expect(hits[0]!.via).toBeNull();
  });

  it.each([
    ['storage policy', 'Storage describes durable media; the policy governs retention.'],
    ['저장 책', '저장 지침과 여러 설명 뒤에 책 보존 규칙이 있다.'],
  ])('treats separated AND evidence as strong for %s', async (query, content) => {
    const f = await fixture();
    f.chunk({ path: 'wiki/curated.md', content });
    f.chunk({ path: 'raw/source.md', kind: 'raw', title: query, content: query });
    expect(await f.search.search(query)).toMatchObject([{ path: 'wiki/curated.md', via: null }]);
  });

  it('excludes raw notes from hybrid results when curated lexical evidence is strong', async () => {
    const f = await vectorFixture('storage');
    f.chunk({ path: 'raw/source.md', kind: 'raw', title: 'Storage', content: 'Storage policy.', vector: f.queryVector });
    f.chunk({ path: 'wiki/storage.md', content: 'Storage policy.', vector: f.queryVector });
    const result = await f.search.query('storage');
    expect(result.mode).toBe('hybrid');
    expect(result.hits.map((hit) => hit.path)).toEqual(['wiki/storage.md']);
    expect(result.hits[0]!.via).toBeNull();
  });

  it('pivots from strong raw evidence when curated matches are OR-only, building the lowest qualifying ordinal', async () => {
    const f = await fixture();
    f.chunk({ path: 'wiki/weak.md', content: 'storage overview', type: 'guide', tags: ['selected'] });
    f.chunk({ path: 'raw/source.md', kind: 'raw', content: 'storage policy evidence.',
      heading: 'Source evidence', anchor: 'source-evidence', type: 'guide', tags: ['selected'] });
    f.chunk({ path: 'wiki/curated.md', ordinal: 5, content: 'Later overview.', type: 'guide', tags: ['selected'] });
    f.chunk({ path: 'wiki/curated.md', ordinal: 0, content: 'Excluded introduction.', type: 'reference', tags: ['selected'] });
    f.chunk({ path: 'wiki/curated.md', ordinal: 2, title: 'Curated overview', heading: 'Introduction',
      anchor: 'introduction', content: 'Selected introduction.', type: 'guide', tags: ['selected'] });
    const link = f.db.prepare('INSERT INTO links(source_path, target_name, target_path) VALUES (?, ?, ?)');
    link.run('wiki/curated.md', 'source', 'raw/source.md');
    link.run('wiki/curated.md', 'context', 'wiki/context.md');
    const hits = await f.search.search('storage policy', { type: 'guide', tags: ['selected'] });
    expect(hits.map((hit) => hit.path)).toEqual(['wiki/curated.md', 'wiki/weak.md']);
    expect(hits[0]).toMatchObject({
      title: 'Curated overview', heading: 'Introduction', anchor: 'introduction',
      snippet: 'Selected introduction.', excerpt: 'Selected introduction.', highlights: [],
      type: 'guide', tags: ['selected'], related: ['raw/source.md', 'wiki/context.md'],
      via: { path: 'raw/source.md', heading: 'Source evidence', anchor: 'source-evidence',
        excerpt: 'storage policy evidence.', highlights: [[0, 7], [8, 14]] },
    });
    expect(hits[1]!.via).toBeNull();
  });

  it('reuses a vector-only stage-one hit and its best chunk when pivoting through raw evidence', async () => {
    const f = await vectorFixture('storage policy');
    f.chunk({ path: 'wiki/curated.md', ordinal: 0, heading: 'Introduction', content: 'Earlier overview.',
      vector: [f.queryVector[0]! + 10, f.queryVector[1]!] });
    f.chunk({ path: 'wiki/curated.md', ordinal: 1, heading: 'Retention', anchor: 'retention',
      content: 'Best retention guidance.', vector: f.queryVector });
    f.chunk({ path: 'raw/source.md', kind: 'raw', content: 'storage policy evidence.', vector: f.queryVector });
    f.db.prepare('INSERT INTO links(source_path, target_name, target_path) VALUES (?, ?, ?)')
      .run('wiki/curated.md', 'source', 'raw/source.md');
    const [curated] = await f.search.search('storage policy', { kinds: ['wiki', 'journal', 'other'] });
    const [raw] = await f.search.search('storage policy', { kinds: ['raw'] });
    const result = await f.search.query('storage policy');
    expect(result.mode).toBe('hybrid');
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toEqual({
      ...curated!, score: raw!.score,
      via: { path: 'raw/source.md', heading: '', anchor: null,
        excerpt: 'storage policy evidence.', highlights: [[0, 7], [8, 14]] },
    });
    expect(result.hits[0]).toMatchObject({ heading: 'Retention', anchor: 'retention', snippet: 'Best retention guidance.' });
  });

  it('returns uncited strong raw evidence before weak curated hits, with direct via null', async () => {
    const f = await fixture();
    f.chunk({ path: 'wiki/weak.md', title: 'Storage', content: 'storage overview' });
    f.chunk({ path: 'raw/source.md', kind: 'raw', content: 'storage policy evidence.' });
    const hits = await f.search.search('storage policy');
    expect(hits.map((hit) => hit.path)).toEqual(['raw/source.md', 'wiki/weak.md']);
    expect(hits.every((hit) => hit.via === null)).toBe(true);
  });

  it('sorts citing notes by path and deduplicates them without exposing an already-cited raw note', async () => {
    const f = await fixture();
    f.chunk({ path: 'wiki/weak.md', content: 'storage overview' });
    f.chunk({ path: 'raw/a.md', kind: 'raw', title: 'Storage source', content: 'Unrelated introduction.', ordinal: 0 });
    f.chunk({ path: 'raw/a.md', kind: 'raw', title: 'Storage source', heading: 'Evidence', anchor: 'evidence',
      content: 'storage policy evidence.', ordinal: 1 });
    f.chunk({ path: 'raw/b.md', kind: 'raw', content: 'storage policy evidence.' });
    for (const path of ['wiki/z.md', 'wiki/shared.md', 'wiki/a.md']) {
      f.chunk({ path, content: 'Curated overview.' });
    }
    const link = f.db.prepare('INSERT INTO links(source_path, target_name, target_path) VALUES (?, ?, ?)');
    link.run('wiki/z.md', 'a', 'raw/a.md');
    link.run('wiki/shared.md', 'a', 'raw/a.md');
    link.run('wiki/a.md', 'a', 'raw/a.md');
    link.run('wiki/a.md', 'a-alias', 'raw/a.md');
    link.run('wiki/shared.md', 'b', 'raw/b.md');
    link.run('raw/another.md', 'a', 'raw/a.md');
    link.run('wiki/no-chunk.md', 'a', 'raw/a.md');
    const hits = await f.search.search('storage policy');
    expect(hits.map((hit) => hit.path)).toEqual(['wiki/a.md', 'wiki/shared.md', 'wiki/z.md', 'wiki/weak.md']);
    for (const hit of hits.slice(0, 3)) {
      expect(hit.via).toEqual({ path: 'raw/a.md', heading: 'Evidence', anchor: 'evidence',
        excerpt: 'storage policy evidence.', highlights: [[0, 7], [8, 14]] });
    }
    expect(hits[3]!.via).toBeNull();
  });

  it.each([
    { type: 'guide' as const },
    { tags: ['selected'] },
    { from: '2026-01-01' },
    { to: '2026-01-31' },
    { author: 'Alice' },
  ])('leaves raw evidence direct when its only citing note fails filter %j', async (filters) => {
    const f = await fixture();
    f.chunk({ path: 'raw/source.md', kind: 'raw', content: 'storage policy evidence.',
      type: 'guide', tags: ['selected'], updatedAt: '2026-01-15T12:00:00.000Z', author: 'Alice' });
    f.chunk({ path: 'wiki/excluded.md', content: 'Curated overview.', type: 'reference', tags: ['other'],
      updatedAt: filters.to ? '2026-02-01T00:00:00.000Z' : '2025-12-31T00:00:00.000Z', author: 'Bob' });
    f.db.prepare('INSERT INTO links(source_path, target_name, target_path) VALUES (?, ?, ?)')
      .run('wiki/excluded.md', 'source', 'raw/source.md');
    expect(await f.search.search('storage policy', filters)).toMatchObject([{ path: 'raw/source.md', via: null }]);
  });

  it('requires one citing chunk to satisfy all filters rather than combining metadata across chunks', async () => {
    const f = await fixture();
    f.chunk({ path: 'raw/source.md', kind: 'raw', content: 'storage policy evidence.',
      type: 'guide', tags: ['selected'] });
    f.chunk({ path: 'wiki/excluded.md', ordinal: 0, content: 'First overview.', type: 'guide', tags: ['other'] });
    f.chunk({ path: 'wiki/excluded.md', ordinal: 1, content: 'Second overview.', type: 'reference', tags: ['selected'] });
    f.db.prepare('INSERT INTO links(source_path, target_name, target_path) VALUES (?, ?, ?)')
      .run('wiki/excluded.md', 'source', 'raw/source.md');
    expect(await f.search.search('storage policy', { type: 'guide', tags: ['selected'] }))
      .toMatchObject([{ path: 'raw/source.md', via: null }]);
  });

  it('applies ACL to raw evidence and citing notes without leaking hidden sources through pivots', async () => {
    const f = await fixture();
    const admin = await f.users.create({ email: 'admin@example.com', role: 'admin' });
    const reader = await f.users.create({ email: 'reader@example.com', role: 'viewer' });
    f.acl.create({ prefix: 'wiki/hidden/', subjectType: 'everyone', subject: '', access: 'none' }, admin);
    f.acl.create({ prefix: 'raw/hidden/', subjectType: 'everyone', subject: '', access: 'none' }, admin);
    f.chunk({ path: 'raw/source.md', kind: 'raw', content: 'storage policy evidence.' });
    f.chunk({ path: 'raw/hidden/source.md', kind: 'raw', title: 'Storage policy', content: 'storage policy secret.' });
    f.chunk({ path: 'wiki/hidden/curated.md', content: 'Private curated overview.' });
    f.chunk({ path: 'wiki/public-overview.md', content: 'Public curated overview.' });
    f.chunk({ path: 'wiki/public-weak.md', content: 'storage overview' });
    const link = f.db.prepare('INSERT INTO links(source_path, target_name, target_path) VALUES (?, ?, ?)');
    link.run('wiki/hidden/curated.md', 'source', 'raw/source.md');
    link.run('wiki/public-overview.md', 'secret', 'raw/hidden/source.md');
    const hits = await f.search.search('storage policy', { user: reader });
    expect(hits.map((hit) => hit.path)).toEqual(['raw/source.md', 'wiki/public-weak.md']);
    expect(hits.every((hit) => hit.via === null)).toBe(true);
    expect(JSON.stringify(hits)).not.toContain('hidden/');
    expect(await f.search.search('storage policy')).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'wiki/public-overview.md',
        via: expect.objectContaining({ path: 'raw/hidden/source.md' }) }),
      expect.objectContaining({ path: 'wiki/hidden/curated.md',
        via: expect.objectContaining({ path: 'raw/source.md' }) }),
    ]));
  });

  it('retains stage-one results when raw retrieval has only OR-relaxed evidence', async () => {
    const f = await fixture();
    f.chunk({ path: 'wiki/weak.md', content: 'storage overview' });
    f.chunk({ path: 'raw/weak.md', kind: 'raw', content: 'policy overview' });
    expect(await f.search.search('storage policy')).toMatchObject([{ path: 'wiki/weak.md', via: null }]);
  });

  it('retains vector-only curated results when no raw note has strong original evidence', async () => {
    const f = await vectorFixture('storage policy');
    f.chunk({ path: 'wiki/semantic.md', content: 'Retention guidance.', vector: f.queryVector });
    f.chunk({ path: 'raw/semantic.md', kind: 'raw', content: 'Retention details.', vector: f.queryVector });
    const result = await f.search.query('storage policy');
    expect(result.mode).toBe('hybrid');
    expect(result.hits).toMatchObject([{ path: 'wiki/semantic.md', via: null }]);
  });

  it('does not treat expanded aliases as strong original evidence in either tier', async () => {
    const fake = await startFakeOpenAI(['["retention"]']);
    cleanup.push(() => fake.close());
    const f = await fixture({ openaiApiKey: 'test-key', openaiBaseUrl: fake.url, searchExpand: 'llm' });
    f.chunk({ path: 'wiki/alias.md', content: 'retention guidance' });
    f.chunk({ path: 'raw/source.md', kind: 'raw', content: 'storage policy evidence.' });
    f.chunk({ path: 'raw/alias.md', kind: 'raw', title: 'Retention', content: 'retention details' });
    f.db.prepare('INSERT INTO links(source_path, target_name, target_path) VALUES (?, ?, ?)')
      .run('wiki/alias.md', 'source', 'raw/source.md');
    const hits = await f.search.search('storage policy');
    expect(hits).toMatchObject([{ path: 'wiki/alias.md', excerpt: 'retention guidance', highlights: [],
      via: { path: 'raw/source.md', excerpt: 'storage policy evidence.', highlights: [[0, 7], [8, 14]] } }]);
  });

  it('reranks curated candidates but never reranks the raw fallback tier', async () => {
    const fake = await startFakeOpenAI(() => '[1,0]');
    cleanup.push(() => fake.close());
    const f = await fixture({ openaiApiKey: 'test-key', openaiBaseUrl: fake.url, searchRerank: 'llm' });
    f.chunk({ path: 'wiki/a.md', title: 'Storage', content: 'storage details' });
    f.chunk({ path: 'wiki/b.md', content: 'storage overview' });
    f.chunk({ path: 'raw/a.md', kind: 'raw', title: 'Storage policy', content: 'storage policy evidence.' });
    f.chunk({ path: 'raw/b.md', kind: 'raw', content: 'storage policy evidence.' });
    const hits = await f.search.search('storage policy');
    expect(hits.map((hit) => hit.path)).toEqual(['raw/a.md', 'raw/b.md', 'wiki/b.md', 'wiki/a.md']);
    expect(hits.every((hit) => hit.via === null)).toBe(true);
    expect(fake.requests.map((request) => request.path)).toEqual(['/v1/responses']);
    expect(JSON.parse(String(fake.requests[0]!.body.input)).passages).toEqual([
      { index: 0, title: 'Storage', excerpt: 'storage details' },
      { index: 1, title: '노트', excerpt: 'storage overview' },
    ]);
  });

  it.each(['curated', 'raw'] as const)('keeps stage-one mode and reports degradation when %s vectors are pending', async (pendingTier) => {
    const f = await vectorFixture('storage policy');
    f.chunk({ path: 'wiki/weak.md', content: 'storage overview', vector: f.queryVector, pending: pendingTier === 'curated' });
    f.chunk({ path: 'raw/source.md', kind: 'raw', content: 'storage policy evidence.', vector: f.queryVector,
      pending: pendingTier === 'raw' });
    const result = await f.search.query('storage policy');
    expect(result.mode).toBe(pendingTier === 'curated' ? 'keyword' : 'hybrid');
    expect(result.degraded).toEqual({ reason: 'index_stale' });
    expect(result.hits.map((hit) => hit.path)).toEqual(['raw/source.md', 'wiki/weak.md']);
  });

  it('keeps explicit mixed kinds single-stage and never pivots their raw matches', async () => {
    const f = await fixture();
    f.chunk({ path: 'wiki/weak.md', content: 'storage overview' });
    f.chunk({ path: 'wiki/curated.md', content: 'Unrelated curated overview.' });
    f.chunk({ path: 'raw/source.md', kind: 'raw', title: 'Storage policy', content: 'storage policy evidence.' });
    f.db.prepare('INSERT INTO links(source_path, target_name, target_path) VALUES (?, ?, ?)')
      .run('wiki/curated.md', 'source', 'raw/source.md');
    const opts: SearchOptions = { kinds: ['wiki', 'raw'] };
    const hits = await f.search.search('storage policy', opts);
    expect(hits.map((hit) => hit.path)).toEqual(['raw/source.md']);
    expect(hits[0]!.via).toBeNull();
  });

  it.each(['off', 'llm'] as const)('leaves raw-folder scores and ordering unchanged with reranking %s', async (searchRerank) => {
    const fake = await startFakeOpenAI(() => '[1,0]');
    cleanup.push(() => fake.close());
    const f = await fixture({ openaiApiKey: 'test-key', openaiBaseUrl: fake.url, searchRerank });
    f.chunk({ path: 'raw/a.md', kind: 'raw', title: 'Storage', content: 'Storage policy.' });
    f.chunk({ path: 'raw/b.md', kind: 'raw', title: 'Storage', content: 'Storage policy.' });
    f.chunk({ path: 'wiki/storage.md', title: 'Storage', content: 'Storage policy.' });
    f.chunk({ path: 'raw-extra/excluded.md', title: 'Storage', content: 'Storage policy.' });
    const unscopedRaw = await f.search.search('storage', { kinds: ['raw'] });
    const expectedPaths = searchRerank === 'llm' ? ['raw/b.md', 'raw/a.md'] : ['raw/a.md', 'raw/b.md'];
    expect(unscopedRaw.map((hit) => hit.path)).toEqual(expectedPaths);
    expect(unscopedRaw.every((hit) => hit.via === null)).toBe(true);
    expect(await f.search.search('storage', { folder: 'raw' })).toEqual(unscopedRaw);
    expect(await f.search.search('storage', { folder: 'raw/' })).toEqual(unscopedRaw);
  });

  it('still retrieves vector candidates for short queries', async () => {
    const f = await vectorFixture('저장');
    f.chunk({ path: 'wiki/a.md', content: '파일 보존 정책', vector: f.queryVector });
    expect((await f.search.search('저장')).map((hit) => hit.path)).toEqual(['wiki/a.md']);
  });

  it('reuses query embeddings while retrieving fresh results for each filter and index state', async () => {
    const f = await vectorFixture('storage');
    f.chunk({ path: 'wiki/one.md', content: 'storage one', vector: f.queryVector });
    f.chunk({ path: 'raw/two.md', content: 'storage two', kind: 'raw', vector: f.queryVector });
    const before = f.fake.requests.length;
    expect((await f.search.search('storage', { folder: 'wiki' })).map((hit) => hit.path)).toEqual(['wiki/one.md']);
    expect((await f.search.search('storage', { folder: 'raw' })).map((hit) => hit.path)).toEqual(['raw/two.md']);
    f.chunk({ path: 'wiki/three.md', content: 'storage three', vector: f.queryVector });
    expect((await f.search.search('storage', { folder: 'wiki' })).map((hit) => hit.path).sort())
      .toEqual(['wiki/one.md', 'wiki/three.md']);
    expect(f.fake.requests.slice(before).map((request) => request.path)).toEqual(['/v1/embeddings']);
    expect(f.usage.aggregate().rows).toEqual([expect.objectContaining({
      lane: 'embedding', model: 'text-embedding-3-small', calls: 1, inputTokens: 17,
      cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0,
    })]);
  });

  it('expires query embeddings after ten minutes without extending lifetime on a cache hit', async () => {
    const f = await vectorFixture('storage');
    f.chunk({ path: 'wiki/one.md', content: 'storage', vector: f.queryVector });
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const before = f.fake.requests.length;
    await f.search.search('storage');
    now += 599_999;
    await f.search.search('storage');
    expect(f.fake.requests.length - before).toBe(1);
    now += 1;
    expect((await f.search.search('storage')).map((hit) => hit.path)).toEqual(['wiki/one.md']);
    expect(f.fake.requests.length - before).toBe(2);
  });

  it('keys query embeddings by model and dimensions', async () => {
    const f = await vectorFixture('storage');
    f.chunk({ path: 'wiki/one.md', content: 'storage', vector: f.queryVector });
    const before = f.fake.requests.length;
    await f.search.search('storage');
    f.config.embeddingModel = 'another-model';
    f.db.prepare("UPDATE index_meta SET value=? WHERE key='embedding_model'").run(f.config.embeddingModel);
    await f.search.search('storage');
    f.config.embeddingDimensions = 3;
    f.db.prepare("UPDATE index_meta SET value='3' WHERE key='embedding_dimensions'").run();
    f.db.exec('DROP TABLE chunk_vectors; CREATE VIRTUAL TABLE chunk_vectors USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[3])');
    await f.search.search('storage');
    expect(f.fake.requests.slice(before).map(({ body }) => [body.model, body.dimensions])).toEqual([
      ['text-embedding-3-small', 2], ['another-model', 2], ['another-model', 3],
    ]);
  });

  it('records expansion and rerank usage even when their output cannot be used', async () => {
    const fake = await startFakeOpenAI([
      { text: 'not JSON', usage: { inputTokens: 11, cachedInputTokens: 3, outputTokens: 7, reasoningTokens: 2 } },
      { text: '[0,0]', usage: { inputTokens: 23, cachedInputTokens: 5, outputTokens: 9, reasoningTokens: 4 } },
    ]);
    cleanup.push(() => fake.close());
    const f = await fixture({ openaiApiKey: 'test-key', openaiBaseUrl: fake.url,
      searchExpand: 'llm', searchRerank: 'llm' });
    f.chunk({ path: 'wiki/one.md', content: 'storage one' });
    f.chunk({ path: 'wiki/two.md', content: 'storage two' });
    expect((await f.search.search('storage')).map((hit) => hit.path)).toEqual(['wiki/one.md', 'wiki/two.md']);
    expect(f.usage.aggregate().rows).toEqual([expect.objectContaining({
      lane: 'search', model: f.config.llmModel, calls: 2, inputTokens: 34,
      cachedInputTokens: 8, outputTokens: 16, reasoningTokens: 6,
    })]);
  });

  it('treats embedded quotes and query operators as literal search text', async () => {
    const f = await fixture();
    f.chunk({ path: 'wiki/exact.md', content: 'alpha" OR "beta' });
    f.chunk({ path: 'wiki/other.md', content: 'beta unrelated' });
    expect((await f.search.search('alpha" OR "beta')).map((hit) => hit.path)).toEqual(['wiki/exact.md']);
  });

  it('finds the requested keyword kind even among many other kinds', async () => {
    const f = await fixture();
    for (let i = 0; i < 51; i++) f.chunk({ path: `wiki/${i}.md`, content: '저장소' });
    f.chunk({ path: 'journal/day.md', content: '저장소', kind: 'journal' });
    const hits = await f.search.search('저장소', { kinds: ['journal'] });
    expect(hits.map((hit) => [hit.path, hit.kind])).toEqual([['journal/day.md', 'journal']]);
    expect(await f.search.search('저장소', { kinds: [] })).toEqual([]);
  });

  it('filters vector kinds before nearest selection instead of starving a distant kind', async () => {
    const f = await vectorFixture('질문');
    for (let i = 0; i < 51; i++) {
      f.chunk({ path: `wiki/${i}.md`, content: '위키', vector: [f.queryVector[0]! + i / 100, f.queryVector[1]!] });
    }
    f.chunk({ path: 'raw/source.md', content: '원문', kind: 'raw',
      vector: [f.queryVector[0]! + 10, f.queryVector[1]!] });
    expect((await f.search.search('질문', { kinds: ['raw'] })).map((hit) => hit.path)).toEqual(['raw/source.md']);
  });

  it('returns the best matching chunk as a note preview and respects an explicit limit', async () => {
    const f = await vectorFixture('저장소');
    f.chunk({ path: 'wiki/combined.md', heading: '첫째', content: '관련 없는 소개', ordinal: 0,
      vector: [f.queryVector[0]! + 2, f.queryVector[1]!] });
    f.chunk({ path: 'wiki/combined.md', heading: '둘째', content: '저장소 둘째', ordinal: 1,
      vector: f.queryVector });
    f.chunk({ path: 'wiki/single.md', heading: '원문', content: '벡터만 해당',
      vector: [f.queryVector[0]! + 1, f.queryVector[1]!] });
    const hits = await f.search.search('저장소');
    expect(hits.map((hit) => hit.path)).toEqual(['wiki/combined.md', 'wiki/single.md']);
    expect(hits[0]).toMatchObject({ heading: '둘째', snippet: '저장소 둘째' });
    expect(await f.search.search('저장소', { limit: 1 })).toEqual([hits[0]]);
    expect(await f.search.search('저장소')).toEqual(hits);
  });

  it('skips pending vectors while still finding their keyword content', async () => {
    const f = await vectorFixture('저장소');
    f.chunk({ path: 'wiki/pending.md', content: '저장소', vector: f.queryVector, pending: true });
    f.chunk({ path: 'wiki/vector-only.md', content: '별개의 내용', vector: f.queryVector, pending: true });
    const hits = await f.search.search('저장소');
    expect(hits.map((hit) => hit.path)).toEqual(['wiki/pending.md']);
  });

  it.each([
    ['embedding_model', 'old-model'],
    ['embedding_dimensions', '1536'],
  ])('ignores stale vectors when %s differs from configuration', async (key, value) => {
    const f = await vectorFixture('저장소');
    f.chunk({ path: 'wiki/a.md', content: '저장소는 보존된다.', vector: f.queryVector });
    f.chunk({ path: 'wiki/vector-only.md', content: '별개의 내용', vector: f.queryVector });
    f.db.prepare('UPDATE index_meta SET value = ? WHERE key = ?').run(value, key);
    const requests = f.fake.requests.length;
    const hits = await f.search.search('저장소');
    expect(hits.map((hit) => hit.path)).toEqual(['wiki/a.md']);
    expect(f.fake.requests).toHaveLength(requests);
  });

  it('returns no results for whitespace without making embedding requests', async () => {
    const f = await vectorFixture('질문');
    f.chunk({ path: 'wiki/a.md', content: '본문', vector: f.queryVector });
    const requests = f.fake.requests.length;
    expect(await f.search.search(' \n\t ')).toEqual([]);
    expect(f.fake.requests).toHaveLength(requests);
  });

  it.each([0, -1, 101, 1.5, Number.NaN])('rejects invalid limit %s', async (limit) => {
    const f = await fixture();
    await expect(f.search.search('저장소', { limit })).rejects.toThrow(RangeError);
  });
});
