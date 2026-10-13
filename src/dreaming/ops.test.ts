import { execFile } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import Database from 'better-sqlite3';
import matter from 'gray-matter';
import pino from 'pino';
import { afterEach, expect, it, vi } from 'vitest';
import { AclService } from '../acl/acl.service.js';
import { AuditService } from '../audit/audit.service.js';
import { UsersService } from '../auth/users.service.js';
import { UsersRepository } from '../auth/users.repository.js';
import { newId, toStorageId } from '../common/ids.js';
import { loadConfig } from '../config.js';
import { EventsService } from '../events/events.service.js';
import type { WikiEvent } from '../events/events.types.js';
import { KnowledgeRepo, type Worktree } from '../knowledge/repo.js';
import { AgentService } from '../agent/agent.service.js';
import type { RunAgentOptions } from '../agent/agent.types.js';
import { makeWorktreeTools } from '../agent/worktree.js';
import type { CatalogService } from '../rag/catalog.service.js';
import type { ComparisonService } from '../rag/comparison.service.js';
import type { IndexerService } from '../rag/indexer.service.js';
import type { SearchService } from '../rag/search.service.js';
import type { DreamRun } from './dream-run.types.js';
import { DreamRunsRepository } from './dream-runs.repository.js';
import { DreamingService } from './dreaming.service.js';

const git = promisify(execFile);

function wikiNote(body: string, type: 'note' | 'hub' = 'note'): string {
  return `---\ntype: ${type}\naliases: []\ndescription: "꿈꾸기 작업의 동작을 점검하는 테스트 지식 노트다."\ntags: [dreaming-ops]\n---\n${body}`;
}

const resources: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of resources.splice(0).reverse()) await cleanup();
});

async function database() {
  const db = new Database(':memory:');
  resources.push(() => { db.close(); });
  for (const migration of ['001_core', '002_auth', '005_dreaming', '008_ops', '011_platform', '013_acl', '021_dream_modes', '027_user_passwords']) db.exec(await readFile(new URL(`../db/migrations/${migration}.sql`, import.meta.url), 'utf8'));
  db.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT, created_at TEXT, learned_at TEXT)');
  return { db, runs: new DreamRunsRepository(db) };
}

function runRecord(id: string, startedAt: string): DreamRun {
  return {
    id, startedAt, finishedAt: null, status: 'running', fromSha: null, toSha: null,
    mergeSha: null, pushed: false, summary: null, changedPaths: [], journalPath: null,
    mode: null, focus: null, structuralChanges: [],
    error: null, push: { status: 'pending', remote: null, sha: null, at: null, reason: null },
  };
}

async function fixture(slackWebhookUrl?: string, openaiBaseUrl?: string) {
  const root = await mkdtemp(join(tmpdir(), 'dream-ops-'));
  resources.push(() => rm(root, { recursive: true, force: true }));
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: root, SLACK_WEBHOOK_URL: slackWebhookUrl,
    ...(openaiBaseUrl ? { OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: openaiBaseUrl, OPENAI_MAX_RETRIES: '0' } : {}) });
  const logs: Record<string, unknown>[] = [];
  const log = pino({ level: 'info' }, { write: line => { logs.push(JSON.parse(line)); } });
  const warn = vi.spyOn(log, 'warn');
  const repo = await KnowledgeRepo.open(config, log);
  const { db, runs } = await database();
  db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, NULL)')
    .run(toStorageId(newId()), toStorageId(newId()), 'user', 'SECRET_USER_INPUT', '2020-01-01T00:00:00.000Z');
  const events = new EventsService();
  const seen: WikiEvent[] = [];
  events.subscribe((event) => seen.push(event));
  const runAgent = vi.fn(async (options: RunAgentOptions) => {
    const input = JSON.parse(options.input as string) as { date: string };
    await options.tools.find((tool) => tool.name === 'write_file')!.run({ path: `journal/${input.date}.md`, content: '# SECRET_NOTE_CONTENT\n' });
    await options.tools.find((tool) => tool.name === 'write_file')!.run({ path: 'wiki/result.md', content: wikiNote('# Reviewed knowledge\n') });
    return { text: 'SECRET_SUMMARY', toolCalls: 2 };
  });
  const agent = {
    baseInstructions: async () => 'Review facts.', runAgent,
    worktreeTools: (wt: Worktree, author: { name: string; email: string }) => {
      return makeWorktreeTools(search, wt, author, acl);
    },
    resolveConflicts: async () => { throw new Error('Unexpected conflict'); },
  } as unknown as AgentService;
  const indexer = { syncToHead: async () => ({ indexedSha: await repo.headSha() }) } as unknown as IndexerService;
  const search = { search: async () => [] } as unknown as SearchService;
  const catalog = { graph: () => ({ nodes: [], edges: [] }) } as unknown as CatalogService;
  const comparison = { duplicates: () => [] } as unknown as ComparisonService;
  const audit = new AuditService(db);
  const acl = new AclService(db, new UsersService(new UsersRepository(db)), audit);
  const serviceAgent = openaiBaseUrl ? new AgentService(config, log, repo, search, acl) : agent;
  const dreaming = new DreamingService(repo, serviceAgent, indexer, search, config, log, runs, events, acl, audit, catalog, comparison);
  const other = new DreamingService(repo, serviceAgent, indexer, search, config, log, runs, events, acl, audit, catalog, comparison);
  return { root, repo, runs, db, dreaming, other, config, runAgent, events, seen, warn, logs };
}

