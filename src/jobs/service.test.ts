import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pino from 'pino';
import matter from 'gray-matter';
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
import { WikiCatalog } from '../knowledge/wiki-catalog.js';
import type { AgentService } from '../agent/agent.service.js';
import type { RunAgentOptions } from '../agent/agent.types.js';
import { makeWorktreeTools } from '../agent/worktree.js';
import { metadataDate, validateNoteMetadata } from '../knowledge/note-metadata.js';
import type { SearchService } from '../rag/search.service.js';
import type { IndexerService } from '../rag/indexer.service.js';
import type { WriteJob } from './write-job.types.js';
import { WriteJobsRepository } from './write-jobs.repository.js';
import { WriteJobsService } from './write-jobs.service.js';

const git = promisify(execFile);
const author = { name: 'Requesting User', email: 'user@example.com' };
const metadataRepairTitle = '## 메타데이터 검증 후 한 번의 보완';

function metadataRepairCalls(agent: AgentService) {
  return vi.mocked(agent.runAgent).mock.calls.filter(([options]) => options.instructions.includes(metadataRepairTitle));
}

function mockMetadataRepair(agent: AgentService, repair: AgentService['runAgent']) {
  // Legacy minimal note fixtures may also trigger the independent navigation pass.
  vi.mocked(agent.runAgent).mockImplementation(options => options.instructions.includes(metadataRepairTitle)
    ? repair(options)
    : Promise.resolve({ text: 'Navigation unchanged', finalText: 'Navigation unchanged', toolCalls: 0 }));
}

const fixtures: Array<{ dir: string; db: Db; jobs: WriteJobsService }> = [];

function note(body: string): string {
  return `---\ntype: note\naliases: [Durable knowledge]\ndescription: A durable fact for future lookup.\ntags: [knowledge]\nrelated: ["[[Existing note]]"]\nsource: [https://example.com/evidence]\nconfidence: high\nimportance: medium\ncustom: keep-me\n---\n${body}`;
}

