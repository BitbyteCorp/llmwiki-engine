import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../../src/config.js';
import { openDb } from '../../src/db/index.js';
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
  db.exec(readFileSync(new URL('../../src/db/migrations/006_rag.sql', import.meta.url), 'utf8'));
  const config = { ...loadConfig({ NODE_ENV: 'test', EMBEDDING_DIMENSIONS: '2' }), ...overrides };
  const log = pino({ enabled: false });
  const warn = vi.spyOn(log, 'warn');
  const app = await Test.createTestingModule({
    providers: [
      SearchService,
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
  return { db, config, search, warn, chunk };
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
    expect(await f.search.search('저장소')).toEqual([{
      path: 'wiki/storage.md', title: '지식 관리', heading: '관리 > 보존',
      snippet: '저장소는 main을 보존한다.', score: expect.closeTo(0.0163934426, 9),
      kind: 'wiki', related: ['wiki/incoming.md', 'wiki/outgoing.md'],
    }]);
  });

  it('logs the missing embedding key once per service while retaining keyword results', async () => {
    const f = await fixture();
    f.chunk({ path: 'wiki/a.md', content: '저장소는 안전하다.' });
    expect((await f.search.search('저장소'))[0]?.path).toBe('wiki/a.md');
    expect((await f.search.search('안전하다'))[0]?.path).toBe('wiki/a.md');
    expect(f.warn).toHaveBeenCalledTimes(1);
    expect(f.warn).toHaveBeenCalledWith(expect.stringContaining('OPENAI_API_KEY'));
  });

  it('returns no keyword candidates for queries shorter than three Unicode codepoints', async () => {
    const f = await fixture();
    f.chunk({ path: 'wiki/a.md', content: '저장소는 중요하다. 😀😀' });
    expect(await f.search.search('저장')).toEqual([]);
    expect(await f.search.search('😀😀')).toEqual([]);
  });

  it('still retrieves vector candidates for short queries', async () => {
    const f = await vectorFixture('저장');
    f.chunk({ path: 'wiki/a.md', content: '파일 보존 정책', vector: f.queryVector });
    expect((await f.search.search('저장')).map((hit) => hit.path)).toEqual(['wiki/a.md']);
  });

  it('quotes the complete keyword query and escapes embedded quotation marks', async () => {
    const f = await fixture();
    f.chunk({ path: 'wiki/exact.md', content: 'alpha" OR "beta' });
    f.chunk({ path: 'wiki/other.md', content: 'beta unrelated' });
    expect((await f.search.search('alpha" OR "beta')).map((hit) => hit.path)).toEqual(['wiki/exact.md']);
  });

  it('filters keyword kinds before selecting the top fifty candidates', async () => {
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

  it('fuses chunk ranks, sums note scores and chooses the best fused chunk rather than first keyword chunk', async () => {
    const f = await vectorFixture('저장소');
    f.chunk({ path: 'wiki/combined.md', heading: '첫째', content: '저장소 첫째', ordinal: 0,
      vector: [f.queryVector[0]! + 2, f.queryVector[1]!] });
    f.chunk({ path: 'wiki/combined.md', heading: '둘째', content: '저장소 둘째', ordinal: 1,
      vector: f.queryVector });
    f.chunk({ path: 'wiki/single.md', heading: '원문', content: '벡터만 해당',
      vector: [f.queryVector[0]! + 1, f.queryVector[1]!] });
    const hits = await f.search.search('저장소');
    expect(hits.map((hit) => hit.path)).toEqual(['wiki/combined.md', 'wiki/single.md']);
    expect(hits[0]).toMatchObject({ heading: '둘째', snippet: '저장소 둘째' });
    // Worked RRF example: keyword ranks 1,2; vector ranks 3,1 for the two combined chunks.
    expect(hits[0]!.score).toBeCloseTo(0.0647889334, 9);
    expect(hits[1]!.score).toBeCloseTo(0.0161290323, 9);
    expect(await f.search.search('저장소', { limit: 1 })).toEqual([hits[0]]);
    expect(await f.search.search('저장소')).toEqual(hits);
  });

  it('ranks equal vector distances deterministically by chunk id', async () => {
    const f = await vectorFixture('두글');
    f.chunk({ path: 'wiki/z.md', content: '본문', vector: f.queryVector });
    f.chunk({ path: 'wiki/a.md', content: '본문', vector: f.queryVector });
    // Equal distances still produce stable, distinct RRF ranks.
    const hits = await f.search.search('두글');
    expect(hits.map((hit) => hit.path)).toEqual(['wiki/z.md', 'wiki/a.md']);
    expect(hits[0]!.score).toBeCloseTo(0.0163934426, 9);
    expect(hits[1]!.score).toBeCloseTo(0.0161290323, 9);
  });

  it('breaks equal fused note scores by path, not candidate insertion order', async () => {
    const f = await vectorFixture('저장소');
    f.chunk({ path: 'wiki/z.md', content: '저장소', vector: [f.queryVector[0]! + 1, f.queryVector[1]!] });
    f.chunk({ path: 'wiki/a.md', content: '저장소', vector: f.queryVector });
    const hits = await f.search.search('저장소');
    expect(hits.map((hit) => hit.path)).toEqual(['wiki/a.md', 'wiki/z.md']);
    expect(hits[0]!.score).toBeCloseTo(0.0325224749, 9);
    expect(hits[1]!.score).toBeCloseTo(0.0325224749, 9);
  });

  it('returns ten notes by default and never takes more than fifty keyword candidates', async () => {
    const f = await fixture();
    const paths = Array.from({ length: 51 }, (_, i) => `wiki/${String(i).padStart(2, '0')}.md`);
    for (const path of paths) f.chunk({ path, content: '저장소' });
    expect((await f.search.search('저장소')).map((hit) => hit.path)).toEqual(paths.slice(0, 10));
    expect((await f.search.search('저장소', { limit: 100 })).map((hit) => hit.path)).toEqual(paths.slice(0, 50));
  });

  it('skips pending vectors while still finding their keyword content', async () => {
    const f = await vectorFixture('저장소');
    f.chunk({ path: 'wiki/pending.md', content: '저장소', vector: f.queryVector, pending: true });
    const hits = await f.search.search('저장소');
    expect(hits[0]!.score).toBeCloseTo(0.0163934426, 9);
  });

  it.each([
    ['embedding_model', 'old-model'],
    ['embedding_dimensions', '1536'],
  ])('ignores stale vectors when %s differs from configuration', async (key, value) => {
    const f = await vectorFixture('저장소');
    f.chunk({ path: 'wiki/a.md', content: '저장소는 보존된다.', vector: f.queryVector });
    f.db.prepare('UPDATE index_meta SET value = ? WHERE key = ?').run(value, key);
    // An invalid endpoint ensures stale indices cannot trigger an embedding API request.
    f.config.openaiBaseUrl = 'http://127.0.0.1:1/v1';
    const hits = await f.search.search('저장소');
    expect(hits[0]!.score).toBeCloseTo(0.0163934426, 9);
  });

  it('surfaces embedding API failures instead of silently falling back to keyword search', async () => {
    const f = await vectorFixture('저장소');
    f.chunk({ path: 'wiki/a.md', content: '저장소', vector: f.queryVector });
    const server = createServer((_request, response) => {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Embedding model unavailable', type: 'invalid_request_error' } }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    f.config.openaiBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    await expect(f.search.search('저장소')).rejects.toThrow('Embedding model unavailable');
  });

  it('returns no results for whitespace without making embedding requests', async () => {
    const f = await fixture({ openaiApiKey: 'test-key', openaiBaseUrl: 'http://127.0.0.1:1/v1' });
    expect(await f.search.search(' \n\t ')).toEqual([]);
    expect(f.warn).not.toHaveBeenCalled();
  });

  it.each([0, -1, 101, 1.5, Number.NaN])('rejects invalid limit %s', async (limit) => {
    const f = await fixture();
    await expect(f.search.search('저장소', { limit })).rejects.toThrow(RangeError);
  });
});
