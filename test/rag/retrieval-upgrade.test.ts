import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { openDb, runMigrations } from '../../src/db/index.js';
import { KnowledgeRepo } from '../../src/knowledge/repo.js';
import { startFakeOpenAI, type FakeScript } from '../fake-openai.js';
import { evaluationNotes, evaluationQueries, retrievalMetrics, type EvaluationNote } from '../../src/rag/evaluation-fixtures.js';
import { IndexerService } from '../../src/rag/indexer.service.js';
import { SearchService } from '../../src/rag/search.service.js';
import type { SearchOptions } from '../../src/rag/types.js';
import { AclService } from '../../src/acl/acl.service.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { UsersService } from '../../src/auth/users.service.js';
import { UsersRepository } from '../../src/auth/users.repository.js';

const exec = promisify(execFile);
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close(); }
  finally { vi.restoreAllMocks(); }
});

async function fixture(notes: readonly EvaluationNote[], options: { embeddings?: boolean; script?: FakeScript } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'llmwiki-retrieval-upgrade-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const fake = options.embeddings ? await startFakeOpenAI(options.script) : null;
  if (fake) cleanup.push(() => fake.close());
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: directory, EMBEDDING_DIMENSIONS: '32',
    ...(fake ? { OPENAI_API_KEY: 'fake-key', OPENAI_BASE_URL: fake.url } : {}) });
  const logger = pino({ enabled: false });
  const db = openDb(join(directory, 'engine.sqlite'));
  cleanup.push(() => db.close());
  runMigrations(db);
  const repo = await KnowledgeRepo.open(config, logger);
  const knowledge = join(directory, 'knowledge');
  // The corpus, not bootstrap documentation, defines evaluation relevance.
  for (const path of await repo.listFiles()) await rm(join(knowledge, path));
  async function commit(
    additions: readonly EvaluationNote[],
    options: { remove?: string[]; date?: string; name?: string; email?: string } = {},
  ) {
    for (const path of options.remove ?? []) await rm(join(knowledge, path));
    for (const note of additions) {
      await mkdir(dirname(join(knowledge, note.path)), { recursive: true });
      await writeFile(join(knowledge, note.path), note.markdown);
    }
    const date = options.date ?? '2024-06-15T12:00:00Z';
    const env = { ...process.env, GIT_AUTHOR_NAME: options.name ?? 'Ada',
      GIT_AUTHOR_EMAIL: options.email ?? 'ada@example.com', GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    await exec('git', ['add', '--all'], { cwd: knowledge, env });
    await exec('git', ['commit', '--allow-empty', '-m', 'Curated retrieval corpus'], { cwd: knowledge, env });
    return repo.headSha();
  }
  await commit(notes);
  const indexer = new IndexerService(config, db, logger, repo);
  indexer.init();
  await indexer.syncToHead();
  const acl = new AclService(db, new UsersService(new UsersRepository(db)), new AuditService(db));
  const search = new SearchService(config, db, logger, acl, repo);
  return { config, repo, indexer, search, fake, commit };
}

function pagingNotes(count = 6): EvaluationNote[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `wiki/page-${String(index).padStart(2, '0')}.md`,
    markdown: `# Paging\nPaging evidence number ${index}.`,
  }));
}

