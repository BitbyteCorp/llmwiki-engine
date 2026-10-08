import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AclService } from '../acl/acl.service.js';
import { AgentService } from '../agent/agent.service.js';
import { AgentCheckpointsRepository } from '../agent/checkpoints.repository.js';
import { AuditService } from '../audit/audit.service.js';
import { UsersRepository } from '../auth/users.repository.js';
import { UsersService } from '../auth/users.service.js';
import { loadConfig } from '../config.js';
import { openDb, runMigrations } from '../db/index.js';
import { EventsService } from '../events/events.service.js';
import { KnowledgeRepo } from '../knowledge/repo.js';
import { IndexerService } from '../rag/indexer.service.js';
import { SearchService } from '../rag/search.service.js';
import { WriteJobsRepository } from './write-jobs.repository.js';
import { WriteJobsService } from './write-jobs.service.js';

interface FakeRequest { path: string; body: Record<string, unknown> }
interface FakeCall { name: string; arguments: Record<string, unknown>; call_id?: string }
type FakeTurn = string | FakeCall | ({ functionCalls: FakeCall[] } | { text: string }) & {
  usage?: { inputTokens: number; cachedInputTokens?: number; outputTokens: number; reasoningTokens: number };
  status?: 'completed' | 'failed';
};
type FakeResponder = (request: FakeRequest, index: number) => FakeTurn | Promise<FakeTurn>;
interface FakeProvider { url: string; requests: FakeRequest[]; close(): Promise<void> }
interface InputItem { type?: string; call_id?: string; output?: string }
const git = promisify(execFile);
const author = { name: 'Resume Requester', email: 'resume@example.test' };
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function fixture(responder: FakeResponder) {
  // The shared provider lives outside the production TypeScript root.
  const { startFakeOpenAI }: { startFakeOpenAI(script: FakeResponder): Promise<FakeProvider> } = await import(new URL('../../test/fake-openai.ts', import.meta.url).href);
  const dir = await mkdtemp(join(tmpdir(), 'llmwiki-resume-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const fake = await startFakeOpenAI(responder);
  cleanup.push(() => fake.close());
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: dir, OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: fake.url, OPENAI_MAX_RETRIES: '0', EMBEDDING_DIMENSIONS: '2' });
  const logs: Record<string, unknown>[] = [];
  const log = pino({ level: 'info' }, { write: line => { logs.push(JSON.parse(line)); } });
  const db = openDb(':memory:');
  runMigrations(db);
  cleanup.push(async () => db.close());
  db.prepare('INSERT INTO users(id,email,name,role,created_at) VALUES (1,?,?,?,?)').run(author.email, author.name, 'editor', new Date().toISOString());
  const users = new UsersService(new UsersRepository(db));
  const acl = new AclService(db, users, new AuditService(db));
  const events = new EventsService();
  const repository = new WriteJobsRepository(db);
  const checkpoints = new AgentCheckpointsRepository(db);
  function services(repo: KnowledgeRepo) {
    const search = new SearchService(config, db, log, acl, repo);
    const agent = new AgentService(config, log, repo, search, acl);
    const indexer = new IndexerService(config, db, log, repo, events);
    const jobs = new WriteJobsService(repository, agent, indexer, repo, users, log, events, acl);
    cleanup.push(() => jobs.stop());
    return { agent, jobs };
  }
  const repo = await KnowledgeRepo.open(config, log);
  return { dir, db, fake, config, log, logs, repo, repository, checkpoints, users, services, ...services(repo) };
}

async function settled(jobs: WriteJobsService, id: string) {
  await vi.waitFor(() => expect(['succeeded', 'failed']).toContain(jobs.get(id)?.status), { timeout: 15000, interval: 10 });
  await jobs.stop();
  return jobs.get(id)!;
}

