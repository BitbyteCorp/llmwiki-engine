import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsersRepository } from '../auth/users.repository.js';
import { UsersService } from '../auth/users.service.js';
import { loadConfig } from '../config.js';
import { openDb, type Db } from '../db/index.js';
import { KnowledgeRepo, type Worktree } from '../knowledge/repo.js';
import type { LunaService } from '../luna/luna.service.js';
import type { IndexerService } from '../rag/indexer.service.js';
import type { WriteJob } from './write-job.types.js';
import { WriteJobsRepository } from './write-jobs.repository.js';
import { WriteJobsService } from './write-jobs.service.js';

const git = promisify(execFile);
const author = { name: 'Requesting User', email: 'user@example.com' };
const fixtures: Array<{ dir: string; db: Db; jobs: WriteJobsService }> = [];

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'llmwiki-jobs-'));
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: dir });
  const log = pino({ level: 'silent' });
  const db = openDb(':memory:');
  db.exec(await readFile(new URL('../db/migrations/001_core.sql', import.meta.url), 'utf8'));
  db.exec(await readFile(new URL('../db/migrations/003_jobs.sql', import.meta.url), 'utf8'));
  db.prepare('INSERT INTO users(id,email,name,role,created_at) VALUES (1,?,?,?,?)')
    .run(author.email, author.name, 'editor', new Date().toISOString());
  const repo = await KnowledgeRepo.open(config, log);
  const luna = {
    runWrite: vi.fn(async (_job: WriteJob, wt: Worktree) => {
      await wt.write('wiki/result.md', 'saved knowledge\n');
      return { summary: 'Save useful knowledge\nDetails of the update.' };
    }),
    resolveConflicts: vi.fn(async () => {}),
  } as unknown as LunaService;
  const indexer = {
    syncToHead: vi.fn(async () => ({ indexedSha: await repo.headSha(), changedFiles: 1 })),
  } as unknown as IndexerService;
  const users = new UsersService(new UsersRepository(db));
  const jobs = new WriteJobsService(new WriteJobsRepository(db), luna, indexer, repo, users, log);
  const ctx = { config, db, log, repo, luna, indexer, users, jobs };
  fixtures.push({ dir, db, jobs });
  return { dir, ctx, jobs };
}

async function completed(jobs: WriteJobsService, id: string): Promise<WriteJob> {
  await vi.waitFor(() => {
    expect(['succeeded', 'failed']).toContain(jobs.get(id)?.status);
  }, { timeout: 10000, interval: 10 });
  return jobs.get(id)!;
}

async function advance(repo: KnowledgeRepo, name: string, content: string) {
  const wt = await repo.createWorktree(name);
  await wt.write('wiki/shared.md', content);
  await wt.commit(`Change shared note ${name}`, author);
  await repo.withMergeLock(async () => {
    const merge = await wt.mergeMain();
    expect(merge.ok).toBe(true);
    await wt.fastForwardMain();
  });
  await wt.dispose();
}