@Module({})
class DreamingStartupTestModule {}

it('recovers orphan runs at explicit HTTP startup even with autostart disabled and preserves backup history', async () => {
  const f = await fixture();
  f.config.jobsAutostart = false;
  const interrupted = ['pending', 'succeeded', 'skipped', 'failed'].map((status) => {
    const run = runRecord(newId(), '2020-01-01T00:00:00.000Z');
    run.toSha = 'captured-input';
    run.mergeSha = 'locally-merged';
    run.summary = 'Preserved local work';
    run.push = { status: status as DreamRun['push']['status'], remote: 'origin', sha: 'backup-sha',
      at: '2020-01-01T00:01:00.000Z', reason: 'Preserved backup reason' };
    run.pushed = status === 'succeeded';
    f.runs.create(run);
    f.runs.finish(run);
    return run;
  });
  const completed = runRecord(newId(), '2020-01-02T00:00:00.000Z');
  Object.assign(completed, { status: 'succeeded', finishedAt: '2020-01-02T00:01:00.000Z' });
  f.runs.create(completed);
  f.runs.finish(completed);
  const app = await NestFactory.createApplicationContext({
    module: DreamingStartupTestModule,
    providers: [{ provide: DreamingService, useValue: f.dreaming }],
  }, { logger: false });
  resources.push(() => app.close());
  app.get(DreamingService).recoverInterrupted();
  for (const run of interrupted) {
    const recovered = f.runs.get(run.id)!;
    expect(recovered).toEqual({ ...run, status: 'failed', finishedAt: expect.any(String),
      error: expect.stringMatching(/interrupted.*restart/i) });
    expect(Date.parse(recovered.finishedAt!)).toBeGreaterThan(Date.parse(run.startedAt));
  }
  expect(f.runs.get(completed.id)).toEqual(completed);
  expect(f.runs.running()).toBeNull();
  const failedEvents = interrupted.map(run => ({ type: 'dream.updated', runId: run.id, status: 'failed' }));
  expect(f.seen).toEqual(expect.arrayContaining(failedEvents));
  expect(f.seen).toHaveLength(interrupted.length);
  const recoveryEvents = [...f.seen];
  const second = await NestFactory.createApplicationContext({
    module: DreamingStartupTestModule,
    providers: [{ provide: DreamingService, useValue: f.other }],
  }, { logger: false });
  resources.push(() => second.close());
  second.get(DreamingService).recoverInterrupted();
  expect(f.seen).toEqual(recoveryEvents);
  expect(f.runAgent).not.toHaveBeenCalled();
  const manual = await f.dreaming.runManual();
  expect(manual.status).toBe('succeeded');
});

