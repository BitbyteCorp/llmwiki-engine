import { Test } from '@nestjs/testing';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../../src/config.js';
import { openDb, runMigrations } from '../../src/db/index.js';
import { AclService } from '../../src/acl/acl.service.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { UsersService } from '../../src/auth/users.service.js';
import { UsersRepository } from '../../src/auth/users.repository.js';
import { CONFIG, DB, LOGGER } from '../../src/common/tokens.js';
import { embedTexts } from '../../src/rag/embeddings.js';
import { SearchService } from '../../src/rag/search.service.js';
import type { SearchHit } from '../../src/rag/types.js';
import { startFakeOpenAI } from '../fake-openai.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(overrides: Partial<Config> = {}) {
  const db = openDb(':memory:');
  cleanup.push(() => { db.close(); });
  runMigrations(db);
  const config = { ...loadConfig({ NODE_ENV: 'test', EMBEDDING_DIMENSIONS: '2' }), ...overrides };
  const log = pino({ enabled: false });
  const app = await Test.createTestingModule({
    providers: [
      SearchService,
      { provide: AclService, useValue: new AclService(db, new UsersService(new UsersRepository(db)), new AuditService(db)) },
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
    kind?: SearchHit['kind']; ordinal?: number; vector?: number[]; pending?: boolean }) {
    const id = ++nextId;
    db.prepare(`INSERT INTO chunks
      (id, path, title, heading, content, embedding_text, content_hash, kind, ordinal, vector_pending)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.path, input.title ?? '노트', input.heading ?? '', input.content,
        input.content, String(id), input.kind ?? 'wiki', input.ordinal ?? 0,
        input.vector && !input.pending ? 0 : 1);
    if (input.vector) {
      db.prepare('INSERT INTO chunk_vectors(chunk_id, embedding) VALUES (?, ?)')
        .run(BigInt(id), Buffer.from(new Float32Array(input.vector).buffer));
    }
    return id;
  }
  return { db, config, search, chunk };
}

async function vectorFixture(query: string) {
  const fake = await startFakeOpenAI();
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
      kind: 'wiki', related: ['wiki/incoming.md', 'wiki/outgoing.md'],
    }]);
  });

  it('still retrieves vector candidates for short queries', async () => {
    const f = await vectorFixture('저장');
    f.chunk({ path: 'wiki/a.md', content: '파일 보존 정책', vector: f.queryVector });
    expect((await f.search.search('저장')).map((hit) => hit.path)).toEqual(['wiki/a.md']);
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
