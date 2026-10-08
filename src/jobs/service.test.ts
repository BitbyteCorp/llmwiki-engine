import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AclService } from '../acl/acl.service.js';
import { AuditService } from '../audit/audit.service.js';
import { UsersRepository } from '../auth/users.repository.js';
import { UsersService } from '../auth/users.service.js';
import { loadConfig } from '../config.js';
import { newId, toStorageId } from '../common/ids.js';
import { openDb, runMigrations, type Db } from '../db/index.js';
import { EventsService } from '../events/events.service.js';
import { KnowledgeRepo, type Worktree } from '../knowledge/repo.js';
import type { AgentService } from '../agent/agent.service.js';
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
  runMigrations(db);
  db.prepare('INSERT INTO users(id,email,name,role,created_at) VALUES (1,?,?,?,?)')
    .run(author.email, author.name, 'editor', new Date().toISOString());
  const repo = await KnowledgeRepo.open(config, log);
  const agent = {
    runWrite: vi.fn(async (_job: WriteJob, wt: Worktree) => {
      await wt.write('wiki/result.md', 'saved knowledge\n');
      return { summary: 'Save useful knowledge\nDetails of the update.' };
    }),
    resolveConflicts: vi.fn(async () => {}),
  } as unknown as AgentService;
  const indexer = {
    syncToHead: vi.fn(async () => ({ indexedSha: await repo.headSha(), changedFiles: 1 })),
  } as unknown as IndexerService;
  const users = new UsersService(new UsersRepository(db));
  const events = new EventsService();
  const acl = new AclService(db, users, new AuditService(db));
  const jobs = new WriteJobsService(new WriteJobsRepository(db), agent, indexer, repo, users, log, events, acl);
  const ctx = { config, db, log, repo, agent, indexer, users, jobs, events };
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