function output(request: FakeRequest, callId: string) {
  const item = (request.body.input as InputItem[]).find(item => item.type === 'function_call_output' && item.call_id === callId);
  expect(item, `tool result for ${callId}`).toBeDefined();
  return JSON.parse(item!.output!);
}

describe('write job continuation with real Dony and git', () => {
  it.each(['none', 'child', 'conflict'] as const)('records parent, child and conflict usage with %s failing', async (failure) => {
    let parentTurn = 0;
    let childTurn = 0;
    let conflictTurn = 0;
    const f = await fixture(async (request) => {
      const lane = String(request.body.prompt_cache_key);
      if (lane.includes(':subagent:')) {
        const usage = { inputTokens: 30, cachedInputTokens: 10, outputTokens: 8, reasoningTokens: 2 };
        return childTurn++ === 0
          ? { functionCalls: [{ name: 'write_file', arguments: { path: 'wiki/child.md', content: 'delegated fact\n' } }], usage }
          : { text: 'Child finished', usage, status: failure === 'child' ? 'failed' : 'completed' };
      }
      if (lane.includes(':conflict:')) {
        const usage = { inputTokens: 50, cachedInputTokens: 20, outputTokens: 10, reasoningTokens: 3 };
        return conflictTurn++ === 0
          ? { functionCalls: [{ name: 'write_file', arguments: { path: 'wiki/shared.md', content: 'requested fact\nconcurrent fact\n' } }], usage }
          : { text: 'Conflict resolved', usage, status: failure === 'conflict' ? 'failed' : 'completed' };
      }
      const usage = { inputTokens: 100, cachedInputTokens: 50, outputTokens: 20, reasoningTokens: 4 };
      const turn = parentTurn++;
      if (turn === 0) return { functionCalls: [{ name: 'spawn_subagent', arguments: { name: 'Writer', task: 'Record delegated fact', files: ['wiki/child.md'] } }], usage };
      if (turn === 1) return { functionCalls: [{ name: 'wait_subagents', arguments: {} }], usage };
      if (turn === 2) return { functionCalls: [{ name: 'write_file', arguments: { path: 'wiki/shared.md', content: 'requested fact\n' } }], usage };
      const concurrent = await f.repo.createWorktree('concurrent');
      try {
        await concurrent.write('wiki/shared.md', 'concurrent fact\n');
        await concurrent.commit('Concurrent fact', author);
        await f.repo.withMergeLock(() => concurrent.fastForwardMain());
      } finally {
        await concurrent.dispose();
      }
      return { text: 'Record combined knowledge', usage };
    });
    const baseline = await f.repo.createWorktree('baseline');
    await baseline.write('wiki/shared.md', 'original fact\n');
    await baseline.commit('Baseline shared fact', author);
    await f.repo.withMergeLock(() => baseline.fastForwardMain());
    await baseline.dispose();
    f.jobs.start();
    const job = f.jobs.submit({ userId: 1, source: 'mcp', input: 'Record independent facts' });
    const result = await settled(f.jobs, job.id);
    const usage = { inputTokens: 560, cachedInputTokens: 260, outputTokens: 116, reasoningTokens: 26 };
    expect(result.status).toBe(failure === 'conflict' ? 'failed' : 'succeeded');
    if (failure === 'conflict') {
      expect(await f.repo.readFile('wiki/shared.md')).toBe('concurrent fact\n');
      expect(f.jobs.events(job.id).at(-1)).toMatchObject({ phase: 'failed', detail: { usage, error: result.error } });
      expect(f.logs.find(log => log.msg === 'Write job failed' && log.jobId === job.id)).toMatchObject({ usage });
    } else {
      expect(await f.repo.readFile('wiki/child.md')).toBe('delegated fact\n');
      expect(await f.repo.readFile('wiki/shared.md')).toBe('requested fact\nconcurrent fact\n');
      expect(f.jobs.events(job.id).at(-1)).toMatchObject({ phase: 'done', detail: { usage } });
      expect(f.logs.find(log => log.msg === 'Write job completed' && log.jobId === job.id)).toMatchObject({ usage });
    }
    if (failure === 'child') {
      expect(f.jobs.events(job.id).some(event => {
        const child = event.detail?.subagent as { status?: string } | undefined;
        return child?.status === 'failed';
      })).toBe(true);
    }
  }, 20000);

  it('resumes a failed tool turn under a new identity and publishes its uncommitted file', async () => {
    let retrying = false;
    let retryTurns = 0;
    const path = 'wiki/uncommitted.md';
    const content = '# Preserved knowledge\nThe completed tool turn survives provider failure.\n';
    const f = await fixture((_request, index) => {
      if (!retrying) {
        if (index === 0) return { functionCalls: [{ name: 'write_file', arguments: { path, content }, call_id: 'before-failure' }], usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningTokens: 5 } };
        throw new Error('provider failed after writing');
      }
      if (retryTurns++ === 0) return { functionCalls: [{ name: 'read_file', arguments: { path }, call_id: 'restored-file' }], usage: { inputTokens: 60, cachedInputTokens: 30, outputTokens: 10, reasoningTokens: 2 } };
      return { text: 'Publish preserved knowledge', usage: { inputTokens: 80, cachedInputTokens: 50, outputTokens: 25, reasoningTokens: 8 } };
    });
    f.jobs.start();
    const original = f.jobs.submit({ userId: 1, source: 'mcp', input: 'Record a durable fact', client: 'resume-test' });
    const failed = await settled(f.jobs, original.id);
    expect(failed).toMatchObject({ status: 'failed', commits: [] });
    const failedUsage = { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningTokens: 5 };
    expect(f.jobs.events(original.id).at(-1)).toMatchObject({ phase: 'failed', detail: { usage: failedUsage, error: failed.error } });
    expect(f.logs.find(log => log.msg === 'Write job failed' && log.jobId === original.id)).toMatchObject({ usage: failedUsage });
    expect(await f.repo.readFile(path)).toBeNull();
    const checkpoint = f.checkpoints.get(`job:${original.id}`);
    expect(checkpoint?.toolCalls).toBe(1);
    const firstRetryRequest = f.fake.requests.filter(request => request.path.endsWith('/responses')).length;
    retrying = true;
    f.jobs.start();
    const retry = f.jobs.retry(original.id);
    expect(retry.id).not.toBe(original.id);
    expect(f.jobs.events(retry.id)[0]).toMatchObject({ phase: 'queued', detail: { retryOf: original.id, resumedFrom: original.id } });
    expect(f.checkpoints.get(`job:${original.id}`)).toBeUndefined();
    expect(f.checkpoints.get(`job:${retry.id}`)).toEqual(checkpoint);
    const succeeded = await settled(f.jobs, retry.id);
    expect(succeeded.status).toBe('succeeded');
    const retryUsage = { inputTokens: 140, cachedInputTokens: 80, outputTokens: 35, reasoningTokens: 10 };
    expect(f.jobs.events(retry.id).at(-1)).toMatchObject({ phase: 'done', detail: { usage: retryUsage } });
    expect(f.logs.find(log => log.msg === 'Write job completed' && log.jobId === retry.id)).toMatchObject({ usage: retryUsage });
    const requests = f.fake.requests.filter(request => request.path.endsWith('/responses'));
    expect(output(requests[firstRetryRequest]!, 'before-failure')).toEqual({ path, written: true });
    expect(output(requests[firstRetryRequest + 1]!, 'restored-file')).toMatchObject({ path, content });
    expect(await f.repo.readFile(path)).toBe(content);
    expect((await f.repo.show(succeeded.commits[0]!)).commit.trailers['Wiki-Job']).toBe(retry.id);
    expect(f.jobs.get(original.id)).toEqual(failed);
    expect(f.checkpoints.get(`job:${original.id}`)).toBeUndefined();
    expect(f.checkpoints.get(`job:${retry.id}`)).toBeUndefined();
  }, 20000);

  it('retries from failed committed history even when no model checkpoint remains', async () => {
    let retrying = false;
    let retryTurns = 0;
    const path = 'wiki/already-committed.md';
    const content = '# Prior commit\nThis work must not be recreated or lost.\n';
    const f = await fixture((_request, index) => {
      if (!retrying) {
        if (index === 0) return { name: 'write_file', arguments: { path, content } };
        if (index === 1) return { name: 'commit', arguments: { message: 'Preserve semantic work' } };
        throw new Error('provider failed after committing');
      }
      if (retryTurns++ === 0) return { name: 'read_file', arguments: { path }, call_id: 'committed-file' };
      return 'Publish prior semantic work';
    });
    f.jobs.start();
    const original = f.jobs.submit({ userId: 1, source: 'mcp', input: 'Save prior semantic work' });
    const failed = await settled(f.jobs, original.id);
    expect(failed.status).toBe('failed');
    expect(failed.commits).toHaveLength(1);
    const priorCommit = failed.commits[0]!;
    expect(await f.repo.readFile(path)).toBeNull();
    expect(await f.repo.readFile(path, `refs/wiki/failed/${original.id}`)).toBe(content);
    f.checkpoints.delete(`job:${original.id}`);
    const firstRetryRequest = f.fake.requests.filter(request => request.path.endsWith('/responses')).length;
    retrying = true;
    f.jobs.start();
    const retry = f.jobs.retry(original.id);
    expect(f.jobs.events(retry.id)[0]).toMatchObject({ detail: { retryOf: original.id } });
    expect(f.jobs.events(retry.id)[0]!.detail).not.toHaveProperty('resumedFrom');
    const succeeded = await settled(f.jobs, retry.id);
    expect(succeeded.status).toBe('succeeded');
    const requests = f.fake.requests.filter(request => request.path.endsWith('/responses'));
    expect(output(requests[firstRetryRequest + 1]!, 'committed-file')).toMatchObject({ path, content });
    expect(succeeded.commits).toContain(priorCommit);
    expect(await f.repo.readFile(path)).toBe(content);
    await git('git', ['merge-base', '--is-ancestor', priorCommit, 'main'], { cwd: join(f.dir, 'knowledge') });
    expect((await f.repo.show(priorCommit)).commit.trailers['Wiki-Job']).toBe(original.id);
    expect(f.checkpoints.get(`job:${retry.id}`)).toBeUndefined();
  }, 20000);

  it('recovers an interrupted worktree and resumes its saved tool context after startup', async () => {
    let retrying = false;
    let retryTurns = 0;
    const path = 'wiki/interrupted.md';
    const content = '# Interrupted knowledge\nUncommitted work survives engine startup.\n';
    const f = await fixture((_request, index) => {
      if (!retrying) {
        if (index === 0) return { name: 'write_file', arguments: { path, content }, call_id: 'interrupted-write' };
        throw new Error('process interrupted before another turn');
      }
      if (retryTurns++ === 0) return { name: 'read_file', arguments: { path }, call_id: 'recovered-file' };
      return 'Publish recovered knowledge';
    });
    const original = f.jobs.submit({ userId: 1, source: 'chat', input: 'Save interrupted work' });
    f.repository.markRunning(original.id, new Date().toISOString());
    const wt = await f.repo.createWorktree(original.id);
    wt.setCommitMetadata({ jobId: original.id, source: original.source, requester: author.email });
    // Leave the worktree behind exactly as a terminated process would; startup owns recovery.
    await expect(f.agent.runWrite(f.jobs.get(original.id)!, wt, author, f.users.getById(1)!, {
      onCheckpoint: checkpoint => f.checkpoints.save(`job:${original.id}`, checkpoint),
    })).rejects.toThrow('process interrupted');
    expect(await wt.read(path)).toBe(content);
    expect(await f.repo.readFile(path)).toBeNull();
    const checkpoint = f.checkpoints.get(`job:${original.id}`)!;
    const reopenedRepo = await KnowledgeRepo.open(f.config, f.log);
    const restarted = f.services(reopenedRepo);
    restarted.jobs.start();
    expect(restarted.jobs.get(original.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('Engine restarted') });
    expect(restarted.jobs.events(original.id).at(-1)).toMatchObject({ phase: 'failed', detail: { reason: 'interrupted' } });
    const firstRetryRequest = f.fake.requests.filter(request => request.path.endsWith('/responses')).length;
    retrying = true;
    const retry = restarted.jobs.retry(original.id);
    expect(retry.id).not.toBe(original.id);
    expect(restarted.jobs.events(retry.id)[0]).toMatchObject({ detail: { retryOf: original.id, resumedFrom: original.id } });
    expect(f.checkpoints.get(`job:${original.id}`)).toBeUndefined();
    const succeeded = await settled(restarted.jobs, retry.id);
    expect(succeeded.status).toBe('succeeded');
    const requests = f.fake.requests.filter(request => request.path.endsWith('/responses'));
    expect(output(requests[firstRetryRequest]!, 'interrupted-write')).toEqual({ path, written: true });
    expect(output(requests[firstRetryRequest + 1]!, 'recovered-file')).toMatchObject({ path, content });
    expect(await reopenedRepo.readFile(path)).toBe(content);
    expect(f.checkpoints.get(`job:${original.id}`)).toBeUndefined();
    expect(f.checkpoints.get(`job:${retry.id}`)).toBeUndefined();
  }, 20000);

  it('keeps the failed job checkpoint when persisting the retry event fails atomically', async () => {
    let retrying = false;
    const path = 'wiki/atomic-retry.md';
    const content = '# Atomic retry\nA failed enqueue must leave this work retryable.\n';
    const f = await fixture((_request, index) => {
      if (retrying) return 'Publish atomically retried knowledge';
      if (index === 0) return { name: 'write_file', arguments: { path, content }, call_id: 'atomic-write' };
      throw new Error('provider interrupted before retry');
    });
    f.jobs.start();
    const original = f.jobs.submit({ userId: 1, source: 'mcp', input: 'Save atomically retried work' });
    const failed = await settled(f.jobs, original.id);
    expect(failed.status).toBe('failed');
    const checkpoint = f.checkpoints.get(`job:${original.id}`)!;
    expect(checkpoint.toolCalls).toBe(1);
    const originalEvents = f.jobs.events(original.id);
    f.db.exec(`
      CREATE TRIGGER reject_retry_queued BEFORE INSERT ON write_job_events
      WHEN NEW.phase = 'queued'
      BEGIN SELECT RAISE(ABORT, 'retry queued event rejected'); END;
    `);
    expect(() => f.jobs.retry(original.id)).toThrow('retry queued event rejected');
    expect(f.jobs.list()).toEqual([failed]);
    expect(f.jobs.events(original.id)).toEqual(originalEvents);
    expect(f.checkpoints.get(`job:${original.id}`)).toEqual(checkpoint);
    f.db.exec('DROP TRIGGER reject_retry_queued');
    retrying = true;
    const retry = f.jobs.retry(original.id);
    expect(retry.id).not.toBe(original.id);
    expect(f.jobs.events(retry.id)[0]).toMatchObject({ phase: 'queued', detail: { retryOf: original.id, resumedFrom: original.id } });
    expect(f.checkpoints.get(`job:${original.id}`)).toBeUndefined();
    expect(f.checkpoints.get(`job:${retry.id}`)).toEqual(checkpoint);
    f.jobs.start();
    expect((await settled(f.jobs, retry.id)).status).toBe('succeeded');
    expect(await f.repo.readFile(path)).toBe(content);
    expect(f.checkpoints.get(`job:${retry.id}`)).toBeUndefined();
  }, 20000);
});
