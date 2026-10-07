import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pino from 'pino';
import { afterEach, expect, it, vi } from 'vitest';
import { UsersRepository } from '../auth/users.repository.js';
import { UsersService } from '../auth/users.service.js';
import { loadConfig } from '../config.js';
import { openDb } from '../db/index.js';
import { EventsService } from '../events/events.service.js';
import type { WikiEvent } from '../events/events.types.js';
import { KnowledgeRepo, type Worktree } from '../knowledge/repo.js';
import type { LunaService } from '../luna/luna.service.js';
import { resolveConflicts } from '../luna/writes.js';
import type { AgentTool } from '../luna/luna.types.js';
import type { IndexerService } from '../rag/indexer.service.js';
import { NoteWriterService } from './note-writer.service.js';
import { WriteJobsRepository } from './write-jobs.repository.js';
import { WriteJobsService } from './write-jobs.service.js';

const git = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'wiki-direct-'));
  const db = openDb(':memory:');
  for (const migration of ['001_core', '003_jobs', '007_history']) db.exec(await readFile(new URL(`../db/migrations/${migration}.sql`, import.meta.url), 'utf8'));
  db.prepare("INSERT INTO users(id,email,name,role,created_at) VALUES (1,'editor@example.com','Editor','editor','2026-01-01')").run();
  const log = pino({ level: 'silent' });
  const repo = await KnowledgeRepo.open(loadConfig({ NODE_ENV: 'test', DATA_DIR: dir }), log);
  const repository = new WriteJobsRepository(db);
  const users = new UsersService(new UsersRepository(db));
  const events = new EventsService();
  const published: WikiEvent[] = [];
  events.subscribe((event) => published.push(event));
  const indexer = { syncToHead: vi.fn(async () => {}) } as unknown as IndexerService;
  const luna = { runWrite: vi.fn(async () => ({ summary: 'No changes' })), resolveConflicts: vi.fn(async () => {}) } as unknown as LunaService;
  const writer = new NoteWriterService(repository, repo, users, indexer, events, log);
  const jobs = new WriteJobsService(repository, luna, indexer, repo, users, log, events, writer);
  cleanups.push(async () => { await jobs.stop(); db.close(); await rm(dir, { recursive: true, force: true }); });
  async function put(path: string, content: string, create = true, baseSha?: string) {
    return writer.apply({ userId: 1, source: 'web', baseSha: baseSha ?? await repo.headSha(), ops: [{ op: 'put', path, content, create }] });
  }
  return { dir, db, repo, repository, events, published, indexer, luna, jobs, writer, put };
}

it('checks touched paths only, preserves unrelated updates, and rejects stale edits and both move endpoints', async () => {
  const f = await fixture();
  await f.put('wiki/a.md', 'a');
  const base = await f.repo.headSha();
  await f.put('wiki/unrelated.md', 'unrelated');
  await f.put('wiki/a.md', 'a2', false, base);
  expect(await f.repo.readFile('wiki/unrelated.md')).toBe('unrelated');
  await expect(f.put('wiki/a.md', 'lost', false, base)).rejects.toMatchObject({ status: 409, code: 'stale_note', message: expect.stringContaining(await f.repo.headSha()) });
  const move = (from: string, to: string, baseSha: string) => f.writer.apply({ userId: 1, source: 'web', baseSha, ops: [{ op: 'move', from, to }] });
  await expect(move('wiki/a.md', 'wiki/new.md', base)).rejects.toMatchObject({ code: 'stale_note' });
  const beforeDestination = await f.repo.headSha();
  await f.put('wiki/destination.md', 'occupied');
  await expect(move('wiki/a.md', 'wiki/destination.md', beforeDestination)).rejects.toMatchObject({ code: 'stale_note' });
  const result = await move('wiki/a.md', 'wiki/moved.md', await f.repo.headSha());
  expect(result.changed.sort()).toEqual(['wiki/a.md', 'wiki/moved.md']);
  expect(await f.repo.readFile('wiki/a.md')).toBeNull();
  expect(await f.repo.readFile('wiki/moved.md')).toBe('a2');
});