async function fixture(jobsAutostart = true) {
  const dir = await mkdtemp(join(tmpdir(), 'llmwiki-jobs-'));
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: dir, JOBS_AUTOSTART: String(jobsAutostart) });
  const logs: Record<string, unknown>[] = [];
  const log = pino({ level: 'info' }, { write: line => { logs.push(JSON.parse(line)); } });
  const db = openDb(':memory:');
  runMigrations(db);
  db.prepare('INSERT INTO users(id,email,name,role,created_at) VALUES (1,?,?,?,?)')
    .run(author.email, author.name, 'editor', new Date().toISOString());
  const repo = await KnowledgeRepo.open(config, log);
  const agent = {
    runWrite: vi.fn(async (_job: WriteJob, wt: Worktree) => {
      await wt.write('wiki/result.md', note('saved knowledge\n'));
      return { summary: 'Save useful knowledge\nDetails of the update.' };
    }),
    resolveConflicts: vi.fn(async () => {}),
    runAgent: vi.fn(async (_options: RunAgentOptions) => ({ text: 'Quality unchanged', finalText: 'Quality unchanged', toolCalls: 0 })),
    baseInstructions: vi.fn(async () => 'Write durable knowledge.'),
    worktreeTools: vi.fn((...args: Parameters<AgentService['worktreeTools']>) => makeWorktreeTools({} as SearchService, args[0], args[1], acl, new WikiCatalog(repo, acl), args[2])),
  } as unknown as AgentService;
  const indexer = {
    syncToHead: vi.fn(async () => ({ indexedSha: await repo.headSha(), changedFiles: 1 })),
  } as unknown as IndexerService;
  const users = new UsersService(new UsersRepository(db));
  const events = new EventsService();
  const acl = new AclService(db, users, new AuditService(db));
  const jobs = new WriteJobsService(new WriteJobsRepository(db), agent, indexer, repo, users, log, events, acl, undefined, config);
  const ctx = { config, db, log, logs, repo, agent, indexer, users, jobs, events };
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
  it.each(['chat', 'web', 'mcp', 'dreaming', 'revert'] as const)('runs a later %s write after the running import, before queued batches', async (source) => {
    const { ctx, jobs } = await fixture();
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const observed: string[] = [];
    vi.mocked(ctx.agent.runWrite).mockImplementation(async (job) => {
      observed.push(job.input);
      if (job.input === 'running batch') await gate;
      return { summary: job.input };
    });
    const running = jobs.submit({ userId: 1, input: 'running batch', source: 'import' });
    jobs.start();
    await vi.waitFor(() => expect(observed).toEqual(['running batch']));
    const batches = [1, 2, 3].map(batch => jobs.submit({ userId: 1, input: `queued batch ${batch}`, source: 'import' }));
    const interactive = jobs.submit({ userId: 1, input: 'interactive', source });
    try {
      expect(jobs.get(running.id)?.status).toBe('running');
      expect(jobs.get(interactive.id)?.status).toBe('queued');
      expect(observed).toEqual(['running batch']);
    } finally {
      release();
    }
    expect((await completed(jobs, batches.at(-1)!.id)).status).toBe('succeeded');
    expect(observed).toEqual(['running batch', 'interactive', 'queued batch 1', 'queued batch 2', 'queued batch 3']);
  });

  it('keeps FIFO within both classes, including equal timestamps, and lets later batches read earlier merges', async () => {
    const { ctx, jobs } = await fixture();
    const observed: string[] = [];
    const mergedBatches: string[] = [];
    vi.mocked(ctx.agent.runWrite).mockImplementation(async (job, wt) => {
      observed.push(job.input);
      if (job.source === 'import') {
        for (const earlier of mergedBatches) expect(jobs.get(earlier)?.status).toBe('succeeded');
        const previous = await wt.read('wiki/batches.md');
        expect(previous === null ? '' : matter(previous).content).toBe(`${mergedBatches.join('\n')}${mergedBatches.length ? '\n' : ''}`);
        mergedBatches.push(job.id);
        await wt.write('wiki/batches.md', note(`${mergedBatches.join('\n')}\n`));
      }
      return { summary: job.input };
    });
    const submit = (input: string, source: WriteJob['source']) => jobs.submit({ userId: 1, input, source });
    submit('import A batch 0', 'import');
    submit('chat first', 'chat');
    submit('import A batch 1', 'import');
    submit('web second', 'web');
    const lastImport = submit('import B batch 0', 'import');
    submit('mcp third', 'mcp');
    submit('dreaming fourth', 'dreaming');
    submit('revert fifth', 'revert');
    ctx.db.prepare('UPDATE write_jobs SET created_at = ?').run('2026-10-15T00:00:00.000Z');
    jobs.start();
    expect((await completed(jobs, lastImport.id)).status).toBe('succeeded');
    expect(observed).toEqual([
      'chat first', 'web second', 'mcp third', 'import A batch 0',
      'dreaming fourth', 'revert fifth', 'import A batch 1', 'import B batch 0',
    ]);
  });

  it('runs a waiting import after at most three interactive picks even when more keep arriving', async () => {
    const { ctx, jobs } = await fixture();
    const observed: string[] = [];
    let interactiveCount = 0;
    vi.mocked(ctx.agent.runWrite).mockImplementation(async (job) => {
      observed.push(job.input);
      if (job.source !== 'import' && ++interactiveCount < 7) {
        jobs.submit({ userId: 1, input: `interactive ${interactiveCount + 1}`, source: 'chat' });
      }
      return { summary: job.input };
    });
    jobs.submit({ userId: 1, input: 'import first', source: 'import' });
    const lastImport = jobs.submit({ userId: 1, input: 'import second', source: 'import' });
    jobs.submit({ userId: 1, input: 'interactive 1', source: 'chat' });
    jobs.start();
    expect((await completed(jobs, lastImport.id)).status).toBe('succeeded');
    await jobs.stop();
    expect(observed.slice(0, 8)).toEqual([
      'interactive 1', 'interactive 2', 'interactive 3', 'import first',
      'interactive 4', 'interactive 5', 'interactive 6', 'import second',
    ]);
  });

  it.each(['chat', 'import'] as const)('keeps a retried %s write in its original scheduling class', async (source) => {
    const { ctx, jobs } = await fixture();
    const observed: string[] = [];
    vi.mocked(ctx.agent.runWrite).mockImplementation(async (job) => {
      observed.push(job.input);
      return { summary: job.input };
    });
    const failed = jobs.submit({ userId: 1, input: 'retried write', source });
    jobs.cancel(failed.id);
    const batch = jobs.submit({ userId: 1, input: 'earlier import', source: 'import' });
    const retried = jobs.retry(failed.id);
    expect(retried.source).toBe(source);
    jobs.start();
    expect((await completed(jobs, batch.id)).status).toBe('succeeded');
    expect((await completed(jobs, retried.id)).status).toBe('succeeded');
    expect(observed).toEqual(source === 'import' ? ['earlier import', 'retried write'] : ['retried write', 'earlier import']);
  });

  it('keeps startup, submitted and retried agent jobs queued when autostart is disabled', async () => {
    const { ctx, jobs } = await fixture(false);
    const before = await ctx.repo.headSha();
    const startup = jobs.submit({ userId: 1, input: 'Waiting before startup', source: 'mcp' });
    const canceled = jobs.submit({ userId: 1, input: 'Retry while paused', source: 'chat' });
    jobs.cancel(canceled.id);
    jobs.start();
    const submitted = jobs.submit({ userId: 1, input: 'Waiting after startup', source: 'web' });
    const retried = jobs.retry(canceled.id);
    jobs.start();
    const waited = await jobs.waitForSettled(startup.id, 20);
    expect(waited).toMatchObject({ timedOut: true, job: { status: 'queued', startedAt: null } });
    for (const job of [startup, submitted, retried]) {
      expect(jobs.get(job.id)).toMatchObject({ status: 'queued', startedAt: null });
      expect(jobs.events(job.id).map(event => event.phase)).toEqual(['queued']);
    }
    expect(jobs.events(retried.id)[0]?.detail).toMatchObject({ retryOf: canceled.id });
    expect(ctx.agent.runWrite).not.toHaveBeenCalled();
    expect(ctx.agent.resolveConflicts).not.toHaveBeenCalled();
    expect(await ctx.repo.headSha()).toBe(before);
  });

  it.each(['running', 'merging'] as const)('leaves interrupted %s jobs and their children untouched when autostart is disabled', async (status) => {
    const { ctx, jobs } = await fixture(false);
    const repository = new WriteJobsRepository(ctx.db);
    const job = jobs.submit({ userId: 1, input: 'Interrupted work', source: 'chat' });
    repository.markRunning(job.id, job.createdAt);
    if (status === 'merging') repository.markMerging(job.id, 'Pending merge', []);
    jobs.phase(job.id, 'editing', { subagent: {
      id: newId(), name: 'Writer', status: 'running', files: ['wiki/plan.md'],
      toolCalls: 3, startedAt: job.createdAt,
    } });
    const before = jobs.get(job.id);
    const events = jobs.events(job.id);
    jobs.start();
    await jobs.stop();
    expect(jobs.get(job.id)).toEqual(before);
    expect(jobs.events(job.id)).toEqual(events);
    expect(ctx.agent.runWrite).not.toHaveBeenCalled();
  });

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

  it.each([{ sources: [] }, { sources: ['raw/plan.md'] }])('preserves $sources while terminating interrupted children exactly once', async ({ sources }) => {
    const { ctx, jobs } = await fixture();
    const repository = new WriteJobsRepository(ctx.db);
    const job = jobs.submit({ userId: 1, input: 'Interrupted children', source: 'chat' });
    repository.markRunning(job.id, job.createdAt);
    const running = {
      id: newId(), name: 'Writer', status: 'running', files: ['wiki/plan.md'],
      ...(sources.length ? { sources } : {}), toolCalls: 3, startedAt: job.createdAt,
    };
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
    expect(terminals[0]?.detail?.subagent).toEqual({ ...running, sources, status: 'cancelled', error: 'interrupted', finishedAt: jobs.get(job.id)!.finishedAt });
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
      expect(matter((await ctx.repo.readFile('wiki/result.md'))!).content).toBe('saved knowledge\n');
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
    expect(matter((await ctx.repo.readFile('wiki/shared.md'))!).content).toBe('requested update\nconcurrent update\n');
    const merge = await ctx.repo.show(result.mergeSha!);
    expect(merge.commit.parents).toHaveLength(2);
    expect(merge.commit.authorEmail).toBe(author.email);
    expect(result.commits).toContain(result.mergeSha);
  });

  it.each([false, true])('reports conflict-created metadata issues without another repair (initially invalid: %s)', async initiallyInvalid => {
    const { ctx, jobs } = await fixture();
    await advance(ctx.repo, 'metadata-conflict-baseline', note('original fact\n'));
    vi.mocked(ctx.agent.runWrite).mockImplementation(async (_job, wt) => {
      await wt.write('wiki/shared.md', initiallyInvalid ? 'requested fact\n' : note('requested fact\n'));
      await advance(ctx.repo, 'metadata-conflict-concurrent', note('concurrent fact\n'));
      return { summary: 'Combine concurrent knowledge' };
    });
    mockMetadataRepair(ctx.agent, async options => {
      await options.tools.find(tool => tool.name === 'write_file')!.run({
        path: 'wiki/shared.md', content: note('requested fact\n'),
      });
      return { text: 'Metadata repaired before merge', finalText: 'Metadata repaired before merge', toolCalls: 1 };
    });
    vi.mocked(ctx.agent.resolveConflicts).mockImplementation(async (wt, paths) => {
      expect(paths).toEqual(['wiki/shared.md']);
      await wt.write('wiki/shared.md', 'requested fact\nconcurrent fact\n');
    });
    jobs.start();
    const result = await completed(jobs, jobs.submit({ userId: 1, input: 'combine', source: 'mcp' }).id);
    expect(result.status).toBe('succeeded');
    expect(ctx.agent.resolveConflicts).toHaveBeenCalledTimes(1);
    expect(metadataRepairCalls(ctx.agent)).toHaveLength(initiallyInvalid ? 1 : 0);
    expect(matter((await ctx.repo.readFile('wiki/shared.md'))!).content).toBe('requested fact\nconcurrent fact\n');
    const metadataIssues = [{
      path: 'wiki/shared.md',
      issues: expect.arrayContaining([
        expect.objectContaining({ field: 'type' }),
        expect.objectContaining({ field: 'aliases' }),
        expect.objectContaining({ field: 'description' }),
        expect.objectContaining({ field: 'tags' }),
      ]),
    }];
    expect(jobs.events(result.id).at(-1)).toMatchObject({ phase: 'done', detail: { metadataIssues } });
    expect(ctx.logs.find(log => log.msg === 'Write job completed' && log.jobId === result.id)).toMatchObject({ metadataIssues });
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
    expect(matter((await ctx.repo.readFile('wiki/result.md'))!).content).toBe('saved knowledge\n');
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

  it('stamps valid agent-created notes without changing metadata or body or invoking metadata repair', async () => {
    const { ctx, jobs } = await fixture();
    const body = '# Durable knowledge\r\n\r\nExact body spacing.  \r\n';
    vi.mocked(ctx.agent.runWrite).mockImplementation(async (_job, wt) => {
      await wt.write('wiki/result.md', note(body));
      return { summary: 'Save metadata-rich knowledge' };
    });
    jobs.start();
    const result = await completed(jobs, jobs.submit({ userId: 1, input: 'save', source: 'mcp' }).id);
    expect(result.status).toBe('succeeded');
    const content = (await ctx.repo.readFile('wiki/result.md'))!;
    const parsed = matter(content);
    expect(parsed.content).toBe(body);
    expect(parsed.data).toMatchObject({
      ...matter(note(body)).data,
      author: [author.name],
    });
    expect(metadataDate(parsed.data['date created'])).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(metadataDate(parsed.data['date modified'])).toBe(metadataDate(parsed.data['date created']));
    expect(validateNoteMetadata('wiki/result.md', content)).toEqual([]);
    expect(metadataRepairCalls(ctx.agent)).toHaveLength(0);
    expect(jobs.events(result.id).at(-1)?.detail).not.toHaveProperty('metadataIssues');
  });

  it('invokes metadata repair exactly once, commits the valid result and includes repair usage', async () => {
    const { ctx, jobs } = await fixture();
    const body = '# Useful fact\nKeep this knowledge.\n';
    vi.mocked(ctx.agent.runWrite).mockImplementation(async (_job, wt, _author, _user, options) => {
      options?.onUsage?.({ inputTokens: 10, cachedInputTokens: 2, outputTokens: 3, reasoningTokens: 1 });
      await wt.write('wiki/result.md', body);
      return { summary: 'Save useful fact' };
    });
    mockMetadataRepair(ctx.agent, async options => {
      expect(JSON.parse(options.input as string).notes).toEqual([{
        path: 'wiki/result.md',
        issues: expect.arrayContaining([expect.objectContaining({ field: 'type' })]),
      }]);
      options.onUsage?.({ inputTokens: 7, cachedInputTokens: 1, outputTokens: 2, reasoningTokens: 1 });
      await options.tools.find(tool => tool.name === 'write_file')!.run({ path: 'wiki/result.md', content: note(body) });
      return { text: 'Repaired', finalText: 'Repaired', toolCalls: 1 };
    });
    jobs.start();
    const result = await completed(jobs, jobs.submit({ userId: 1, input: 'save', source: 'mcp' }).id);
    expect(result.status).toBe('succeeded');
    expect(metadataRepairCalls(ctx.agent)).toHaveLength(1);
    expect(result.commits).toHaveLength(2);
    const content = (await ctx.repo.readFile('wiki/result.md'))!;
    expect(matter(content).content).toBe(body);
    expect(validateNoteMetadata('wiki/result.md', content)).toEqual([]);
    const usage = { inputTokens: 17, cachedInputTokens: 3, outputTokens: 5, reasoningTokens: 2 };
    expect(jobs.events(result.id).at(-1)).toMatchObject({ phase: 'done', detail: { usage } });
    expect(jobs.events(result.id).at(-1)?.detail).not.toHaveProperty('metadataIssues');
    expect(ctx.logs.find(log => log.msg === 'Write job completed' && log.jobId === result.id)).toMatchObject({ usage, metadataIssues: [] });
  });

  it.each(['invalid', 'error'] as const)('merges preserved knowledge and records remaining issues after one %s repair', async outcome => {
    const { ctx, jobs } = await fixture();
    const body = '# Useful fact\nKnowledge survives imperfect metadata.\n';
    vi.mocked(ctx.agent.runWrite).mockImplementation(async (_job, wt) => {
      await wt.write('wiki/result.md', body);
      return { summary: 'Preserve useful fact' };
    });
    mockMetadataRepair(ctx.agent, async options => {
      options.onUsage?.({ inputTokens: 7, cachedInputTokens: 1, outputTokens: 2, reasoningTokens: 1 });
      if (outcome === 'error') throw new Error('Repair provider unavailable');
      await options.tools.find(tool => tool.name === 'write_file')!.run({
        path: 'wiki/result.md', content: `---\ntype: note\n---\n${body}`,
      });
      return { text: 'Incomplete repair', finalText: 'Incomplete repair', toolCalls: 1 };
    });
    jobs.start();
    const result = await completed(jobs, jobs.submit({ userId: 1, input: 'save', source: 'mcp' }).id);
    expect(result.status).toBe('succeeded');
    expect(result.error).toBeNull();
    expect(metadataRepairCalls(ctx.agent)).toHaveLength(1);
    expect(result.commits).toHaveLength(outcome === 'invalid' ? 2 : 1);
    expect(matter((await ctx.repo.readFile('wiki/result.md'))!).content).toBe(body);
    const metadataIssues = [{
      path: 'wiki/result.md',
      issues: expect.arrayContaining([expect.objectContaining({ field: 'description' }), expect.objectContaining({ field: 'tags' })]),
    }];
    const usage = { inputTokens: 7, cachedInputTokens: 1, outputTokens: 2, reasoningTokens: 1 };
    expect(jobs.events(result.id).at(-1)).toMatchObject({ phase: 'done', detail: { metadataIssues, usage } });
    expect(ctx.logs.find(log => log.msg === 'Write job completed' && log.jobId === result.id)).toMatchObject({ metadataIssues, usage });
    if (outcome === 'error') {
      expect(jobs.events(result.id)).toContainEqual(expect.objectContaining({
        phase: 'editing', detail: { metadataRepair: 'error', error: 'Repair provider unavailable' },
      }));
    }
  });

  it('does not repair metadata in schema, raw, journal, root metadata or deleted notes', async () => {
    const { ctx, jobs } = await fixture();
    const seed = await ctx.repo.createWorktree('deleted-note-baseline');
    await seed.write('wiki/deleted.md', 'legacy invalid note\n');
    await seed.commit('Seed legacy note', author);
    await ctx.repo.withMergeLock(() => seed.fastForwardMain());
    await seed.dispose();
    vi.mocked(ctx.agent.runWrite).mockImplementation(async (_job, wt) => {
      await wt.remove('wiki/deleted.md');
      await wt.write('wiki/domain/AGENTS.md', '# Domain writing rules\n');
      await wt.write('AGENTS.md', '# Global writing rules\n');
      await wt.write('raw/source.md', '# Original source\n');
      await wt.write('journal/2026-10-10.md', '# Journal\n');
      return { summary: 'Update non-note files' };
    });
    jobs.start();
    const result = await completed(jobs, jobs.submit({ userId: 1, input: 'save', source: 'mcp' }).id);
    expect(result.status).toBe('succeeded');
    expect(metadataRepairCalls(ctx.agent)).toHaveLength(0);
    expect(await ctx.repo.readFile('wiki/deleted.md')).toBeNull();
    expect(await ctx.repo.readFile('wiki/domain/AGENTS.md')).toBe('# Domain writing rules\n');
    expect(await ctx.repo.readFile('raw/source.md')).toBe('# Original source\n');
    expect(await ctx.repo.readFile('journal/2026-10-10.md')).toBe('# Journal\n');
    expect(jobs.events(result.id).at(-1)?.detail).not.toHaveProperty('metadataIssues');
  });

  it('never sends engine-owned field issues to the repair model', async () => {
    const { ctx, jobs } = await fixture();
    vi.mocked(ctx.agent.runWrite).mockImplementation(async (_job, wt) => {
      await wt.write('wiki/result.md', `---\ntype: note\naliases: []\ndescription: Preserve a valid knowledge record.\ntags: [knowledge]\nauthor: invalid-legacy-author\ndate created: invalid-legacy-date\n---\n# Preserved knowledge\n`);
      return { summary: 'Keep engine ownership separate' };
    });
    jobs.start();
    const result = await completed(jobs, jobs.submit({ userId: 1, input: 'save', source: 'mcp' }).id);
    expect(result.status).toBe('succeeded');
    expect(metadataRepairCalls(ctx.agent)).toHaveLength(0);
    expect(matter((await ctx.repo.readFile('wiki/result.md'))!).content).toBe('# Preserved knowledge\n');
    expect(jobs.events(result.id).at(-1)?.detail).not.toHaveProperty('metadataIssues');
  });
});
