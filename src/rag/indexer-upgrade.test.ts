import 'reflect-metadata';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { openDb } from '../db/index.js';
import { EventsService } from '../events/events.service.js';
import { KnowledgeRepo } from '../knowledge/repo.js';
import { embedTexts } from './embeddings.js';
import { IndexerService } from './indexer.service.js';

vi.mock('./embeddings.js', () => ({ embedTexts: vi.fn() }));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.resetAllMocks();
  vi.useRealTimers();
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'rag-upgrade-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const config = { ...loadConfig({ NODE_ENV: 'test', DATA_DIR: dir, EMBEDDING_DIMENSIONS: '2' }), indexPollSeconds: 0.02 };
  const db = openDb(':memory:');
  db.exec(readFileSync(new URL('../db/migrations/006_rag.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../db/migrations/009_rag.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../db/migrations/014_link_targets.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../db/migrations/026_note_metadata.sql', import.meta.url), 'utf8'));
  const log = pino({ level: 'silent' });
  const repo = await KnowledgeRepo.open(config, log);
  const events = new EventsService();
  const indexer = new IndexerService(config, db, log, repo, events);
  cleanup.push(async () => { await indexer.onModuleDestroy(); db.close(); });
  let sequence = 0;
  const save = async (body: string, author = { name: 'Index Author', email: 'index@example.test' }) => {
    const worktree = await repo.createWorktree(`edit-${++sequence}`);
    try {
      await worktree.write('wiki/note.md', body);
      const sha = await worktree.commit('Save indexed note', author);
      await worktree.fastForwardMain();
      return sha!;
    } finally { await worktree.dispose(); }
  };
  return { config, db, repo, indexer, events, save };
}

it('pins last-touch metadata to the indexed snapshot when HEAD advances during preparation', async () => {
  const { db, repo, indexer, save } = await fixture();
  await indexer.syncToHead();
  const indexed = await save('## Heading\nSnapshotword');
  const [touch] = await repo.log({ path: 'wiki/note.md', limit: 1, ref: indexed });
  const read = repo.readFiles.bind(repo);
  const lastModified = vi.spyOn(repo, 'lastModified');
  const readFiles = vi.spyOn(repo, 'readFiles').mockImplementationOnce(async (paths, ref) => {
    const markdown = await read(paths, ref);
    await save('## Heading\nFutureword', { name: 'Future Author', email: 'future@example.test' });
    return markdown;
  });
  await indexer.syncToHead();
  expect(readFiles).toHaveBeenCalledWith(['wiki/note.md'], indexed);
  expect(lastModified).toHaveBeenCalledWith(['wiki/note.md'], indexed);
  expect(await indexer.status()).toMatchObject({ indexedSha: indexed, headSha: await repo.headSha(), syncing: false });
  expect((await indexer.status()).headSha).not.toBe(indexed);
  expect(db.prepare("SELECT author,updated_at,content FROM chunks WHERE path='wiki/note.md'").get()).toEqual({
    author: 'Index Author <index@example.test>', updated_at: touch!.committedAt, content: '## Heading\nSnapshotword',
  });
});

it('advances lexical content, links and metadata when embedding fails and retries pending vectors', async () => {
  const { config, db, indexer, save } = await fixture();
  const first = await save('---\ntags: ["#SEARCH", Search]\n---\n## Heading\nOldword [[Missing]]');
  await indexer.syncToHead();
  expect(await indexer.status()).toMatchObject({ indexedSha: first, pendingVectors: expect.any(Number), embedding: { configured: false, ready: false } });
  config.openaiApiKey = 'test-key';
  vi.mocked(embedTexts).mockRejectedValueOnce(new Error('Provider unavailable'));
  const second = await save('---\ntags: ["#SEARCH"]\n---\n## Heading\nNewword [[Other]]');
  await indexer.syncToHead();
  expect(await indexer.status()).toMatchObject({ indexedSha: second, headSha: second, syncing: false,
    lastError: 'embedding_error: Provider unavailable', embedding: { configured: true, ready: false } });
  expect(db.prepare("SELECT path FROM chunks_terms JOIN chunks ON chunks.id = chunks_terms.rowid WHERE chunks_terms MATCH 'newword'").all()).toEqual([{ path: 'wiki/note.md' }]);
  expect(db.prepare("SELECT path FROM chunks_terms JOIN chunks ON chunks.id = chunks_terms.rowid WHERE chunks_terms MATCH 'oldword'").all()).toEqual([]);
  expect(db.prepare("SELECT tags_json,anchor,author,vector_pending FROM chunks WHERE path='wiki/note.md'").get()).toEqual({ tags_json: '["search"]', anchor: 'heading', author: 'Index Author <index@example.test>', vector_pending: 1 });
  expect(db.prepare("SELECT target_name FROM links WHERE source_path='wiki/note.md'").all()).toEqual([{ target_name: 'other' }]);
  vi.mocked(embedTexts).mockImplementation(async (cfg, texts) => texts.map(() => Array.from({ length: cfg.embeddingDimensions }, (_, i) => i === 0 ? 1 : 0)));
  await indexer.syncToHead();
  expect(await indexer.status()).toMatchObject({ indexedSha: second, lastError: null, pendingVectors: 0, embedding: { ready: true } });
});

it('keeps model mismatch degraded until a successful explicit full rebuild', async () => {
  const { config, indexer, save } = await fixture();
  config.openaiApiKey = 'test-key';
  vi.mocked(embedTexts).mockImplementation(async (cfg, texts) => texts.map(() => Array.from({ length: cfg.embeddingDimensions }, (_, i) => i === 0 ? 1 : 0)));
  await save('## Heading\nIndexed content');
  await indexer.syncToHead();
  config.embeddingDimensions = 3;
  await indexer.syncToHead();
  expect(await indexer.status()).toMatchObject({ lastError: 'vector_mismatch', embedding: { dimensions: 3, ready: false } });
  vi.mocked(embedTexts).mockRejectedValueOnce(new Error('Unavailable during rebuild'));
  config.embeddingModel = 'changed-model';
  await indexer.reindex({ full: true });
  expect(await indexer.status()).toMatchObject({ lastError: 'vector_mismatch', embedding: { ready: false } });
  vi.mocked(embedTexts).mockImplementation(async (cfg, texts) => texts.map(() => Array.from({ length: cfg.embeddingDimensions }, (_, i) => i === 0 ? 1 : 0)));
  await indexer.reindex({ full: true });
  expect(await indexer.status()).toMatchObject({ lastError: null, pendingVectors: 0, embedding: { dimensions: 3, ready: true } });
});

it('polls external HEAD changes without a writer-triggered sync and stops on destroy', async () => {
  const { indexer, events, save } = await fixture();
  await save('## Heading\nBefore external edit');
  await indexer.syncToHead();
  const received: Array<{ sha: string | null; status: string }> = [];
  const unsubscribe = events.subscribe((event) => {
    if (event.type === 'index.updated') received.push(event);
  });
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  indexer.onModuleInit();
  const changed = await save('## Heading\nAfter external edit');
  vi.advanceTimersByTime(20);
  await vi.waitFor(async () => {
    expect(await indexer.status()).toMatchObject({ indexedSha: changed, headSha: changed, syncing: false });
  }, { timeout: 5000, interval: 30 });
  expect(received).toContainEqual(expect.objectContaining({ sha: changed, status: 'ready' }));
  await indexer.onModuleDestroy();
  const stopped = await save('## Heading\nAfter polling stopped');
  vi.advanceTimersByTime(80);
  expect(await indexer.status()).toMatchObject({ indexedSha: changed, headSha: stopped, syncing: false });
  unsubscribe();
});