it('opening a CLI context does not recover another process running dream', async () => {
  const f = await fixture();
  // A live HTTP process is not represented in this CLI context's WeakMap.
  const httpRun = runRecord(newId(), new Date().toISOString());
  f.runs.create(httpRun);
  const cli = await NestFactory.createApplicationContext({
    module: DreamingStartupTestModule,
    providers: [{ provide: DreamingService, useValue: f.dreaming }],
  }, { logger: false });
  resources.push(() => cli.close());
  expect(f.runs.get(httpRun.id)).toEqual(httpRun);
  expect(f.seen).toEqual([]);
  expect(f.runAgent).not.toHaveBeenCalled();
});

it('does not let a stale persisted running row block a manual run', async () => {
  const f = await fixture();
  const stale = runRecord(newId(), '2020-01-01T00:00:00.000Z');
  f.runs.create(stale);
  const manual = await f.dreaming.runManual();
  expect(manual.status).toBe('succeeded');
  expect(f.runs.get(stale.id)?.status).toBe('running');
});

it.each([false, true])('schedules only when jobsAutostart is enabled (%s)', async (enabled) => {
  const f = await fixture();
  f.config.jobsAutostart = enabled;
  f.config.dreamCron = '* * * * * *';
  const runOnce = vi.spyOn(f.dreaming, 'runOnce');
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-08T00:00:00.000Z'));
  try {
    f.dreaming.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runOnce).toHaveBeenCalledTimes(enabled ? 1 : 0);
    const run = enabled ? await runOnce.mock.results[0].value : await f.dreaming.runManual();
    expect(run).toMatchObject({ status: 'succeeded', error: null });
    expect(f.runs.get(run.id)).toEqual(run);
    expect(await f.repo.readFile('wiki/result.md')).toBe('# Reviewed knowledge\n');
  } finally {
    await f.dreaming.stop();
    vi.useRealTimers();
  }
});

async function webhook(handler: (body: string) => number) {
  const server: Server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk.toString();
    response.writeHead(handler(body)).end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  resources.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing webhook port');
  return `http://127.0.0.1:${address.port}/`;
}

it.each(['none', 'provider', 'dreaming', 'conflict'] as const)('logs aggregate dreaming and conflict usage with %s failing', async (failure) => {
  interface Request { path: string; body: Record<string, unknown> }
  type Turn = ({ text: string } | { functionCalls: Array<{ name: string; arguments: Record<string, unknown> }> }) & {
    usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number };
    status?: 'completed' | 'failed';
  };
  // A static import would pull the shared test provider outside the production TypeScript root.
  const { startFakeOpenAI }: {
    startFakeOpenAI(responder: (request: Request) => Promise<Turn>): Promise<{ url: string; close(): Promise<void> }>;
  } = await import(new URL('../../test/fake-openai.ts', import.meta.url).href);
  let dreamTurn = 0;
  let conflictTurn = 0;
  const author = { name: 'Test', email: 'test@example.test' };
  const fake = await startFakeOpenAI(async (request) => {
    if (String(request.body.prompt_cache_key).includes(':conflict:')) {
      if (conflictTurn++ === 0) return {
        functionCalls: [{ name: 'write_file', arguments: { path: 'wiki/shared.md', content: wikiNote('reviewed fact\nconcurrent fact\n') } }],
        usage: { inputTokens: 50, cachedInputTokens: 20, outputTokens: 10, reasoningTokens: 3 },
      };
      return { text: 'Conflict resolved', status: failure === 'conflict' ? 'failed' : 'completed',
        usage: { inputTokens: 60, cachedInputTokens: 30, outputTokens: 12, reasoningTokens: 4 } };
    }
    if (failure === 'provider') throw new Error('Provider unavailable before usage');
    if (dreamTurn++ === 0) {
      const first = (request.body.input as Array<{ content: string }>)[0]!;
      const { journalPath } = JSON.parse(first.content) as { journalPath: string };
      return {
        functionCalls: [
          { name: 'write_file', arguments: { path: journalPath, content: '# Reviewed knowledge\n' } },
          { name: 'write_file', arguments: { path: 'wiki/shared.md', content: wikiNote('reviewed fact\n') } },
        ],
        status: failure === 'dreaming' ? 'failed' : 'completed',
        usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningTokens: 5 },
      };
    }
    const concurrent = await f.repo.createWorktree('concurrent-dream');
    try {
      await concurrent.write('wiki/shared.md', wikiNote('concurrent fact\n'));
      await concurrent.commit('Concurrent fact', author);
      await f.repo.withMergeLock(() => concurrent.fastForwardMain());
    } finally {
      await concurrent.dispose();
    }
    return { text: 'Reviewed knowledge', usage: { inputTokens: 120, cachedInputTokens: 70, outputTokens: 25, reasoningTokens: 7 } };
  });
  resources.push(() => fake.close());
  const f = await fixture(undefined, fake.url);
  const baseline = await f.repo.createWorktree('baseline-dream');
  await baseline.write('wiki/shared.md', wikiNote('original fact\n'));
  await baseline.commit('Baseline shared fact', author);
  await f.repo.withMergeLock(() => baseline.fastForwardMain());
  await baseline.dispose();
  const run = await f.dreaming.runOnce();
  const usage = failure === 'provider'
    ? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 }
    : failure === 'dreaming'
      ? { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningTokens: 5 }
      : { inputTokens: 330, cachedInputTokens: 160, outputTokens: 67, reasoningTokens: 19 };
  expect(run.status).toBe(failure === 'none' ? 'succeeded' : 'failed');
  expect(f.logs.find(log => log.runId === run.id && log.msg === (failure === 'none' ? 'Dreaming completed' : 'Dreaming failed')))
    .toMatchObject({ usage });
  expect(f.runs.get(run.id)).toEqual(run);
  expect(run.summary).toBe(failure === 'provider' || failure === 'dreaming' ? null : 'Reviewed knowledge');
  expect(matter((await f.repo.readFile('wiki/shared.md'))!).content).toBe(failure === 'none'
    ? 'reviewed fact\nconcurrent fact\n'
    : failure === 'conflict' ? 'concurrent fact\n' : 'original fact\n');
}, 20000);

