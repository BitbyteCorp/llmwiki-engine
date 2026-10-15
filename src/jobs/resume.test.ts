import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pino from 'pino';
import matter from 'gray-matter';
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

function note(body: string): string {
  return `---\ntype: note\naliases: []\ndescription: Durable knowledge retained across retries.\ntags: [knowledge]\n---\n${body}`;
}

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
  return { dir, db, fake, config, log, logs, repo, repository, checkpoints, users, acl, services, ...services(repo) };
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


async function seedSources(repo: KnowledgeRepo, sources: Record<string, string>) {
  const wt = await repo.createWorktree('assigned-sources');
  try {
    for (const [path, content] of Object.entries(sources)) await wt.write(path, content);
    await wt.commit('Preserve assigned source material', author);
    await repo.withMergeLock(() => wt.fastForwardMain());
  } finally {
    await wt.dispose();
  }
}

function lastUserMessage(request: FakeRequest) {
  const messages = request.body.input as Array<{ role?: string; content?: unknown }>;
  return String(messages.filter(item => item.role === 'user').at(-1)?.content);
}
describe('write job continuation with real Dony and git', () => {
  it('rejects premature assigned-source finals until out-of-order pages cover the whole file', async () => {
    const path = 'raw/import/batch.md';
    const content = 'first fact\nsecond fact\nthird fact\nlast fact\n';
    const published = 'wiki/imported.md';
    const f = await fixture((request, turn) => {
      if (turn === 0) return { name: 'write_file', arguments: { path: published, content: note('# Imported facts\nAll four facts are preserved.\n') } };
      if (turn === 1) return 'PREMATURE_FIRST_SUMMARY';
      if (turn === 2) {
        expect(lastUserMessage(request)).toContain(path);
        expect(lastUserMessage(request)).toContain('read_file');
        expect(lastUserMessage(request)).toContain('sources');
        expect(lastUserMessage(request)).toContain('wait_subagents');
        return { name: 'read_file', arguments: { path, offset: 2, limit: 2 }, call_id: 'source-tail' };
      }
      if (turn === 3) {
        expect(output(request, 'source-tail')).toMatchObject({ content: 'third fact\nlast fact\n', truncated: false });
        return 'PREMATURE_TAIL_ONLY_SUMMARY';
      }
      if (turn === 4) {
        expect(lastUserMessage(request)).toContain(path);
        return { name: 'read_file', arguments: { path, offset: 0, limit: 2 }, call_id: 'source-head' };
      }
      expect(output(request, 'source-head')).toMatchObject({ content: 'first fact\nsecond fact\n', nextOffset: 2, truncated: true });
      return 'Publish all four imported facts';
    });
    await seedSources(f.repo, { [path]: content });
    f.jobs.start();
    const job = f.jobs.submit({ userId: 1, source: 'import', input: 'Integrate every assigned fact', requiredReads: [path] });
    const result = await settled(f.jobs, job.id);
    expect(result).toMatchObject({ status: 'succeeded', summary: 'Publish all four imported facts' });
    expect(matter((await f.repo.readFile(published))!).content).toBe('# Imported facts\nAll four facts are preserved.\n');
    expect(await f.repo.readFile(path)).toBe(content);
    expect(f.checkpoints.get(`job:${job.id}`)).toBeUndefined();
  }, 20000);

  it('fails the third unfinished final without merging any unreviewed work', async () => {
    const read = 'raw/import/read.md';
    const unread = 'raw/import/unread.md';
    const published = 'wiki/unreviewed.md';
    let finalAttempts = 0;
    const f = await fixture((request, turn) => {
      if (turn === 0) return { functionCalls: [
        { name: 'read_file', arguments: { path: read }, call_id: 'read-source' },
        { name: 'write_file', arguments: { path: published, content: 'This must remain unpublished.\n' } },
      ] };
      if (turn === 1) expect(output(request, 'read-source')).toMatchObject({ content: 'Known fact\n', truncated: false });
      else {
        expect(lastUserMessage(request)).toContain(unread);
        expect(lastUserMessage(request)).not.toContain(read);
      }
      return `Unfinished final ${++finalAttempts}`;
    });
    await seedSources(f.repo, { [read]: 'Known fact\n', [unread]: 'Unread fact\n' });
    const mainBefore = await f.repo.headSha();
    f.jobs.start();
    const job = f.jobs.submit({ userId: 1, source: 'import', input: 'Integrate both sources', requiredReads: [read, unread] });
    const result = await settled(f.jobs, job.id);
    expect(result).toMatchObject({
      status: 'failed', summary: null, mergeSha: null,
      error: `unread assigned sources: 1/2 (${unread})`,
    });
    expect(finalAttempts).toBe(3);
    expect(await f.repo.headSha()).toBe(mainBefore);
    expect(await f.repo.readFile(published)).toBeNull();
  }, 20000);

  it('preserves a rejected-final follow-up on provider failure and requires fresh reads on retry', async () => {
    const first = 'raw/import/first.md';
    const second = 'raw/import/second.md';
    const published = 'wiki/resumed-import.md';
    let retrying = false;
    let retryTurn = 0;
    const f = await fixture((request, turn) => {
      if (!retrying) {
        if (turn === 0) return { functionCalls: [
          { name: 'read_file', arguments: { path: first }, call_id: 'original-source-read' },
          { name: 'write_file', arguments: { path: published, content: note('# Imported knowledge\nBoth assigned facts.\n') }, call_id: 'preserved-import-write' },
        ] };
        if (turn === 1) return 'REJECTED_BEFORE_PROVIDER_FAILURE';
        expect(lastUserMessage(request)).toContain(second);
        throw new Error('provider failed after rejected final');
      }
      const resumedTurn = retryTurn++;
      if (resumedTurn === 0) {
        expect(output(request, 'original-source-read')).toMatchObject({ content: 'First fact\n' });
        expect(output(request, 'preserved-import-write')).toMatchObject({ path: published, written: true });
        expect(JSON.stringify(request.body.input)).toContain('REJECTED_BEFORE_PROVIDER_FAILURE');
        expect(JSON.stringify(request.body.input)).toContain(savedFollowUp);
        return 'REJECTED_RETRY_WITH_STALE_READS';
      }
      if (resumedTurn === 1) {
        expect(lastUserMessage(request)).toContain(first);
        expect(lastUserMessage(request)).toContain(second);
        return { name: 'read_file', arguments: { path: second }, call_id: 'fresh-second' };
      }
      if (resumedTurn === 2) {
        expect(output(request, 'fresh-second')).toMatchObject({ content: 'Second fact\n' });
        return 'REJECTED_RETRY_WITH_ONLY_SECOND';
      }
      if (resumedTurn === 3) {
        expect(lastUserMessage(request)).toContain(first);
        expect(lastUserMessage(request)).not.toContain(second);
        return { name: 'read_file', arguments: { path: first }, call_id: 'fresh-first' };
      }
      expect(output(request, 'fresh-first')).toMatchObject({ content: 'First fact\n' });
      return 'Publish freshly reviewed resumed import';
    });
    await seedSources(f.repo, { [first]: 'First fact\n', [second]: 'Second fact\n' });
    f.jobs.start();
    const original = f.jobs.submit({ userId: 1, source: 'import', input: 'Integrate both assigned facts', requiredReads: [first, second] });
    const failed = await settled(f.jobs, original.id);
    expect(failed).toMatchObject({ status: 'failed', summary: null, error: expect.stringContaining('provider failed after rejected final') });
    expect(await f.repo.readFile(published)).toBeNull();
    const checkpoint = f.checkpoints.get(`job:${original.id}`)!;
    expect(checkpoint.text).not.toContain('REJECTED_BEFORE_PROVIDER_FAILURE');
    expect(checkpoint.input).toContainEqual(expect.objectContaining({
      role: 'assistant', content: expect.arrayContaining([expect.objectContaining({ text: 'REJECTED_BEFORE_PROVIDER_FAILURE' })]),
    }));
    const followUp = checkpoint.input.at(-1);
    expect(followUp).toMatchObject({ role: 'user', content: expect.stringContaining(second) });
    const savedFollowUp = JSON.stringify(followUp);
    retrying = true;
    const retry = f.jobs.retry(original.id);
    expect(f.checkpoints.get(`job:${original.id}`)).toBeUndefined();
    expect(f.checkpoints.get(`job:${retry.id}`)).toEqual(checkpoint);
    f.jobs.start();
    const succeeded = await settled(f.jobs, retry.id);
    expect(succeeded).toMatchObject({ status: 'succeeded', summary: 'Publish freshly reviewed resumed import' });
    expect(matter((await f.repo.readFile(published))!).content).toBe('# Imported knowledge\nBoth assigned facts.\n');
    expect(f.jobs.get(original.id)).toEqual(failed);
    expect(f.checkpoints.get(`job:${retry.id}`)).toBeUndefined();
  }, 20000);

  it('credits a child reading exact assigned sources without requiring parent duplicate reads', async () => {
    const path = 'raw/import/delegated.md';
    const published = 'wiki/delegated-import.md';
    let parentTurn = 0;
    let childTurn = 0;
    const f = await fixture((request) => {
      if (String(request.body.prompt_cache_key).includes(':subagent:')) {
        const turn = childTurn++;
        if (turn === 0) return { name: 'read_file', arguments: { path, offset: 2, limit: 2 }, call_id: 'child-tail' };
        if (turn === 1) {
          expect(output(request, 'child-tail')).toMatchObject({ content: 'Third fact\nFourth fact\n', truncated: false });
          return { name: 'read_file', arguments: { path, offset: 0, limit: 2 }, call_id: 'child-head' };
        }
        if (turn === 2) {
          expect(output(request, 'child-head')).toMatchObject({ content: 'First fact\nSecond fact\n', nextOffset: 2 });
          return { name: 'write_file', arguments: { path: published, content: note('# Delegated facts\nAll four source facts.\n') } };
        }
        return 'Reviewed and recorded all delegated facts';
      }
      const turn = parentTurn++;
      if (turn === 0) return { name: 'spawn_subagent', arguments: {
        name: 'Source reviewer', task: 'Read every assigned source page and record its facts',
        files: [published], sources: [path],
      }, call_id: 'source-child' };
      if (turn === 1) {
        expect(output(request, 'source-child')).not.toHaveProperty('error');
        return { name: 'wait_subagents', arguments: {}, call_id: 'source-child-wait' };
      }
      expect(output(request, 'source-child-wait')).toMatchObject({
        settled: [expect.objectContaining({ status: 'completed', sources: [path] })], running: [], timedOut: false,
      });
      return 'Publish delegated import';
    });
    await seedSources(f.repo, { [path]: 'First fact\nSecond fact\nThird fact\nFourth fact\n' });
    f.jobs.start();
    const job = f.jobs.submit({ userId: 1, source: 'import', input: 'Delegate assigned source review', requiredReads: [path] });
    const result = await settled(f.jobs, job.id);
    expect(result).toMatchObject({ status: 'succeeded', summary: 'Publish delegated import' });
    expect(matter((await f.repo.readFile(published))!).content).toBe('# Delegated facts\nAll four source facts.\n');
    expect(f.checkpoints.get(`job:${job.id}`)).toBeUndefined();
  }, 20000);

  it('reports unread assigned sources when the write attempt exhausts its turn budget', async () => {
    const path = 'raw/import/never-read.md';
    let turns = 0;
    const f = await fixture(() => {
      turns++;
      return { name: 'list_files', arguments: { prefix: 'raw/import/' } };
    });
    await seedSources(f.repo, { [path]: 'A fact that must be reviewed.\n' });
    const mainBefore = await f.repo.headSha();
    f.jobs.start();
    const job = f.jobs.submit({ userId: 1, source: 'import', input: 'Read the assigned source', requiredReads: [path] });
    const result = await settled(f.jobs, job.id);
    expect(result).toMatchObject({ status: 'failed', summary: null, mergeSha: null, error: `unread assigned sources: 1/1 (${path})` });
    expect(turns).toBe(96);
    expect(await f.repo.headSha()).toBe(mainBefore);
  }, 20000);

  it('warns a read-only parent once with twelve turns left and restarts the count on resume', async () => {
    const warning = '이번 부모 쓰기 실행의 남은 모델 턴은 12턴이다. 새 탐색을 중단하고 이미 읽은 자료로 노트를 작성·확장한다. 실행 중인 서브에이전트는 wait_subagents로 종료를 기다리고 실제 변경 파일을 한 번 검토한 뒤 즉시 commit으로 커밋하고 마지막 요약을 응답한다.';
    let retrying = false;
    let turns = 0;
    let originalInstructions: unknown;
    const f = await fixture((request) => {
      const messages = request.body.input as Array<{ role?: string; content?: unknown }>;
      const warnings = messages.filter(message => message.role === 'user' && String(message.content).includes('남은 모델 턴은'));
      if (!retrying) {
        expect(warnings).toEqual([]);
        originalInstructions ??= request.body.instructions;
        if (turns++ === 2) throw new Error('provider interrupted before budget warning');
      } else {
        const turn = turns++;
        expect(request.body.instructions).toBe(originalInstructions);
        expect(warnings).toEqual(turn < 84 ? [] : [{ role: 'user', content: warning }]);
      }
      return { name: 'read_file', arguments: { path: 'index.md' } };
    });
    f.jobs.start();
    const original = f.jobs.submit({ userId: 1, source: 'mcp', input: 'Inspect notes before writing' });
    expect(await settled(f.jobs, original.id)).toMatchObject({
      status: 'failed', error: expect.stringContaining('provider interrupted before budget warning'),
    });
    expect(turns).toBe(3);
    retrying = true;
    turns = 0;
    const retry = f.jobs.retry(original.id);
    f.jobs.start();
    expect(await settled(f.jobs, retry.id)).toMatchObject({
      status: 'failed', summary: null, mergeSha: null,
      error: 'Dony exceeded maxTurns (96) before finishing',
    });
    expect(turns).toBe(96);
  }, 20000);

  it.each(['missing', 'denied'] as const)('does not credit a %s read_file result as assigned-source coverage', async (kind) => {
    const path = `raw/import/${kind}.md`;
    const published = 'wiki/unread-import.md';
    const f = await fixture(async (request, turn) => {
      if (turn === 0) {
        if (kind === 'denied') {
          const admin = await f.users.create({ email: 'coverage-admin@example.test', role: 'admin' });
          f.acl.create({ prefix: path, subjectType: 'everyone', subject: '', access: 'none' }, admin);
        }
        return { functionCalls: [
          { name: 'read_file', arguments: { path }, call_id: 'failed-source-read' },
          { name: 'write_file', arguments: { path: published, content: 'Unreviewed facts must not merge.\n' } },
        ] };
      }
      if (turn === 1) {
        if (kind === 'missing') expect(output(request, 'failed-source-read')).toMatchObject({ content: null });
        else {
          expect(output(request, 'failed-source-read')).toHaveProperty('error');
          expect(JSON.stringify(request.body.input)).not.toContain('HIDDEN_ASSIGNED_FACT');
        }
      }
      return 'Publish without a successful source read';
    });
    if (kind === 'denied') {
      await seedSources(f.repo, { [path]: 'HIDDEN_ASSIGNED_FACT\n' });
    }
    const mainBefore = await f.repo.headSha();
    f.jobs.start();
    const job = f.jobs.submit({ userId: 1, source: 'import', input: 'Review the assigned source', requiredReads: [path] });
    const result = await settled(f.jobs, job.id);
    expect(result).toMatchObject({ status: 'failed', summary: null, mergeSha: null, error: `unread assigned sources: 1/1 (${path})` });
    expect(await f.repo.readFile(published)).toBeNull();
    expect(await f.repo.headSha()).toBe(mainBefore);
  }, 20000);

  it.each(['none', 'child', 'conflict'] as const)('records parent, child and conflict usage with %s failing', async (failure) => {
    let parentTurn = 0;
    let childTurn = 0;
    let conflictTurn = 0;
    const f = await fixture(async (request) => {
      const lane = String(request.body.prompt_cache_key);
      if (lane.includes(':subagent:')) {
        const usage = { inputTokens: 30, cachedInputTokens: 10, outputTokens: 8, reasoningTokens: 2 };
        return childTurn++ === 0
          ? { functionCalls: [{ name: 'write_file', arguments: { path: 'wiki/child.md', content: note('delegated fact\n') } }], usage }
          : { text: 'Child finished', usage, status: failure === 'child' ? 'failed' : 'completed' };
      }
      if (lane.includes(':conflict:')) {
        const usage = { inputTokens: 50, cachedInputTokens: 20, outputTokens: 10, reasoningTokens: 3 };
        return conflictTurn++ === 0
          ? { functionCalls: [{ name: 'write_file', arguments: { path: 'wiki/shared.md', content: note('requested fact\nconcurrent fact\n') } }], usage }
          : { text: 'Conflict resolved', usage, status: failure === 'conflict' ? 'failed' : 'completed' };
      }
      const usage = { inputTokens: 100, cachedInputTokens: 50, outputTokens: 20, reasoningTokens: 4 };
      const turn = parentTurn++;
      if (turn === 0) return { functionCalls: [{ name: 'spawn_subagent', arguments: { name: 'Writer', task: 'Record delegated fact', files: ['wiki/child.md'] } }], usage };
      if (turn === 1) return { functionCalls: [{ name: 'wait_subagents', arguments: {} }], usage };
      if (turn === 2) return { functionCalls: [{ name: 'write_file', arguments: { path: 'wiki/shared.md', content: note('requested fact\n') } }], usage };
      const concurrent = await f.repo.createWorktree('concurrent');
      try {
        await concurrent.write('wiki/shared.md', note('concurrent fact\n'));
        await concurrent.commit('Concurrent fact', author);
        await f.repo.withMergeLock(() => concurrent.fastForwardMain());
      } finally {
        await concurrent.dispose();
      }
      return { text: 'Record combined knowledge', usage };
    });
    const baseline = await f.repo.createWorktree('baseline');
    await baseline.write('wiki/shared.md', note('original fact\n'));
    await baseline.commit('Baseline shared fact', author);
    await f.repo.withMergeLock(() => baseline.fastForwardMain());
    await baseline.dispose();
    f.jobs.start();
    const job = f.jobs.submit({ userId: 1, source: 'mcp', input: 'Record independent facts' });
    const result = await settled(f.jobs, job.id);
    const usage = { inputTokens: 560, cachedInputTokens: 260, outputTokens: 116, reasoningTokens: 26 };
    expect(result.status).toBe(failure === 'conflict' ? 'failed' : 'succeeded');
    if (failure === 'conflict') {
      expect(matter((await f.repo.readFile('wiki/shared.md'))!).content).toBe('concurrent fact\n');
      expect(f.jobs.events(job.id).at(-1)).toMatchObject({ phase: 'failed', detail: { usage, error: result.error } });
      expect(f.logs.find(log => log.msg === 'Write job failed' && log.jobId === job.id)).toMatchObject({ usage });
    } else {
      expect(matter((await f.repo.readFile('wiki/child.md'))!).content).toBe('delegated fact\n');
      expect(matter((await f.repo.readFile('wiki/shared.md'))!).content).toBe('requested fact\nconcurrent fact\n');
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
    const content = note('# Preserved knowledge\nThe completed tool turn survives provider failure.\n');
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
    expect(matter((await f.repo.readFile(path))!).content).toBe('# Preserved knowledge\nThe completed tool turn survives provider failure.\n');
    expect((await f.repo.show(succeeded.commits[0]!)).commit.trailers['Wiki-Job']).toBe(retry.id);
    expect(f.jobs.get(original.id)).toEqual(failed);
    expect(f.checkpoints.get(`job:${original.id}`)).toBeUndefined();
    expect(f.checkpoints.get(`job:${retry.id}`)).toBeUndefined();
  }, 20000);

  it('retries from failed committed history even when no model checkpoint remains', async () => {
    let retrying = false;
    let retryTurns = 0;
    const path = 'wiki/already-committed.md';
    const content = note('# Prior commit\nThis work must not be recreated or lost.\n');
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
    expect(matter((await f.repo.readFile(path, `refs/wiki/failed/${original.id}`))!).content).toBe('# Prior commit\nThis work must not be recreated or lost.\n');
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
    expect(output(requests[firstRetryRequest + 1]!, 'committed-file')).toMatchObject({ path, content: expect.stringContaining('# Prior commit\nThis work must not be recreated or lost.\n') });
    expect(succeeded.commits).toContain(priorCommit);
    expect(matter((await f.repo.readFile(path))!).content).toBe('# Prior commit\nThis work must not be recreated or lost.\n');
    await git('git', ['merge-base', '--is-ancestor', priorCommit, 'main'], { cwd: join(f.dir, 'knowledge') });
    expect((await f.repo.show(priorCommit)).commit.trailers['Wiki-Job']).toBe(original.id);
    expect(f.checkpoints.get(`job:${retry.id}`)).toBeUndefined();
  }, 20000);

  it('recovers an interrupted worktree and resumes its saved tool context after startup', async () => {
    let retrying = false;
    let retryTurns = 0;
    const path = 'wiki/interrupted.md';
    const content = note('# Interrupted knowledge\nUncommitted work survives engine startup.\n');
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
    expect(matter((await reopenedRepo.readFile(path))!).content).toBe('# Interrupted knowledge\nUncommitted work survives engine startup.\n');
    expect(f.checkpoints.get(`job:${original.id}`)).toBeUndefined();
    expect(f.checkpoints.get(`job:${retry.id}`)).toBeUndefined();
  }, 20000);

  it('keeps the failed job checkpoint when persisting the retry event fails atomically', async () => {
    let retrying = false;
    const path = 'wiki/atomic-retry.md';
    const content = note('# Atomic retry\nA failed enqueue must leave this work retryable.\n');
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
    expect(matter((await f.repo.readFile(path))!).content).toBe('# Atomic retry\nA failed enqueue must leave this work retryable.\n');
    expect(f.checkpoints.get(`job:${retry.id}`)).toBeUndefined();
  }, 20000);
});