describe('retrieval upgrade public search contract', () => {
  it.each(['권', '권한'])('retrieves %s without an embedding API key', async (query) => {
    const f = await fixture([
      { path: 'wiki/access.md', markdown: '# 접근 정책\n권한은 읽기와 편집으로 나뉜다.' },
      { path: 'wiki/garden.md', markdown: '# 정원\n꽃을 심었다.' },
    ]);
    expect(await f.search.query(query)).toMatchObject({ mode: 'keyword', degraded: { reason: 'no_api_key' },
      hits: [{ path: 'wiki/access.md', via: null }], nextCursor: null });
    expect((await f.search.search(query)).map((hit) => hit.path)).toEqual(['wiki/access.md']);
  });

  it('finds separated terms with AND and only falls back to OR when no note has all terms', async () => {
    const f = await fixture([
      { path: 'wiki/both.md', markdown: '# Combined\nalpha appears here, several intervening words later omega appears.' },
      { path: 'wiki/alpha.md', markdown: '# First\nalpha only.' },
      { path: 'wiki/omega.md', markdown: '# Second\nomega only.' },
    ]);
    expect((await f.search.search('alpha omega')).map((hit) => hit.path)).toEqual(['wiki/both.md']);
    await f.commit([], { remove: ['wiki/both.md'] });
    await f.indexer.syncToHead();
    expect((await f.search.search('alpha omega')).map((hit) => hit.path).sort()).toEqual(['wiki/alpha.md', 'wiki/omega.md']);
  });

  it('normalizes frontmatter tags and requires all selected tags', async () => {
    const f = await fixture([
      { path: 'wiki/tagged.md', markdown: '---\ntitle: Storage guide\ntags: ["#ＳＴＯＲＡＧＥ", " Storage ", "#권한"]\n---\n# Storage guide\nDurable notes.' },
      { path: 'wiki/partial.md', markdown: '---\ntags: [storage]\n---\n# Other storage guide\nDurable notes.' },
      { path: 'wiki/untagged.md', markdown: '# Storage guide\nDurable notes.' },
    ]);
    const hits = await f.search.search('storage', { tags: ['#ＳＴＯＲＡＧＥ', '권한'] });
    expect(hits.map((hit) => hit.path)).toEqual(['wiki/tagged.md']);
    expect(hits[0]?.tags).toEqual(['storage', '권한']);
    expect(await f.search.search('storage', { tags: ['absent'] })).toEqual([]);
  });

  it.each(['durable storage', '스토리지', '저장', '권', 'term-separated summary', '영속 복구'])('retrieves metadata-only aliases and summaries for %s', async (query) => {
    const f = await fixture([
      { path: 'wiki/metadata.md', markdown: '---\ntitle: Persistence\ntype: concept\ndescription: "  term-separated details for summary and 영속 복구  "\naliases: ["Durable storage", "스토리지", "저장", "권"]\n---\n# Persistence\nData survives a restart.' },
      { path: 'wiki/garden.md', markdown: '# Garden\nFlowers bloom.' },
    ]);
    const result = await f.search.query(query);
    expect(result).toMatchObject({ mode: 'keyword', hits: [{ path: 'wiki/metadata.md', title: 'Persistence',
      type: 'concept', description: 'term-separated details for summary and 영속 복구' }] });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.snippet).not.toContain(query);
  });

  it('preserves title priority while weighting alias and summary matches above incidental body matches', async () => {
    const f = await fixture([
      { path: 'wiki/z-title.md', markdown: '# Recovery\nA procedure.' },
      { path: 'wiki/y-alias.md', markdown: '---\naliases: [Recovery]\n---\n# Persistence\nA procedure.' },
      { path: 'wiki/x-summary.md', markdown: '---\ndescription: Recovery\n---\n# Continuity\nA procedure.' },
      { path: 'wiki/a-body.md', markdown: '# Garden\nRecovery was mentioned in a meeting.' },
    ]);
    expect((await f.search.search('recovery')).map((hit) => hit.path))
      .toEqual(['wiki/z-title.md', 'wiki/y-alias.md', 'wiki/x-summary.md', 'wiki/a-body.md']);
  });

  it('returns null metadata for legacy or invalid frontmatter', async () => {
    const f = await fixture([
      { path: 'wiki/legacy.md', markdown: '# Legacy\nMetadata evidence.' },
      { path: 'wiki/invalid.md', markdown: '---\ntype: unsupported\ndescription: [not, prose]\n---\n# Invalid\nMetadata evidence.' },
    ]);
    const hits = await f.search.search('metadata evidence');
    expect(hits).toHaveLength(2);
    for (const hit of hits) expect(hit).toMatchObject({ type: null, description: null });
  });

  it('applies type before lexical candidate limits independently of the storage kind', async () => {
    const excluded = Array.from({ length: 205 }, (_, index) => ({
      path: `wiki/excluded/${index}.md`, markdown: '---\ntype: entity\n---\n# Storage\nStorage evidence.',
    }));
    const f = await fixture([...excluded,
      { path: 'wiki/eligible.md', markdown: '---\ntype: guide\n---\n# Procedure\nStorage evidence.' },
      { path: 'journal/eligible.md', markdown: '---\ntype: guide\n---\n# Journal\nStorage evidence.' },
    ]);
    expect((await f.search.search('storage', { type: 'guide', kinds: ['wiki'] })).map((hit) => hit.path))
      .toEqual(['wiki/eligible.md']);
    expect((await f.search.search('storage', { type: 'guide' })).map((hit) => hit.path).sort())
      .toEqual(['journal/eligible.md', 'wiki/eligible.md']);
  }, 30_000);

  it.each(['unsupported', '', 'wiki', 'concept,entity', null, ['concept']])('rejects an invalid internal type filter %j', async (type) => {
    const f = await fixture([]);
    // @ts-expect-error Exercise runtime validation for untyped callers.
    await expect(f.search.query('storage', { type })).rejects.toThrow(/type/i);
  });

  it('normalizes internal type filters before retrieval and cursor fingerprinting', async () => {
    const f = await fixture(pagingNotes(3).map((note) => ({ ...note, markdown: `---\ntype: guide\n---\n${note.markdown}` })));
    // @ts-expect-error Exercise normalization at the untyped service boundary.
    const first = await f.search.query('paging', { type: ' GUIDE ', limit: 1 });
    expect(first.hits[0]).toMatchObject({ type: 'guide', description: null });
    expect(first.nextCursor).not.toBeNull();
    expect((await f.search.query('paging', { type: 'guide', cursor: first.nextCursor!, limit: 1 })).hits)
      .toEqual([expect.objectContaining({ path: 'wiki/page-01.md', type: 'guide' })]);
    await expect(f.search.query('paging', { type: 'entity', cursor: first.nextCursor! })).rejects.toThrow(/cursor/i);
    await expect(f.search.query('paging', { cursor: first.nextCursor! })).rejects.toThrow(/cursor/i);
  });

  it('weights title evidence above an incidental body occurrence', async () => {
    const f = await fixture([
      { path: 'wiki/z-title.md', markdown: '---\ntitle: Credential rotation\n---\n# Procedure\nIssue a replacement and revoke the old secret.' },
      { path: 'wiki/a-body.md', markdown: '# Garden\nThe meeting mentioned credential rotation among unrelated garden purchases.' },
    ]);
    expect((await f.search.search('credential rotation')).map((hit) => hit.path)).toEqual(['wiki/z-title.md', 'wiki/a-body.md']);
  });

  it.each([
    ['folder', { folder: 'wiki/eligible' }, '2019-01-01T12:00:00Z'],
    ['from', { from: '2024-06-15' }, '2019-01-01T12:00:00Z'],
    ['to', { to: '2024-06-15' }, '2025-01-01T12:00:00Z'],
    ['author', { author: 'ADA@EXAMPLE.COM' }, '2019-01-01T12:00:00Z'],
    ['type', { type: 'guide' }, '2019-01-01T12:00:00Z'],
  ] satisfies Array<[string, SearchOptions, string]>)('applies %s before vector top-k selection', async (_label, filters, excludedDate) => {
    // Identical input to the query gives every excluded note an exact fake-vector match.
    // There are more excluded notes than the candidate budget, so post-filtering starves the eligible note.
    const nearest = '# nearest\nunfiltered evidence';
    const f = await fixture([], { embeddings: true });
    await f.commit(Array.from({ length: 205 }, (_, index) => ({ path: `wiki/excluded/${index}.md`, markdown: `---\ntype: entity\n---\n${nearest}` })),
      { date: excludedDate, name: 'Other', email: 'other@example.com' });
    await f.commit([{ path: 'wiki/eligible/answer.md', markdown: '---\ntype: guide\n---\n# Answer\nA distant but eligible semantic neighbor.' }]);
    await f.indexer.syncToHead();
    const result = await f.search.query(`nearest\n\n${nearest}`, filters);
    expect(result.mode).toBe('hybrid');
    expect(result.degraded).toBeNull();
    expect(result.hits.map((hit) => hit.path)).toEqual(['wiki/eligible/answer.md']);
  }, 30_000);

  it('uses inclusive day boundaries, path boundaries, and author filters together', async () => {
    const f = await fixture([
      { path: 'wiki/team/day.md', markdown: '# Calendar\nCalendar note.' },
      { path: 'wiki/team-extra/day.md', markdown: '# Calendar\nCalendar note.' },
    ]);
    expect((await f.search.search('calendar', { folder: 'wiki/team/', from: '2024-06-15', to: '2024-06-15', author: 'ada' }))
      .map((hit) => hit.path)).toEqual(['wiki/team/day.md']);
    expect(await f.search.search('calendar', { from: '2024-06-16' })).toEqual([]);
    expect(await f.search.search('calendar', { to: '2024-06-14' })).toEqual([]);
    expect(await f.search.search('calendar', { kinds: [] })).toEqual([]);
  });

  it('keeps cursor pages stable after notes are removed, added, and reindexed', async () => {
    const f = await fixture(pagingNotes());
    const expected = await f.search.search('paging', { limit: 100 });
    const first = await f.search.query('paging', { limit: 2 });
    expect(first.hits).toEqual(expected.slice(0, 2));
    expect(first.nextCursor).not.toBeNull();
    await f.commit([{ path: 'wiki/new.md', markdown: '# Paging\nPaging new evidence.' }], { remove: [expected[2]!.path] });
    await f.indexer.syncToHead();
    const second = await f.search.query('paging', { cursor: first.nextCursor!, limit: 3 });
    expect(second.hits).toEqual(expected.slice(2, 5));
    const third = await f.search.query('paging', { cursor: second.nextCursor!, limit: 2 });
    expect(third.hits).toEqual(expected.slice(5));
    expect(third.nextCursor).toBeNull();
    const refreshed = await f.search.search('paging', { limit: 100 });
    expect(refreshed.map((hit) => hit.path)).not.toContain(expected[2]!.path);
    expect(refreshed.map((hit) => hit.path)).toContain('wiki/new.md');
  });

  it('expires a cursor at five minutes without extending its lifetime on reads', async () => {
    const f = await fixture(pagingNotes());
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const first = await f.search.query('paging', { limit: 1 });
    clock.mockReturnValue(now + 299_999);
    expect((await f.search.query('paging', { cursor: first.nextCursor!, limit: 1 })).hits.map((hit) => hit.path))
      .toEqual(['wiki/page-01.md']);
    clock.mockReturnValue(now + 300_000);
    await expect(f.search.query('paging', { cursor: first.nextCursor! })).rejects.toThrow(/cursor/i);
  });

  it('rejects malformed cursors and cursors belonging to another query or filter', async () => {
    const f = await fixture(pagingNotes());
    const first = await f.search.query('paging', { limit: 1 });
    for (const cursor of ['not-a-cursor', `${first.nextCursor}.extra`, `${first.nextCursor!.split('.')[0]}.0`,
      `${first.nextCursor!.split('.')[0]}.99999`]) {
      await expect(f.search.query('paging', { cursor })).rejects.toThrow(/cursor/i);
    }
    await expect(f.search.query('different', { cursor: first.nextCursor! })).rejects.toThrow(/cursor/i);
    await expect(f.search.query('paging', { cursor: first.nextCursor!, tags: ['new-filter'] })).rejects.toThrow(/cursor/i);
  });

  it('bounds retained snapshots to the latest two hundred queries', async () => {
    const f = await fixture(pagingNotes(2));
    const oldest = await f.search.query('paging', { limit: 1 });
    let newest = oldest;
    for (let index = 1; index <= 200; index++) newest = await f.search.query(`paging ${'!'.repeat(index)}`, { limit: 1 });
    await expect(f.search.query('paging', { cursor: oldest.nextCursor! })).rejects.toThrow(/cursor/i);
    expect((await f.search.query(`paging ${'!'.repeat(200)}`, { cursor: newest.nextCursor!, limit: 1 })).hits.map((hit) => hit.path))
      .toEqual(['wiki/page-01.md']);
  });

  it('returns a bounded excerpt with UTF-16 highlight offsets and a navigable heading anchor', async () => {
    const f = await fixture([{ path: 'wiki/excerpt.md',
      markdown: '# Excerpts\n\n## 검토 절차\n' + '😀 background text '.repeat(18) + 'needle 권한 ' + 'trailing text '.repeat(40) }]);
    const [hit] = await f.search.search('needle 권한');
    expect(hit?.path).toBe('wiki/excerpt.md');
    expect(hit?.anchor).toBe('검토-절차');
    expect(hit!.excerpt.length).toBeLessThanOrEqual(300);
    expect(hit!.excerpt).toContain('needle 권한');
    expect(hit!.excerpt.startsWith('…')).toBe(true);
    expect(hit!.highlights.map(([start, end]) => hit!.excerpt.slice(start, end))).toEqual(['needle', '권한']);
    for (const [start, end] of hit!.highlights) {
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      expect(end).toBeLessThanOrEqual(hit!.excerpt.length);
    }
    expect(hit!.updatedAt).toMatch(/^2024-06-15T12:00:00/);
  });

  it('falls back to keyword retrieval after a real embedding request fails', async () => {
    const f = await fixture([{ path: 'wiki/storage.md', markdown: '# Storage\nStorage survives restarts.' }], { embeddings: true });
    // The existing fake server returns 404 for unknown routes; it remains reachable.
    f.config.openaiBaseUrl = `${f.fake!.url}/unknown`;
    const result = await f.search.query('storage');
    expect(result).toMatchObject({ mode: 'keyword', degraded: { reason: 'embedding_error' }, hits: [{ path: 'wiki/storage.md' }] });
    expect((await f.search.search('storage')).map((hit) => hit.path)).toEqual(['wiki/storage.md']);
  });

  it.each(['model', 'dimensions'])('retains keyword results when embedding %s no longer matches the indexed vectors', async (setting) => {
    const f = await fixture([{ path: 'wiki/storage.md', markdown: '# Storage\nStorage survives restarts.' }], { embeddings: true });
    if (setting === 'model') f.config.embeddingModel = 'replacement-model';
    else f.config.embeddingDimensions = 16;
    expect(await f.search.query('storage')).toMatchObject({ mode: 'keyword', degraded: { reason: 'vector_mismatch' }, hits: [{ path: 'wiki/storage.md' }] });
  });

  it('reports an index behind main and recovers hybrid mode after synchronization', async () => {
    const f = await fixture([{ path: 'wiki/storage.md', markdown: '# Storage\nStorage survives restarts.' }], { embeddings: true });
    await f.commit([{ path: 'wiki/storage.md', markdown: '# Storage\nStorage now supports recovery.' }]);
    expect(await f.search.query('storage')).toMatchObject({ mode: 'keyword', degraded: { reason: 'index_stale' }, hits: [{ path: 'wiki/storage.md' }] });
    await f.indexer.syncToHead();
    expect(await f.search.query('recovery')).toMatchObject({ mode: 'hybrid', degraded: null, hits: [{ path: 'wiki/storage.md' }] });
  });

  it('reports pending embeddings as stale and fills them after credentials become available', async () => {
    const f = await fixture([{ path: 'wiki/storage.md', markdown: '# Storage\nStorage survives restarts.' }]);
    const fake = await startFakeOpenAI();
    cleanup.push(() => fake.close());
    f.config.openaiApiKey = 'fake-key';
    f.config.openaiBaseUrl = fake.url;
    expect(await f.search.query('storage')).toMatchObject({
      mode: 'keyword', degraded: { reason: 'index_stale' }, hits: [{ path: 'wiki/storage.md' }],
    });
    await f.indexer.syncToHead();
    expect(await f.search.query('storage')).toMatchObject({
      mode: 'hybrid', degraded: null, hits: [{ path: 'wiki/storage.md' }],
    });
  });
});