it('logs zero usage when no inputs or wiki folders require a model run', async () => {
  const f = await fixture();
  f.db.prepare('DELETE FROM messages').run();
  const run = await f.dreaming.runOnce();
  expect(run).toMatchObject({ status: 'succeeded', mode: null, summary: null, journalPath: null });
  expect(f.logs.find(log => log.msg === 'Dreaming completed' && log.runId === run.id)).toMatchObject({
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
  });
});

it('persists completed details and pages tied timestamps without losing rows', async () => {
  const { runs } = await database();
  expect(runs.latest()).toBeNull();
  expect(runs.running()).toBeNull();
  expect(runs.backupStatus()).toEqual({ lastAttempt: null, lastSuccess: null });
  const first = runRecord('0000000000000000000001', '2026-10-01T00:00:00.000Z');
  runs.create(first);
  expect(runs.running()).toEqual(first);
  Object.assign(first, {
    status: 'succeeded', finishedAt: '2026-10-01T00:01:00.000Z', summary: '검토 완료',
    fromSha: 'base', toSha: 'input', mergeSha: 'merged', changedPaths: ['wiki/a.md', 'journal/2026-10-01.md'],
    journalPath: 'journal/2026-10-01.md', pushed: true,
    mode: 'sweep', focus: 'wiki/topic/',
    structuralChanges: [{ kind: 'move', from: 'wiki/topic/old.md', to: 'wiki/topic/new.md' }],
    push: { status: 'succeeded', remote: 'origin', sha: 'merged', at: '2026-10-01T00:01:00.000Z', reason: null },
  });
  runs.finish(first);
  const second = runRecord('0000000000000000000002', first.startedAt);
  runs.create(second);
  Object.assign(second, { status: 'failed', finishedAt: '2026-10-01T00:02:00.000Z', error: 'offline',
    push: { status: 'failed', remote: null, sha: null, at: '2026-10-01T00:02:00.000Z', reason: 'offline' } });
  runs.finish(second);
  const third = runRecord('0000000000000000000003', '2026-10-02T00:00:00.000Z');
  runs.create(third);
  expect(runs.list({ limit: 2 })).toEqual([third, second]);
  expect(runs.list({ before: second.id, limit: 2 })).toEqual([first]);
  expect(runs.list({ before: '2026-10-02T00:00:00.000Z' })).toEqual([second, first]);
  expect(runs.get(first.id)).toEqual(first);
  expect(runs.get('00000000-0000-0000-0000-000000000001')).toEqual(first);
  expect(runs.list({ before: 'missing' })).toEqual([]);
  expect(runs.get('missing')).toBeNull();
  expect(runs.latest()).toEqual(third);
  expect(runs.running()).toEqual(third);
  expect(runs.backupStatus()).toEqual({ lastAttempt: second, lastSuccess: first });
});