it('rejects existing, missing, unsafe and invalid notes atomically and deletes existing notes', async () => {
  const f = await fixture();
  await f.put('wiki/a.md', 'a');
  await expect(f.put('wiki/a.md', 'replace')).rejects.toMatchObject({ status: 409, code: 'note_exists' });
  await f.put('wiki/missing.md', 'x', false);
  expect(await f.repo.readFile('wiki/missing.md')).toBe('x');
  await expect(f.put('../escape.md', 'x')).rejects.toMatchObject({ code: 'invalid_note' });
  await expect(f.put('config.json', '{}')).rejects.toMatchObject({ code: 'invalid_note' });
  const before = await f.repo.headSha();
  await expect(f.writer.apply({ userId: 1, source: 'web', baseSha: before, ops: [{ op: 'put', path: 'wiki/new.md', create: true, content: 'unpublished' }, { op: 'delete', path: 'wiki/absent.md' }] })).rejects.toMatchObject({ code: 'note_missing' });
  expect(await f.repo.headSha()).toBe(before);
  expect(await f.repo.readFile('wiki/new.md')).toBeNull();
  await f.writer.apply({ userId: 1, source: 'web', baseSha: before, ops: [{ op: 'delete', path: 'wiki/a.md' }] });
  expect(await f.repo.readFile('wiki/a.md')).toBeNull();
});

it('stores exact binary bytes, restricts raw imports to immutable creations, and adds commit trailers', async () => {
  const f = await fixture();
  const binary = Buffer.from([0, 255, 1, 127, 10]);
  const result = await f.writer.apply({ userId: 1, source: 'web', client: 'browser', baseSha: await f.repo.headSha(), ops: [{ op: 'put', path: 'assets/image.bin', create: true, contentBase64: binary.toString('base64') }] });
  expect(await readFile(join(f.dir, 'knowledge/assets/image.bin'))).toEqual(binary);
  const commit = (await f.repo.show(result.mergeSha)).commit;
  expect(commit.trailers).toMatchObject({ 'Wiki-Job': result.jobId, 'Wiki-Source': 'web', 'Wiki-Requester': 'editor@example.com', 'Wiki-Client': 'browser' });
  const raw = { op: 'put' as const, path: 'raw/original.pdf', create: true, contentBase64: binary.toString('base64') };
  await expect(f.writer.apply({ userId: 1, source: 'web', baseSha: await f.repo.headSha(), ops: [raw] })).rejects.toMatchObject({ code: 'invalid_note' });
  await f.writer.apply({ userId: 1, source: 'import', baseSha: await f.repo.headSha(), ops: [raw] });
  await expect(f.writer.apply({ userId: 1, source: 'import', baseSha: await f.repo.headSha(), ops: [raw] })).rejects.toMatchObject({ status: 409, code: 'note_exists' });
  await expect(f.writer.apply({ userId: 1, source: 'import', baseSha: await f.repo.headSha(), ops: [{ op: 'delete', path: raw.path }] })).rejects.toMatchObject({ code: 'note_exists' });
});

it('previews and applies an inverse without changing main during preview', async () => {
  const f = await fixture();
  const created = await f.put('wiki/a.md', 'original');
  const changed = await f.put('wiki/a.md', 'edited', false);
  const before = await f.repo.headSha();
  const count = f.jobs.list().length;
  const preview = await f.writer.applyRevert({ userId: 1, sha: changed.mergeSha, preview: true });
  expect(preview.patch).toContain('+original');
  expect(await f.repo.headSha()).toBe(before);
  expect(f.jobs.list().length).toBe(count);
  const result = await f.writer.applyRevert({ userId: 1, sha: changed.mergeSha });
  expect(await f.repo.readFile('wiki/a.md')).toBe('original');
  expect(f.jobs.get(result.jobId)).toMatchObject({ kind: 'revert', source: 'revert', status: 'succeeded' });
  expect(result.mergeSha).not.toBe(created.mergeSha);
});

it('holds direct freshness through indexing while Luna uses the same merge lock', async () => {
  const f = await fixture();
  await f.put('wiki/shared.md', 'base');
  const { promise: editing, resolve: editingStarted } = Promise.withResolvers<void>();
  const { promise: finishEdit, resolve: releaseEdit } = Promise.withResolvers<void>();
  vi.mocked(f.luna.runWrite).mockImplementation(async (_job, wt: Worktree, author) => {
    await wt.write('wiki/luna.md', 'luna');
    await wt.commit('Luna edits', author);
    editingStarted();
    await finishEdit;
    return { summary: 'Luna edits' };
  });
  f.jobs.start();
  const lunaJob = f.jobs.submit({ userId: 1, input: 'save', source: 'chat' });
  await editing;
  const { promise: indexing, resolve: indexingStarted } = Promise.withResolvers<void>();
  const { promise: finishIndex, resolve: releaseIndex } = Promise.withResolvers<void>();
  vi.mocked(f.indexer.syncToHead).mockImplementationOnce(async () => { indexingStarted(); await finishIndex; return { indexedSha: await f.repo.headSha(), changedFiles: 1 }; });
  const base = await f.repo.headSha();
  const direct = f.put('wiki/shared.md', 'direct', false, base);
  await indexing;
  releaseEdit();
  const late = f.put('wiki/shared.md', 'late', false, base);
  releaseIndex();
  await direct;
  await expect(late).rejects.toMatchObject({ code: 'stale_note' });
  await vi.waitFor(() => expect(f.jobs.get(lunaJob.id)?.status).toBe('succeeded'));
  await f.jobs.stop();
  expect(await f.repo.readFile('wiki/shared.md')).toBe('direct');
  expect(await f.repo.readFile('wiki/luna.md')).toBe('luna');
});