afterEach(async () => {
  for (const { dir, db, jobs } of fixtures.splice(0)) {
    await jobs.stop();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

describe('WriteJobsService with real git and a Luna double', () => {
  it('persists lifecycle, commits leftovers as requester, merges and indexes main', async () => {
    const { dir, ctx, jobs } = await fixture();
    const observed: string[] = [];
    vi.mocked(ctx.luna.runWrite).mockImplementation(async (job, wt, user) => {
      observed.push(jobs.get(job.id)!.status);
      expect(user).toEqual(author);
      await wt.write('wiki/first.md', 'first meaning\n');
      await wt.commit('First semantic change', user);
      await wt.write('wiki/result.md', 'saved knowledge\n');
      return { summary: 'Save useful knowledge\nDetails of the update.' };
    });
    vi.mocked(ctx.indexer.syncToHead).mockImplementation(async () => {
      observed.push(jobs.list()[0]!.status);
      expect(await ctx.repo.readFile('wiki/result.md')).toBe('saved knowledge\n');
      return { indexedSha: await ctx.repo.headSha(), changedFiles: 2 };
    });
    jobs.start();
    const queued = jobs.submit({ userId: 1, input: 'Remember this' });
    expect(queued.status).toBe('queued');
    const result = await completed(jobs, queued.id);
    await jobs.stop();
    expect(result.status).toBe('succeeded');
    expect(observed).toEqual(['running', 'merging']);
    expect(result.summary).toBe('Save useful knowledge\nDetails of the update.');
    expect(result.commits).toHaveLength(2);
    expect(result.mergeSha).toBe(await ctx.repo.headSha());
    expect(result.startedAt).not.toBeNull();
    expect(result.finishedAt).not.toBeNull();
    expect(result.error).toBeNull();
    for (const sha of result.commits) {
      const { stdout } = await git('git', ['show', '-s', '--format=%an%n%ae%n%cn%n%ce', sha], { cwd: join(dir, 'knowledge') });
      expect(stdout.trim().split('\n')).toEqual([author.name, author.email, 'Luna', 'luna@llmwiki.local']);
    }
    expect((await ctx.repo.show(result.commits[1]!)).commit.subject).toBe('Save useful knowledge');
    expect(await readdir(join(dir, 'worktrees'))).toEqual([]);
  });

  it('resolves a concurrent main conflict, with requester author on the merge commit', async () => {
    const { ctx, jobs } = await fixture();
    await advance(ctx.repo, 'baseline', 'original\n');
    vi.mocked(ctx.luna.runWrite).mockImplementation(async (_job, wt) => {
      await wt.write('wiki/shared.md', 'requested update\n');
      await advance(ctx.repo, 'concurrent', 'concurrent update\n');
      return { summary: 'Update shared note' };
    });
    vi.mocked(ctx.luna.resolveConflicts).mockImplementation(async (wt, files) => {
      expect(files).toEqual(['wiki/shared.md']);
      expect(await wt.read(files[0]!)).toContain('<<<<<<<');
      await wt.write(files[0]!, 'requested update\nconcurrent update\n');
    });
    jobs.start();
    const result = await completed(jobs, jobs.submit({ userId: 1, input: 'merge' }).id);
    expect(result.status).toBe('succeeded');
    expect(await ctx.repo.readFile('wiki/shared.md')).toBe('requested update\nconcurrent update\n');
    const merge = await ctx.repo.show(result.mergeSha!);
    expect(merge.commit.parents).toHaveLength(2);
    expect(merge.commit.authorEmail).toBe(author.email);
    expect(result.commits).toContain(result.mergeSha);
  });

  it('rejects unresolved conflict markers without advancing main', async () => {
    const { ctx, jobs } = await fixture();
    await advance(ctx.repo, 'baseline', 'original\n');
    let beforeMerge = '';
    vi.mocked(ctx.luna.runWrite).mockImplementation(async (_job, wt) => {
      await wt.write('wiki/shared.md', 'requested update\n');
      await advance(ctx.repo, 'concurrent', 'concurrent update\n');
      beforeMerge = await ctx.repo.headSha();
      return { summary: 'Conflict unresolved' };
    });
    jobs.start();
    const result = await completed(jobs, jobs.submit({ userId: 1, input: 'conflict' }).id);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Unresolved conflict markers');
    expect(result.mergeSha).toBeNull();
    expect(await ctx.repo.headSha()).toBe(beforeMerge);
    expect(ctx.indexer.syncToHead).not.toHaveBeenCalled();
  });

  it('preserves main and records Luna commits when the agent fails', async () => {
    const { dir, ctx, jobs } = await fixture();
    const before = await ctx.repo.headSha();
    vi.mocked(ctx.luna.runWrite).mockImplementation(async (_job, wt, user) => {
      await wt.write('wiki/incomplete.md', 'not published\n');
      await wt.commit('Unpublished attempt', user);
      throw new Error('Luna request failed');
    });
    jobs.start();
    const result = await completed(jobs, jobs.submit({ userId: 1, input: 'fail' }).id);
    await jobs.stop();
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Luna request failed');
    expect(result.commits).toHaveLength(1);
    expect(result.finishedAt).not.toBeNull();
    expect(await ctx.repo.headSha()).toBe(before);
    expect(await ctx.repo.readFile('wiki/incomplete.md')).toBeNull();
    expect(await readdir(join(dir, 'worktrees'))).toEqual([]);
  });

  it('reports success after main merges even when indexing fails', async () => {
    const { ctx, jobs } = await fixture();
    vi.mocked(ctx.indexer.syncToHead).mockRejectedValue(new Error('Embedding service unavailable'));
    jobs.start();
    const result = await completed(jobs, jobs.submit({ userId: 1, input: 'save' }).id);
    expect(result.status).toBe('succeeded');
    expect(result.error).toBeNull();
    expect(await ctx.repo.readFile('wiki/result.md')).toBe('saved knowledge\n');
  });

  it('allows a no-change job without creating an empty user commit', async () => {
    const { ctx, jobs } = await fixture();
    const before = await ctx.repo.headSha();
    ctx.db.prepare('UPDATE users SET name = NULL WHERE id = 1').run();
    vi.mocked(ctx.luna.runWrite).mockImplementation(async (_job, _wt, user) => {
      expect(user).toEqual({ name: author.email, email: author.email });
      return { summary: 'Nothing new to save' };
    });
    jobs.start();
    const result = await completed(jobs, jobs.submit({ userId: 1, input: 'already known' }).id);
    expect(result.status).toBe('succeeded');
    expect(result.commits).toEqual([]);
    expect(result.mergeSha).toBe(before);
    expect(await ctx.repo.headSha()).toBe(before);
  });

  it('fails interrupted running/merging jobs on boot and resumes only queued jobs', async () => {
    const { ctx, jobs } = await fixture();
    const running = jobs.submit({ userId: 1, input: 'interrupted running' });
    const merging = jobs.submit({ userId: 1, input: 'interrupted merging' });
    const queued = jobs.submit({ userId: 1, input: 'resume queued' });
    ctx.db.prepare('UPDATE write_jobs SET status = ?, started_at = ? WHERE id = ?')
      .run('running', running.createdAt, running.id);
    ctx.db.prepare('UPDATE write_jobs SET status = ?, started_at = ? WHERE id = ?')
      .run('merging', merging.createdAt, merging.id);
    jobs.start();
    expect(jobs.get(running.id)?.status).toBe('failed');
    expect(jobs.get(merging.id)?.status).toBe('failed');
    expect(jobs.get(running.id)?.error).toContain('Engine restarted');
    expect(jobs.get(merging.id)?.finishedAt).not.toBeNull();
    expect((await completed(jobs, queued.id)).status).toBe('succeeded');
    expect(ctx.luna.runWrite).toHaveBeenCalledTimes(1);
  });

  it('runs one Luna job at a time and stops before consuming the next queued job', async () => {
    const { ctx, jobs } = await fixture();
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    vi.mocked(ctx.luna.runWrite).mockImplementationOnce(async (_job, wt) => {
      await gate;
      await wt.write('wiki/first.md', 'first\n');
      return { summary: 'First write' };
    });
    const first = jobs.submit({ userId: 1, input: 'first' });
    const second = jobs.submit({ userId: 1, input: 'second' });
    jobs.start();
    await vi.waitFor(() => expect(ctx.luna.runWrite).toHaveBeenCalledTimes(1));
    expect(jobs.get(second.id)?.status).toBe('queued');
    const stopping = jobs.stop();
    release();
    await stopping;
    expect(jobs.get(first.id)?.status).toBe('succeeded');
    expect(jobs.get(second.id)?.status).toBe('queued');
    jobs.start();
    expect((await completed(jobs, second.id)).status).toBe('succeeded');
  });

  it('paginates deterministically across identical timestamps and preserves deleted-user history', async () => {
    const { ctx, jobs } = await fixture();
    const records = Array.from({ length: 4 }, (_, index) => jobs.submit({ userId: index === 3 ? 2 : 1, input: String(index) }));
    ctx.db.prepare('UPDATE write_jobs SET created_at = ?').run('2026-10-07T00:00:00.000Z');
    const first = jobs.list({ userId: 1, limit: 2 });
    const second = jobs.list({ userId: 1, before: first[1]!.id, limit: 2 });
    expect([...first, ...second].map((job) => job.id)).toEqual(records.slice(0, 3).map((job) => job.id).sort().reverse());
    ctx.db.prepare('DELETE FROM users WHERE id = 1').run();
    expect(jobs.get(records[0]!.id)?.userId).toBe(1);
    jobs.start();
    const result = await completed(jobs, records[0]!.id);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('no longer exists');
    expect(ctx.luna.runWrite).not.toHaveBeenCalled();
  });
});