it('rejects manual overlap across service instances but preserves CLI coalescing', async () => {
  const f = await fixture();
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = f.runAgent.getMockImplementation()!;
  f.runAgent.mockImplementationOnce(async (options) => { enter(); await gate; return original(options); });
  const first = f.dreaming.runManual();
  await entered;
  try {
    const app = await NestFactory.createApplicationContext({
      module: DreamingStartupTestModule,
      providers: [{ provide: DreamingService, useValue: f.other }],
    }, { logger: false });
    resources.push(() => app.close());
    app.get(DreamingService).recoverInterrupted();
    expect(f.runs.running()?.status).toBe('running');
    expect(f.seen).toEqual([{ type: 'dream.updated', runId: f.runs.running()!.id, status: 'running' }]);
    await expect(f.other.runManual()).rejects.toMatchObject({ status: 409, code: 'dream_running' });
    expect(f.other.runOnce()).toBe(first);
    expect(f.runs.list().map((run) => run.id)).toEqual([f.runs.running()!.id]);
  } finally {
    release();
  }
  const run = await first;
  expect(run.status).toBe('succeeded');
  expect(f.runs.running()).toBeNull();
  expect(f.runs.list()).toEqual([run]);
});

it('merges real files, persists summary and paths, and notifies only safe durable metadata', async () => {
  let runs: DreamRunsRepository;
  const payloads: string[] = [];
  let durable: DreamRun | null = null;
  const url = await webhook((body) => { payloads.push(body); durable = runs.latest(); return 200; });
  const f = await fixture(url);
  runs = f.runs;
  const run = await f.dreaming.runManual();
  expect(f.runs.get(run.id)).toEqual(run);
  expect(durable).toEqual(run);
  expect(run).toMatchObject({ status: 'succeeded', summary: 'SECRET_SUMMARY', pushed: false,
    changedPaths: [run.journalPath, 'wiki/result.md'], push: { status: 'skipped', sha: null, remote: null } });
  expect(await f.repo.readFile(run.journalPath!)).toBe('# SECRET_NOTE_CONTENT\n');
  expect((await f.repo.show(run.mergeSha!)).commit.trailers).toMatchObject({ 'Wiki-Job': run.id, 'Wiki-Source': 'dreaming' });
  expect(f.seen).toEqual([
    { type: 'dream.updated', runId: run.id, status: 'running' },
    { type: 'main.updated', sha: run.mergeSha, paths: run.changedPaths },
    { type: 'dream.updated', runId: run.id, status: 'succeeded' },
  ]);
  const notification = JSON.parse(payloads[0]) as { text: string };
  expect(notification.text).toMatch(/^Dreaming succeeded; duration_ms=\d+; merge_sha=[a-f0-9]+; push=skipped; push_sha=none$/);
  expect(payloads).toEqual([JSON.stringify(notification)]);
  expect(payloads[0]).not.toContain('SECRET');
  expect(payloads[0]).not.toContain('wiki/result.md');
});

it('logs Slack HTTP errors without changing the successful durable run', async () => {
  const url = await webhook(() => 503);
  const f = await fixture(url);
  const run = await f.dreaming.runOnce();
  expect(run.status).toBe('succeeded');
  expect(run.error).toBeNull();
  expect(f.runs.get(run.id)).toEqual(run);
  expect(f.warn).toHaveBeenCalledWith(expect.objectContaining({ runId: run.id }), 'Dreaming Slack notification failed');
});