it('retries failed Luna with provenance, cancels only queued jobs and keeps failed commits inspectable', async () => {
  const f = await fixture();
  vi.mocked(f.luna.runWrite).mockImplementationOnce(async (_job, wt, author) => {
    await wt.write('wiki/failed.md', 'inspect me');
    await wt.commit('Attempt', author);
    throw new Error('provider down');
  });
  const canceled = f.jobs.submit({ userId: 1, input: 'cancel', source: 'mcp' });
  expect(f.jobs.cancel(canceled.id)).toMatchObject({ status: 'failed', error: 'canceled' });
  f.jobs.start();
  const original = f.jobs.submit({ userId: 1, input: 'retry me', source: 'chat', client: 'browser' });
  await vi.waitFor(() => expect(f.jobs.get(original.id)?.status).toBe('failed'));
  await f.jobs.stop();
  const failed = f.jobs.get(original.id)!;
  expect(await f.repo.readFile('wiki/failed.md', failed.commits[0]!)).toBe('inspect me');
  const refs = await git('git', ['for-each-ref', '--format=%(refname)', 'refs/wiki/failed'], { cwd: join(f.dir, 'knowledge') });
  expect(refs.stdout).toContain(original.id);
  const retried = f.jobs.retry(original.id);
  expect(retried).toMatchObject({ input: original.input, source: 'chat', client: 'browser', status: 'queued' });
  expect(f.jobs.events(retried.id)[0]?.detail).toEqual({ retryOf: original.id });
  expect(f.jobs.events(original.id).map((event) => event.phase)).toEqual(['queued', 'preparing', 'editing', 'cleanup', 'failed']);
  expect(f.published).toContainEqual(expect.objectContaining({ type: 'job.updated', jobId: original.id, phase: 'failed', status: 'failed' }));
  f.jobs.start();
  await vi.waitFor(() => expect(f.jobs.get(retried.id)?.status).toBe('succeeded'));
  await expect(Promise.resolve().then(() => f.jobs.cancel(retried.id))).rejects.toMatchObject({ code: 'job_not_cancelable' });
});

it('replays direct and revert failures immediately outside the Luna queue with original payload and metadata', async () => {
  const f = await fixture();
  const createWorktree = f.repo.createWorktree.bind(f.repo);
  vi.spyOn(f.repo, 'createWorktree').mockImplementationOnce(async (id) => {
    const wt = await createWorktree(id);
    vi.spyOn(wt, 'fastForwardMain').mockRejectedValueOnce(new Error('temporary merge failure'));
    return wt;
  });
  await expect(f.put('wiki/retry.md', 'retained request')).rejects.toThrow('temporary merge failure');
  const original = f.jobs.list()[0]!;
  const queuedLuna = f.jobs.submit({ userId: 1, input: 'stay queued', source: 'chat' });
  const retried = f.jobs.retry(original.id);
  expect(retried.input).toBe(original.input);
  expect(f.jobs.events(retried.id)[0]?.detail).toEqual({ retryOf: original.id });
  await vi.waitFor(() => expect(f.jobs.get(retried.id)?.status).toBe('succeeded'));
  expect(f.jobs.get(queuedLuna.id)?.status).toBe('queued');
  expect(await f.repo.readFile('wiki/retry.md')).toBe('retained request');
  const applied = f.jobs.get(retried.id)!;
  vi.mocked(f.repo.createWorktree).mockImplementationOnce(async (id) => {
    const wt = await createWorktree(id);
    vi.spyOn(wt, 'fastForwardMain').mockRejectedValueOnce(new Error('temporary revert failure'));
    return wt;
  });
  await expect(f.writer.applyRevert({ userId: 1, sha: applied.mergeSha!, client: 'browser' })).rejects.toThrow('temporary revert failure');
  const failedRevert = f.jobs.list().find((job) => job.kind === 'revert')!;
  const retryRevert = f.jobs.retry(failedRevert.id);
  await vi.waitFor(() => expect(f.jobs.get(retryRevert.id)?.status).toBe('succeeded'));
  expect(f.jobs.get(retryRevert.id)).toMatchObject({ kind: 'revert', source: 'revert', client: 'browser' });
  expect(await f.repo.readFile('wiki/retry.md')).toBeNull();
  expect(f.jobs.get(failedRevert.id)?.status).toBe('failed');
});

