import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { openDb } from '../../src/db/index.js';
import type { KnowledgeRepo, FileChange } from '../../src/knowledge/repo.js';
import { Indexer, SearchService } from '../../src/rag/index.js';
import { startFakeOpenAI } from '../fake-openai.js';

const exec = promisify(execFile);
const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

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

async function fixture(key = false) {
  const directory = await mkdtemp(join(tmpdir(), 'llmwiki-rag-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const repo = new GitRepoDouble(directory);
  await repo.git('init', '-b', 'main');
  await repo.git('config', 'user.email', 'test@example.com');
  await repo.git('config', 'user.name', 'Test');
  const db = openDb(':memory:');
  cleanup.push(() => db.close());
  db.exec(await readFile(new URL('../../src/db/migrations/006_rag.sql', import.meta.url), 'utf8'));
  const fake = key ? await startFakeOpenAI() : null;
  if (fake) cleanup.push(() => fake.close());
  const config = loadConfig({ NODE_ENV: 'test', EMBEDDING_DIMENSIONS: '8',
    ...(fake ? { OPENAI_API_KEY: 'fake', OPENAI_BASE_URL: fake.url } : {}) });
  const log = pino({ level: 'silent' });
  const ctx = { config, db, repo: repo as unknown as KnowledgeRepo, log };
  const indexer = new Indexer(ctx);
  const search = new SearchService(ctx);
  return { ...ctx, repo, fake, indexer, search };
}

describe('main-derived index', () => {
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