it('notifies failure without disclosing agent errors or input', async () => {
  const payloads: string[] = [];
  const url = await webhook((body) => { payloads.push(body); return 200; });
  const f = await fixture(url);
  f.runAgent.mockRejectedValueOnce(new Error('SECRET_AGENT_ERROR'));
  const run = await f.dreaming.runOnce();
  expect(run.status).toBe('failed');
  expect(f.runs.get(run.id)?.error).toBe('SECRET_AGENT_ERROR');
  expect(JSON.parse(payloads[0]).text).toMatch(/^Dreaming failed; duration_ms=\d+; merge_sha=none; push=skipped; push_sha=none$/);
  expect(payloads[0]).not.toContain('SECRET');
  expect(f.seen).toEqual([
    { type: 'dream.updated', runId: run.id, status: 'running' },
    { type: 'dream.updated', runId: run.id, status: 'failed' },
  ]);
});

it('records actual remote and SHA when backup succeeds despite maintenance failure', async () => {
  const f = await fixture();
  const remote = join(f.root, 'origin.git');
  await git('git', ['init', '--bare', remote]);
  await git('git', ['remote', 'add', 'origin', remote], { cwd: join(f.root, 'knowledge') });
  f.runAgent.mockRejectedValueOnce(new Error('maintenance failed'));
  const run = await f.dreaming.runOnce();
  const sha = await f.repo.headSha();
  expect(run).toMatchObject({ status: 'failed', pushed: true,
    push: { status: 'succeeded', remote: 'origin', sha, reason: null } });
  expect((await git('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/main'])).stdout.trim()).toBe(sha);
  expect(f.runs.get(run.id)).toEqual(run);
  expect(f.runs.backupStatus()).toEqual({ lastAttempt: run, lastSuccess: run });
});

it('keeps local success but persists backup failure and sends a private success notification', async () => {
  const payloads: string[] = [];
  const url = await webhook((body) => { payloads.push(body); return 200; });
  const f = await fixture(url);
  await git('git', ['remote', 'add', 'origin', join(f.root, 'SECRET_MISSING_REMOTE')], { cwd: join(f.root, 'knowledge') });
  const run = await f.dreaming.runOnce();
  expect(run).toMatchObject({ status: 'succeeded', error: null, pushed: false, summary: 'SECRET_SUMMARY',
    push: { status: 'failed', remote: null, sha: null } });
  expect(run.push.reason).toContain('SECRET_MISSING_REMOTE');
  expect(matter((await f.repo.readFile('wiki/result.md'))!).content).toBe('# Reviewed knowledge\n');
  expect(f.runs.get(run.id)).toEqual(run);
  expect(f.runs.backupStatus()).toEqual({ lastAttempt: run, lastSuccess: null });
  expect(JSON.parse(payloads[0]).text).toMatch(/^Dreaming succeeded; duration_ms=\d+; merge_sha=[a-f0-9]+; push=failed; push_sha=none$/);
  expect(payloads[0]).not.toContain('SECRET');
});

it('keeps the checkpoint on a backup-only run despite real Git push failure', async () => {
  const f = await fixture();
  f.db.prepare('DELETE FROM messages').run();
  await git('git', ['remote', 'add', 'origin', join(f.root, 'missing-backup.git')], { cwd: join(f.root, 'knowledge') });
  const sha = await f.repo.headSha();
  const run = await f.dreaming.runOnce();
  expect(run).toMatchObject({ status: 'succeeded', error: null, mode: null, toSha: sha,
    mergeSha: null, push: { status: 'failed' } });
  expect(run.push.reason).toContain('missing-backup.git');
  expect(f.runs.lastSuccessfulCheckpoint()).toBe(sha);
  expect(f.runAgent).not.toHaveBeenCalled();
  expect(f.runs.get(run.id)).toEqual(run);
  const next = await f.dreaming.runManual();
  expect(next).toMatchObject({ status: 'succeeded', error: null, mode: null, fromSha: sha, toSha: sha });
});