it('preserves legacy rows during history migration and accepts legacy timestamp cursors', async () => {
  const db = openDb(':memory:');
  try {
    for (const name of ['001_core', '003_jobs']) db.exec(await readFile(new URL(`../db/migrations/${name}.sql`, import.meta.url), 'utf8'));
    db.prepare("INSERT INTO write_jobs(id,user_id,source,input,status,summary,commits,error,created_at,finished_at) VALUES ('legacy',99,'mcp','original input','failed','original summary','[\"abc\"]','original error','2026-01-01T00:00:00.000Z','2026-01-02T00:00:00.000Z')").run();
    db.exec(await readFile(new URL('../db/migrations/007_history.sql', import.meta.url), 'utf8'));
    const repository = new WriteJobsRepository(db);
    expect(repository.get('legacy')).toMatchObject({ userId: 99, kind: 'luna', source: 'mcp', client: null, input: 'original input', status: 'failed', summary: 'original summary', commits: ['abc'], conflicts: [], error: 'original error' });
    repository.enqueue('new', 99, 'new input', '2026-02-01T00:00:00.000Z', 'web');
    expect(repository.list({ before: '2026-02-01T00:00:00.000Z' }).map((job) => job.id)).toEqual(['legacy']);
  } finally { db.close(); }
});

it('records both conflict attempts and their verified outcomes through the worktree callback', async () => {
  const f = await fixture();
  await f.put('wiki/conflict.md', 'base\n');
  const job = f.jobs.submit({ userId: 1, input: 'resolve', source: 'chat' });
  const wt = await f.repo.createWorktree(job.id);
  try {
    await wt.write('wiki/conflict.md', 'branch\n');
    await wt.commit('Branch intent', { name: 'Editor', email: 'editor@example.com' });
    await f.put('wiki/conflict.md', 'main\n', false);
    const merged = await wt.mergeMain();
    expect(merged).toMatchObject({ ok: false, conflicts: ['wiki/conflict.md'] });
    wt.onPhase = (phase, detail) => f.jobs.phase(job.id, phase, detail);
    let attempt = 0;
    const luna = {
      baseInstructions: async () => '',
      worktreeTools: () => [{
        name: 'write_file', description: 'Resolve', parameters: { type: 'object' },
        run: async () => { await wt.write('wiki/conflict.md', 'branch\nmain\n'); return 'written'; },
      }],
      runAgent: async ({ tools }: { tools: AgentTool[] }) => {
        attempt++;
        if (attempt === 2) await tools[0]!.run({ path: 'wiki/conflict.md', content: 'branch\nmain\n' });
        return { text: '' };
      },
    } as unknown as LunaService;
    await resolveConflicts(luna, f.repo, wt, ['wiki/conflict.md']);
    expect(await wt.read('wiki/conflict.md')).toBe('branch\nmain\n');
    expect(f.jobs.events(job.id).filter((event) => event.phase === 'resolving_conflict').map((event) => event.detail)).toEqual([
      { attempt: 1, result: 'started', files: ['wiki/conflict.md'] },
      { attempt: 1, result: 'unresolved', files: ['wiki/conflict.md'] },
      { attempt: 2, result: 'started', files: ['wiki/conflict.md'] },
      { attempt: 2, result: 'resolved', files: [] },
    ]);
  } finally { await wt.dispose(); }
});

it('preserves multi-megabyte import binaries without regex stack growth and rejects malformed padding', async () => {
  const f = await fixture();
  const content = Buffer.alloc(4 * 1024 * 1024, 255);
  const result = await f.writer.apply({ userId: 1, source: 'import', baseSha: await f.repo.headSha(), ops: [{ op: 'put', path: 'raw/large-original.bin', create: true, contentBase64: content.toString('base64') }] });
  const stored = await readFile(join(f.dir, 'knowledge/raw/large-original.bin'));
  expect(createHash('sha256').update(stored).digest('hex')).toBe(createHash('sha256').update(content).digest('hex'));
  expect(result.changed).toEqual(['raw/large-original.bin']);
  for (const malformed of ['A', 'A===', 'AB=C', 'AAAA====', 'AA?=']) {
    await expect(f.writer.apply({ userId: 1, source: 'web', baseSha: await f.repo.headSha(), ops: [{ op: 'put', path: 'assets/invalid.bin', create: true, contentBase64: malformed }] })).rejects.toMatchObject({ status: 400, code: 'invalid_note' });
  }
});