describe('curated bilingual retrieval evaluation', () => {
  it.each([false, true])('reports Recall@3 and MRR with embeddings=%s', async (embeddings) => {
    const f = await fixture(evaluationNotes, { embeddings });
    const rows = [];
    for (const { query, relevantPaths } of evaluationQueries) {
      const result = await f.search.query(query, { limit: 100 });
      expect(result.mode).toBe(embeddings ? 'hybrid' : 'keyword');
      rows.push({ relevantPaths, retrievedPaths: result.hits.map((hit) => hit.path) });
    }
    const metrics = retrievalMetrics(rows);
    // Deterministic hash embeddings are a transport/rank-fusion fixture, not a semantic model benchmark.
    console.info('retrieval-evaluation', JSON.stringify({ mode: embeddings ? 'hybrid' : 'keyword', ...metrics, queries: rows.length }));
    expect(metrics.recallAt3).toBeGreaterThanOrEqual(0.8);
    expect(metrics.mrr).toBeGreaterThanOrEqual(0.7);
    const durable = await f.search.search('durable storage', { limit: 100 });
    expect(durable.map((hit) => hit.path)).toContain('wiki/english/durable.md');
    expect(durable.map((hit) => hit.path)).not.toContain('raw/repeated-advertisement.md');
  }, 30_000);
});