it('preserves the genuine maintenance error when backup also fails', async () => {
  const f = await fixture();
  f.runAgent.mockRejectedValueOnce(new Error('Maintenance unavailable'));
  await git('git', ['remote', 'add', 'origin', join(f.root, 'missing-backup.git')], { cwd: join(f.root, 'knowledge') });
  const run = await f.dreaming.runOnce();
  expect(run).toMatchObject({ status: 'failed', error: 'Maintenance unavailable', push: { status: 'failed' } });
  expect(run.push.reason).toContain('missing-backup.git');
  expect(f.runs.lastSuccessfulCheckpoint()).toBeUndefined();
  expect(f.runs.unlearnedUserMessages(run.startedAt)).toMatchObject([{ content: 'SECRET_USER_INPUT' }]);
});

it('rejects synchronous manual reentry from the start event without creating a second run', async () => {
  const f = await fixture();
  let rejection: Promise<void> | undefined;
  f.events.subscribe((event) => {
    if (event.type === 'dream.updated' && event.status === 'running') {
      rejection = expect(f.other.runManual()).rejects.toMatchObject({ status: 409, code: 'dream_running' });
    }
  });
  const run = await f.dreaming.runManual();
  await rejection;
  expect(f.runs.list()).toEqual([run]);
});

it('keeps content edited after capture unlearned while acknowledging unchanged captured messages', async () => {
  const { db, runs } = await database();
  const edited = '0000000000000000000001';
  const unchanged = '0000000000000000000002';
  const conversation = newId();
  const insert = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, NULL)');
  insert.run(toStorageId(edited), toStorageId(conversation), 'user', 'Captured original', '2026-10-01T00:00:00.000Z');
  insert.run(toStorageId(unchanged), toStorageId(conversation), 'user', 'Unchanged captured fact', '2026-10-01T00:00:00.000Z');
  const captured = runs.unlearnedUserMessages('2026-10-01T01:00:00.000Z');
  db.prepare('UPDATE messages SET content = ? WHERE id = ?').run('New unseen content', toStorageId(edited));
  const learnedAt = '2026-10-01T02:00:00.000Z';
  runs.markLearned(captured, learnedAt);
  expect(db.prepare('SELECT id, learned_at FROM messages ORDER BY id').all()).toEqual([
    { id: toStorageId(edited), learned_at: null },
    { id: toStorageId(unchanged), learned_at: learnedAt },
  ]);
  expect(runs.unlearnedUserMessages('2026-10-01T03:00:00.000Z')).toEqual([
    { id: edited, conversation_id: conversation, content: 'New unseen content', created_at: '2026-10-01T00:00:00.000Z' },
  ]);
});

it('runs an idle night sweep in the least recently reviewed wiki folder', async () => {
  const f = await fixture();
  f.db.prepare('DELETE FROM messages').run();
  const wt = await f.repo.createWorktree('idle-seed');
  const author = { name: 'Test', email: 'test@example.test' };
  await wt.write('wiki/topic/a.md', wikiNote('# Topic\n\nA unique fact.\n'));
  await wt.write('wiki/topic/index.md', wikiNote('[[wiki/topic/a]]\n', 'hub'));
  await wt.write('index.md', '[[wiki/topic/index]]\n');
  await wt.commit('Seed sweep folder', author);
  await f.repo.withMergeLock(() => wt.fastForwardMain());
  await wt.dispose();
  const checkpoint = runRecord(newId(), '2020-01-01T00:00:00.000Z');
  checkpoint.status = 'succeeded';
  checkpoint.toSha = await f.repo.headSha();
  checkpoint.finishedAt = '2020-01-01T00:01:00.000Z';
  f.runs.create(checkpoint);
  f.runs.finish(checkpoint);
  const run = await f.dreaming.runOnce();
  expect(run).toMatchObject({ status: 'succeeded', mode: 'sweep', focus: 'wiki/topic/' });
  expect(f.runs.get(run.id)).toEqual(run);
  expect(JSON.parse(f.runAgent.mock.calls[0][0].input as string)).toMatchObject({
    mode: 'sweep', focus: 'wiki/topic/', commits: [], userMessages: [],
    structure: { focus: 'wiki/topic/', files: ['wiki/topic/a.md', 'wiki/topic/index.md'] },
  });
  expect(f.runs.lastSucceededSweeps().get('wiki/topic/')).toBe(run.finishedAt);
});