describe('WriteJobsService with real git and a Dony double', () => {
  it.each(['queued', 'running', 'merging', 'succeeded'] as const)('reuses persisted %s jobs by dedupe key without new events', async (status) => {
    const { ctx, jobs } = await fixture();
    const input = { userId: 1, input: 'Remember once', source: 'chat' as const, dedupeKey: 'conversation:turn:content' };
    const first = jobs.submit(input);
    ctx.db.prepare('UPDATE write_jobs SET status = ? WHERE id = ?').run(status, toStorageId(first.id));
    const restarted = new WriteJobsService(new WriteJobsRepository(ctx.db), ctx.agent, ctx.indexer, ctx.repo, ctx.users, ctx.log, ctx.events, new AclService(ctx.db, ctx.users, new AuditService(ctx.db)));
    const reused = restarted.submit(input);
    expect(reused.id).toBe(first.id);
    expect(reused).toMatchObject({ status, reused: true });
    expect(first.reused).toBe(false);
    expect(jobs.list().map(job => job.id)).toEqual([first.id]);
    expect(jobs.events(first.id).map(event => event.phase)).toEqual(['queued']);
  });

  it('releases failed dedupe keys and leaves unkeyed submissions independent', async () => {
    const { jobs } = await fixture();
    const input = { userId: 1, input: 'Remember once', source: 'chat' as const, dedupeKey: 'conversation:turn:content' };
    const first = jobs.submit(input);
    jobs.cancel(first.id);
    const replacement = jobs.submit(input);
    expect(replacement.id).not.toBe(first.id);
    expect(replacement.reused).toBe(false);
    expect(jobs.submit(input)).toMatchObject({ id: replacement.id, reused: true });
    const unkeyed = { userId: 1, input: input.input, source: input.source };
    expect(jobs.submit(unkeyed).id).not.toBe(jobs.submit(unkeyed).id);
  });

  it('terminates latest running child snapshots exactly once when recovering interrupted parents', async () => {
    const { ctx, jobs } = await fixture();
    const repository = new WriteJobsRepository(ctx.db);
    const job = jobs.submit({ userId: 1, input: 'Interrupted children', source: 'chat' });
    repository.markRunning(job.id, job.createdAt);
    const running = { id: newId(), name: 'Writer', status: 'running', files: ['wiki/plan.md'], toolCalls: 3, startedAt: job.createdAt };
    const completed = { ...running, id: newId(), name: 'Done' };
    jobs.phase(job.id, 'editing', { subagent: { ...running, toolCalls: 1 } });
    jobs.phase(job.id, 'editing', { subagent: completed });
    jobs.phase(job.id, 'editing', { subagent: { ...completed, status: 'completed', result: 'Finished' } });
    jobs.phase(job.id, 'editing', { subagent: running });
    jobs.start();
    await jobs.stop();
    const recovered = jobs.events(job.id);
    const terminals = recovered.filter(event => (event.detail?.subagent as { status?: string } | undefined)?.status === 'cancelled');
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.detail?.subagent).toEqual({ ...running, status: 'cancelled', error: 'interrupted', finishedAt: jobs.get(job.id)!.finishedAt });
    expect(recovered.at(-1)).toMatchObject({ phase: 'failed', detail: { reason: 'interrupted' } });
    jobs.start();
    await jobs.stop();
    expect(jobs.events(job.id)).toEqual(recovered);
  });

  it('persists lifecycle, commits leftovers as requester, merges and indexes main', async () => {
    const { dir, ctx, jobs } = await fixture();
    const observed: string[] = [];
    vi.mocked(ctx.agent.runWrite).mockImplementation(async (job, wt, user) => {
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
    const queued = jobs.submit({ userId: 1, input: 'Remember this', source: 'mcp' });
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
      expect(stdout.trim().split('\n')).toEqual([author.name, author.email, '도니', 'dony@llmwiki.local']);
    }
    expect((await ctx.repo.show(result.commits[1]!)).commit.subject).toBe('Save useful knowledge');
    expect(await readdir(join(dir, 'worktrees'))).toEqual([]);
  });

  it('resolves a concurrent main conflict, with requester author on the merge commit', async () => {
    const { ctx, jobs } = await fixture();
    await advance(ctx.repo, 'baseline', 'original\n');
    vi.mocked(ctx.agent.runWrite).mockImplementation(async (_job, wt) => {
      await wt.write('wiki/shared.md', 'requested update\n');
      await advance(ctx.repo, 'concurrent', 'concurrent update\n');
      return { summary: 'Update shared note' };
    });
    vi.mocked(ctx.agent.resolveConflicts).mockImplementation(async (wt, files) => {
      expect(files).toEqual(['wiki/shared.md']);
      expect(await wt.read(files[0]!)).toContain('<<<<<<<');
      await wt.write(files[0]!, 'requested update\nconcurrent update\n');
    });
    jobs.start();
    const result = await completed(jobs, jobs.submit({ userId: 1, input: 'merge', source: 'mcp' }).id);
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
    vi.mocked(ctx.agent.runWrite).mockImplementation(async (_job, wt) => {
      await wt.write('wiki/shared.md', 'requested update\n');
      await advance(ctx.repo, 'concurrent', 'concurrent update\n');
      beforeMerge = await ctx.repo.headSha();
      return { summary: 'Conflict unresolved' };
    });
    jobs.start();
    const result = await completed(jobs, jobs.submit({ userId: 1, input: 'conflict', source: 'mcp' }).id);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Unresolved conflict markers');
    expect(result.mergeSha).toBeNull();
    expect(await ctx.repo.headSha()).toBe(beforeMerge);
    expect(ctx.indexer.syncToHead).not.toHaveBeenCalled();
  });

  it('preserves main and records Dony commits when the agent fails', async () => {
    const { dir, ctx, jobs } = await fixture();
    const before = await ctx.repo.headSha();
    vi.mocked(ctx.agent.runWrite).mockImplementation(async (_job, wt, user) => {
      await wt.write('wiki/incomplete.md', 'not published\n');
      await wt.commit('Unpublished attempt', user);
      throw new Error('Dony request failed');
    });
    jobs.start();
    const result = await completed(jobs, jobs.submit({ userId: 1, input: 'fail', source: 'mcp' }).id);
    await jobs.stop();
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Dony request failed');
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
    const result = await completed(jobs, jobs.submit({ userId: 1, input: 'save', source: 'mcp' }).id);
    expect(result.status).toBe('succeeded');
    expect(result.error).toBeNull();
    expect(await ctx.repo.readFile('wiki/result.md')).toBe('saved knowledge\n');
  });

  it('allows a no-change job without creating an empty user commit', async () => {
    const { ctx, jobs } = await fixture();
    const before = await ctx.repo.headSha();
    ctx.db.prepare('UPDATE users SET name = NULL WHERE id = 1').run();
    vi.mocked(ctx.agent.runWrite).mockImplementation(async (_job, _wt, user) => {
      expect(user).toEqual({ name: author.email, email: author.email });
      return { summary: 'Nothing new to save' };
    });
    jobs.start();
    const result = await completed(jobs, jobs.submit({ userId: 1, input: 'already known', source: 'mcp' }).id);
    expect(result.status).toBe('succeeded');
    expect(result.commits).toEqual([]);
    expect(result.mergeSha).toBe(before);
    expect(await ctx.repo.headSha()).toBe(before);
  });

  it('fails interrupted running/merging jobs on boot and resumes only queued jobs', async () => {
    const { ctx, jobs } = await fixture();
    const running = jobs.submit({ userId: 1, input: 'interrupted running', source: 'mcp' });
    const merging = jobs.submit({ userId: 1, input: 'interrupted merging', source: 'mcp' });
    const queued = jobs.submit({ userId: 1, input: 'resume queued', source: 'mcp' });
    ctx.db.prepare('UPDATE write_jobs SET status = ?, started_at = ? WHERE id = ?')
      .run('running', running.createdAt, toStorageId(running.id));
    ctx.db.prepare('UPDATE write_jobs SET status = ?, started_at = ? WHERE id = ?')
      .run('merging', merging.createdAt, toStorageId(merging.id));
    jobs.start();
    expect(jobs.get(running.id)?.status).toBe('failed');
    expect(jobs.get(merging.id)?.status).toBe('failed');
    expect(jobs.get(running.id)?.error).toContain('Engine restarted');
    expect(jobs.get(merging.id)?.finishedAt).not.toBeNull();
    expect((await completed(jobs, queued.id)).status).toBe('succeeded');
    expect(ctx.agent.runWrite).toHaveBeenCalledTimes(1);
  });

  it('runs one Dony job at a time and stops before consuming the next queued job', async () => {
    const { ctx, jobs } = await fixture();
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    vi.mocked(ctx.agent.runWrite).mockImplementationOnce(async (_job, wt) => {
      await gate;
      await wt.write('wiki/first.md', 'first\n');
      return { summary: 'First write' };
    });
    const first = jobs.submit({ userId: 1, input: 'first', source: 'mcp' });
    const second = jobs.submit({ userId: 1, input: 'second', source: 'mcp' });
    jobs.start();
    await vi.waitFor(() => expect(ctx.agent.runWrite).toHaveBeenCalledTimes(1));
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
    const records = Array.from({ length: 4 }, (_, index) => jobs.submit({ userId: index === 3 ? 2 : 1, input: String(index), source: 'mcp' }));
    ctx.db.prepare('UPDATE write_jobs SET created_at = ?').run('2026-10-07T00:00:00.000Z');
    const first = jobs.list({ userId: 1, limit: 2 });
    const second = jobs.list({ userId: 1, before: first[1]!.id, limit: 2 });
    expect([...first, ...second].map((job) => job.id).sort()).toEqual(records.slice(0, 3).map((job) => job.id).sort());
    ctx.db.prepare('DELETE FROM users WHERE id = 1').run();
    expect(jobs.get(records[0]!.id)?.userId).toBe(1);
    jobs.start();
    const result = await completed(jobs, records[0]!.id);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('no longer exists');
    expect(ctx.agent.runWrite).not.toHaveBeenCalled();
  });
});