describe('optional LLM search behavior', () => {
  it('caps aliases at three, keeps original evidence strongest, and caches aliases for ten minutes', async () => {
    const f = await fixture([
      { path: 'wiki/z-original.md', markdown: '# Intent\nThe requested original evidence.' },
      { path: 'wiki/a-alpha.md', markdown: '# Alpha\nTranslated evidence.' },
      { path: 'wiki/b-beta.md', markdown: '# Beta\nTranslated evidence.' },
      { path: 'wiki/c-gamma.md', markdown: '# Gamma\nTranslated evidence.' },
      { path: 'wiki/d-delta.md', markdown: '# Delta\nFourth alias evidence.' },
    ], { embeddings: true, script: ['["alpha","beta","gamma","delta"]', '["delta"]'] });
    // A config mismatch isolates lexical expansion while still using the real Responses endpoint.
    f.config.embeddingModel = 'changed-model';
    f.config.searchExpand = 'llm';
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const hits = await f.search.search('intent');
    const first = hits.map((hit) => hit.path);
    expect(first[0]).toBe('wiki/z-original.md');
    expect(first.slice(1).sort()).toEqual(['wiki/a-alpha.md', 'wiki/b-beta.md', 'wiki/c-gamma.md']);
    clock.mockReturnValue(now + 599_999);
    expect((await f.search.search('intent')).map((hit) => hit.path)).toEqual(first);
    clock.mockReturnValue(now + 600_000);
    expect((await f.search.search('intent')).map((hit) => hit.path)).toEqual(['wiki/z-original.md', 'wiki/d-delta.md']);
  });

  it.each(['not JSON', '{"alias":"alpha"}'])('ignores invalid alias output %s', async (output) => {
    const f = await fixture([
      { path: 'wiki/original.md', markdown: '# Intent\nOriginal evidence.' },
      { path: 'wiki/alias.md', markdown: '# Alpha\nAlias evidence.' },
    ], { embeddings: true, script: [output] });
    f.config.embeddingModel = 'changed-model';
    const baseline = await f.search.search('intent');
    f.config.searchExpand = 'llm';
    expect(await f.search.search('intent')).toEqual(baseline);
  });

  it('reranks a complete top-twelve permutation without disturbing the remaining results', async () => {
    const order = [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
    const f = await fixture(pagingNotes(14), { embeddings: true, script: [JSON.stringify(order)] });
    f.config.embeddingModel = 'changed-model';
    const baseline = await f.search.search('paging', { limit: 100 });
    f.config.searchRerank = 'llm';
    const reranked = await f.search.search('paging', { limit: 100 });
    expect(reranked.map((hit) => hit.path)).toEqual([
      ...order.map((index) => baseline[index]!.path), ...baseline.slice(12).map((hit) => hit.path),
    ]);
    expect(reranked.slice(12)).toEqual(baseline.slice(12));
    expect(reranked.map((hit) => hit.excerpt).sort()).toEqual(baseline.map((hit) => hit.excerpt).sort());
  });

  it.each([
    'not JSON', '{}', '[0,1]', '[0,0,2,3,4,5,6,7,8,9,10,11]', '[0,1,2,3,4,5,6,7,8,9,10,12]',
  ])('retains ranking when reranker output is not a complete valid permutation: %s', async (output) => {
    const f = await fixture(pagingNotes(14), { embeddings: true, script: [output] });
    f.config.embeddingModel = 'changed-model';
    const baseline = await f.search.search('paging', { limit: 100 });
    f.config.searchRerank = 'llm';
    expect(await f.search.search('paging', { limit: 100 })).toEqual(baseline);
  });
});