it.each([false, true])('validates backlinks before merging a moved note (fixed: %s)', async (fixLinks) => {
  const f = await fixture();
  const author = { name: 'Test', email: 'test@example.test' };
  const seed = await f.repo.createWorktree('linked-seed');
  await seed.write('wiki/topic/old.md', wikiNote('# Durable fact\n'));
  await seed.write('wiki/topic/source.md', wikiNote('[[wiki/topic/old]]\n'));
  await seed.write('index.md', '[[wiki/topic/source]]\n');
  await seed.commit('Seed linked notes', author);
  await f.repo.withMergeLock(() => seed.fastForwardMain());
  await seed.dispose();
  const beforeHead = await f.repo.headSha();
  f.runAgent.mockImplementationOnce(async (options) => {
    const input = JSON.parse(options.input as string) as { journalPath: string };
    await options.tools.find((tool) => tool.name === 'move_file')!.run({ from: 'wiki/topic/old.md', to: 'wiki/topic/new.md' });
    if (fixLinks) await options.tools.find((tool) => tool.name === 'write_file')!.run({
      path: 'wiki/topic/source.md', content: wikiNote('[[wiki/topic/new]]\n'),
    });
    await options.tools.find((tool) => tool.name === 'write_file')!.run({
      path: input.journalPath, content: '# 일기\n\n## 구조 정리\nwiki/topic/old.md → wiki/topic/new.md: 탐색 개선이다.\n',
    });
    return { text: 'Reorganized', toolCalls: fixLinks ? 3 : 2 };
  });
  const run = await f.dreaming.runOnce();
  expect(run.structuralChanges).toEqual([{ kind: 'move', from: 'wiki/topic/old.md', to: 'wiki/topic/new.md' }]);
  expect(f.runs.get(run.id)).toEqual(run);
  if (fixLinks) {
    expect(run.status).toBe('succeeded');
    expect(await f.repo.readFile('wiki/topic/old.md')).toBeNull();
    expect(matter((await f.repo.readFile('wiki/topic/new.md'))!).content).toBe('# Durable fact\n');
    expect(matter((await f.repo.readFile('wiki/topic/source.md'))!).content).toBe('[[wiki/topic/new]]\n');
    expect(f.runs.unlearnedUserMessages(new Date().toISOString())).toEqual([]);
  } else {
    expect(run).toMatchObject({ status: 'failed', mergeSha: null, push: { status: 'skipped' } });
    expect(run.error).toBe('Dreaming introduced broken links: wiki/topic/old');
    expect(await f.repo.headSha()).toBe(beforeHead);
    expect(matter((await f.repo.readFile('wiki/topic/old.md'))!).content).toBe('# Durable fact\n');
    expect(f.runs.unlearnedUserMessages(new Date().toISOString())).toMatchObject([{ content: 'SECRET_USER_INPUT' }]);
  }
});

it('rotates sweep history only after succeeded sweeps', async () => {
  const { runs } = await database();
  for (const [mode, status, focus, finishedAt] of [
    ['sweep', 'succeeded', 'wiki/a/', '2026-10-01T01:00:00.000Z'],
    ['sweep', 'succeeded', 'wiki/a/', '2026-10-02T01:00:00.000Z'],
    ['sweep', 'failed', 'wiki/a/', '2026-10-03T01:00:00.000Z'],
    ['local', 'succeeded', 'wiki/a/', '2026-10-04T01:00:00.000Z'],
    ['structural', 'succeeded', 'wiki/b/', '2026-10-05T01:00:00.000Z'],
    ['sweep', 'succeeded', 'wiki/b/', '2026-10-01T01:00:00.000Z'],
  ] as const) {
    const record = runRecord(newId(), finishedAt);
    Object.assign(record, { mode, status, focus, finishedAt });
    runs.create(record);
    runs.finish(record);
  }
  expect([...runs.lastSucceededSweeps()].sort(([left], [right]) => left.localeCompare(right))).toEqual([
    ['wiki/a/', '2026-10-02T01:00:00.000Z'], ['wiki/b/', '2026-10-01T01:00:00.000Z'],
  ]);
});
