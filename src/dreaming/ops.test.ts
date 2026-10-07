import { execFile } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import pino from 'pino';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { EventsService } from '../events/events.service.js';
import type { WikiEvent } from '../events/events.types.js';
import { KnowledgeRepo, type Worktree } from '../knowledge/repo.js';
import type { LunaService } from '../luna/luna.service.js';
import type { RunAgentOptions } from '../luna/luna.types.js';
import type { IndexerService } from '../rag/indexer.service.js';
import type { SearchService } from '../rag/search.service.js';
import type { DreamRun } from './dream-run.types.js';
import { DreamRunsRepository } from './dream-runs.repository.js';
import { DreamingService } from './dreaming.service.js';

const git = promisify(execFile);

const resources: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of resources.splice(0).reverse()) await cleanup();
});

async function database() {
  const db = new Database(':memory:');
  resources.push(() => { db.close(); });
  db.exec(await readFile(new URL('../db/migrations/005_dreaming.sql', import.meta.url), 'utf8'));
  db.exec(await readFile(new URL('../db/migrations/008_ops.sql', import.meta.url), 'utf8'));
  db.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT, created_at TEXT, learned_at TEXT)');
  return { db, runs: new DreamRunsRepository(db) };
}

function runRecord(id: string, startedAt: string): DreamRun {
  return {
    id, startedAt, finishedAt: null, status: 'running', fromSha: null, toSha: null,
    mergeSha: null, pushed: false, summary: null, changedPaths: [], journalPath: null,
    error: null, push: { status: 'pending', remote: null, sha: null, at: null, reason: null },
  };
}

async function fixture(slackWebhookUrl?: string) {
  const root = await mkdtemp(join(tmpdir(), 'dream-ops-'));
  resources.push(() => rm(root, { recursive: true, force: true }));
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: root, SLACK_WEBHOOK_URL: slackWebhookUrl });
  const log = pino({ level: 'silent' });
  const warn = vi.spyOn(log, 'warn');
  const repo = await KnowledgeRepo.open(config, log);
  const { db, runs } = await database();
  db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, NULL)')
    .run('private-message', 'conversation', 'user', 'SECRET_USER_INPUT', '2020-01-01T00:00:00.000Z');
  const events = new EventsService();
  const seen: WikiEvent[] = [];
  events.subscribe((event) => seen.push(event));
  let worktree: Worktree;
  const runAgent = vi.fn(async (options: RunAgentOptions) => {
    const input = JSON.parse(options.input as string) as { date: string };
    await worktree.write(`journal/${input.date}.md`, '# SECRET_NOTE_CONTENT\n');
    await worktree.write('wiki/result.md', '# Reviewed knowledge\n');
    return { text: 'SECRET_SUMMARY', toolCalls: 2 };
  });
  const luna = {
    baseInstructions: async () => 'Review facts.', runAgent,
    worktreeTools: (wt: Worktree) => { worktree = wt; return []; },
    resolveConflicts: async () => { throw new Error('Unexpected conflict'); },
  } as unknown as LunaService;
  const indexer = { syncToHead: async () => ({ indexedSha: await repo.headSha() }) } as unknown as IndexerService;
  const search = { search: async () => [] } as unknown as SearchService;
  const dreaming = new DreamingService(repo, luna, indexer, search, config, log, runs, events);
  const other = new DreamingService(repo, luna, indexer, search, config, log, runs, events);
  return { root, repo, runs, db, dreaming, other, runAgent, events, seen, warn };
}

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

it('persists completed details and pages tied timestamps without losing rows', async () => {
  const { runs } = await database();
  expect(runs.latest()).toBeNull();
  expect(runs.running()).toBeNull();
  expect(runs.backupStatus()).toEqual({ lastAttempt: null, lastSuccess: null });
  const first = runRecord('a', '2026-10-01T00:00:00.000Z');
  runs.create(first);
  expect(runs.running()).toEqual(first);
  Object.assign(first, {
    status: 'succeeded', finishedAt: '2026-10-01T00:01:00.000Z', summary: '검토 완료',
    fromSha: 'base', toSha: 'input', mergeSha: 'merged', changedPaths: ['wiki/a.md', 'journal/2026-10-01.md'],
    journalPath: 'journal/2026-10-01.md', pushed: true,
    push: { status: 'succeeded', remote: 'origin', sha: 'merged', at: '2026-10-01T00:01:00.000Z', reason: null },
  });
  runs.finish(first);
  const second = runRecord('b', first.startedAt);
  runs.create(second);
  Object.assign(second, { status: 'failed', finishedAt: '2026-10-01T00:02:00.000Z', error: 'offline',
    push: { status: 'failed', remote: null, sha: null, at: '2026-10-01T00:02:00.000Z', reason: 'offline' } });
  runs.finish(second);
  const third = runRecord('c', '2026-10-02T00:00:00.000Z');
  runs.create(third);
  expect(runs.list({ limit: 2 })).toEqual([third, second]);
  expect(runs.list({ before: second.id, limit: 2 })).toEqual([first]);
  expect(runs.list({ before: '2026-10-02T00:00:00.000Z' })).toEqual([second, first]);
  expect(runs.get(first.id)).toEqual(first);
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
  expect((await f.repo.show(run.mergeSha!)).commit.body).toContain(`Wiki-Job: ${run.id}`);
  expect((await f.repo.show(run.mergeSha!)).commit.body).toContain('Wiki-Source: dreaming');
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

it('keeps merged results but persists backup failure and sends a private failure notification', async () => {
  const payloads: string[] = [];
  const url = await webhook((body) => { payloads.push(body); return 200; });
  const f = await fixture(url);
  await git('git', ['remote', 'add', 'origin', join(f.root, 'SECRET_MISSING_REMOTE')], { cwd: join(f.root, 'knowledge') });
  const run = await f.dreaming.runOnce();
  expect(run).toMatchObject({ status: 'failed', pushed: false, summary: 'SECRET_SUMMARY',
    push: { status: 'failed', remote: null, sha: null } });
  expect(run.push.reason).toContain('SECRET_MISSING_REMOTE');
  expect(await f.repo.readFile('wiki/result.md')).toBe('# Reviewed knowledge\n');
  expect(f.runs.get(run.id)).toEqual(run);
  expect(f.runs.backupStatus()).toEqual({ lastAttempt: run, lastSuccess: null });
  expect(JSON.parse(payloads[0]).text).toMatch(/^Dreaming failed; duration_ms=\d+; merge_sha=[a-f0-9]+; push=failed; push_sha=none$/);
  expect(payloads[0]).not.toContain('SECRET');
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
