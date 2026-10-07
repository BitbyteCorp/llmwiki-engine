import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Response as ExpressResponse } from 'express';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AclService } from '../acl/acl.service.js';
import { AuditService } from '../audit/audit.service.js';
import { ApiTokensRepository } from '../auth/api-tokens.repository.js';
import { ApiTokensService } from '../auth/api-tokens.service.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { SessionsService } from '../auth/sessions.service.js';
import { UsersRepository } from '../auth/users.repository.js';
import { UsersService } from '../auth/users.service.js';
import type { User } from '../auth/users.types.js';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter.js';
import { configureApp } from '../common/http/configure-app.js';
import { CONFIG, DB, LOGGER } from '../common/tokens.js';
import { loadConfig } from '../config.js';
import { openDb, runMigrations, type Db } from '../db/index.js';
import { EventsService } from '../events/events.service.js';
import { NoteWriterService } from '../jobs/note-writer.service.js';
import type { WriteJob } from '../jobs/write-job.types.js';
import { WriteJobsRepository } from '../jobs/write-jobs.repository.js';
import { WriteJobsService } from '../jobs/write-jobs.service.js';
import { KnowledgeRepo, type CommitInfo, type FileChange, type Worktree } from '../knowledge/repo.js';
import { LunaService } from '../luna/luna.service.js';
import { IndexerService } from '../rag/indexer.service.js';
import { HistoryController } from './history.controller.js';
import { HistoryService } from './history.service.js';
import { JobsController } from './jobs.controller.js';
import { NotesController } from './notes.controller.js';
import { NotesService } from './notes.service.js';

interface Detail { commit: CommitInfo; files: FileChange[]; patch: string; job: WriteJob | null }
const secret = 'CLASSIFIED-ORCHID';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);

describe('folder ACL at notes, history and job HTTP boundaries', () => {
  let directory: string;
  let db: Db;
  let app: INestApplication;
  let server: Server;
  let origin: string;
  let repo: KnowledgeRepo;
  let acl: AclService;
  let jobs: WriteJobsService;
  let repository: WriteJobsRepository;
  let alice: User;
  let bob: User;
  let admin: User;
  let cookies: Map<number, string>;
  let seed: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'llmwiki-acl-http-'));
    const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: directory, PUBLIC_URL: 'http://localhost:3000' });
    const log = pino({ level: 'silent' });
    db = openDb(join(directory, 'wiki.db'));
    runMigrations(db);
    repo = await KnowledgeRepo.open(config, log);
    const module = await Test.createTestingModule({
      controllers: [NotesController, HistoryController, JobsController],
      providers: [NotesService, HistoryService, NoteWriterService, WriteJobsService, WriteJobsRepository,
        UsersService, UsersRepository, SessionsService, ApiTokensService, ApiTokensRepository,
        SessionGuard, RolesGuard, EventsService, AuditService, AclService,
        { provide: CONFIG, useValue: config }, { provide: DB, useValue: db }, { provide: LOGGER, useValue: log },
        { provide: KnowledgeRepo, useValue: repo },
        { provide: LunaService, useValue: { runWrite: async () => { throw new Error('Direct HTTP writes must not invoke Luna'); } } },
        { provide: IndexerService, useValue: { syncToHead: async () => ({ indexedSha: await repo.headSha(), changedFiles: 1 }) } },
      ],
    }).compile();
    const users = module.get(UsersService);
    alice = users.create({ email: 'alice@example.test', role: 'editor' });
    bob = users.create({ email: 'bob@example.test', role: 'editor' });
    admin = users.create({ email: 'admin@example.test', role: 'admin' });
    cookies = new Map();
    for (const user of [alice, bob, admin]) module.get(SessionsService).create({
      cookie: (name: string, value: string) => { cookies.set(user.id, `${name}=${value}`); },
    } as unknown as ExpressResponse, user);
    jobs = module.get(WriteJobsService);
    repository = module.get(WriteJobsRepository);
    acl = module.get(AclService);
    acl.create({ prefix: 'secret/', subjectType: 'everyone', subject: '', access: 'none' }, admin);
    acl.create({ prefix: 'secret/', subjectType: 'user', subject: String(bob.id), access: 'write' }, admin);
    acl.create({ prefix: 'readonly/', subjectType: 'everyone', subject: '', access: 'read' }, admin);
    acl.create({ prefix: 'assets/secret/', subjectType: 'everyone', subject: '', access: 'none' }, admin);
    acl.create({ prefix: 'assets/secret/', subjectType: 'user', subject: String(bob.id), access: 'write' }, admin);
    seed = await change('Seed public and secret notes', async (wt) => {
      await wt.write('public/Shared.md', '# Shared\nPublic initial text.\n');
      await wt.write('public/Names.md', '# Public name\n');
      await wt.write('secret/Names.md', `# ${secret}\n`);
      await wt.write('secret/Secret.md', `${secret} original\n`);
      await wt.write('assets/secret/image.png', png);
      await wt.write('assets/public/image.png', png);
      await wt.write('readonly/Locked.md', '# Locked\n');
    });
    app = module.createNestApplication({ logger: false });
    configureApp(app);
    app.useGlobalFilters(new HttpExceptionFilter(log));
    await app.listen(0, '127.0.0.1');
    server = app.getHttpServer() as Server;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    origin = `http://127.0.0.1:${address.port}/api`;
  });

  afterEach(async () => {
    if (jobs) await jobs.stop();
    if (server) server.closeAllConnections();
    if (app) await app.close();
    if (db?.open) db.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function change(subject: string, edit: (wt: Worktree) => Promise<void>): Promise<string> {
    const wt = await repo.createWorktree(randomUUID());
    try {
      await edit(wt);
      const sha = await wt.commit(subject, { name: 'Author', email: 'author@example.test' });
      if (!sha) throw new Error('Expected changed files');
      await wt.fastForwardMain();
      return sha;
    } finally { await wt.dispose(); }
  }

  function request(path: string, user = alice, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('cookie', cookies.get(user.id)!);
    headers.set('origin', 'http://localhost:3000');
    if (typeof init.body === 'string') headers.set('content-type', 'application/json');
    return fetch(`${origin}${path}`, { ...init, headers });
  }

  async function json<T>(response: Response, status = 200): Promise<T> {
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(status);
    return body as T;
  }

  async function denied(response: Response, status = 404) {
    expect(await json(response, status)).toMatchObject({ error: { code: status === 404 ? 'not_found' : 'forbidden' } });
  }

  it('filters tree and wikilink ambiguity and gates current/historical content, blame and raw bytes for each reader', async () => {
    const tree = await json<{ files: string[] }>(await request('/notes/tree'));
    expect(tree.files).toContain('public/Shared.md');
    expect(tree.files.some((path) => path.startsWith('secret/'))).toBe(false);
    expect(await json(await request('/notes/resolve?name=Names'))).toEqual({ path: 'public/Names.md', candidates: ['public/Names.md'] });
    expect(await json(await request('/notes/resolve?name=Names', bob))).toEqual({ path: null, candidates: ['public/Names.md', 'secret/Names.md'] });
    await denied(await request('/notes/resolve?name=Secret'));
    for (const ref of ['', `&ref=${seed}`]) {
      for (const route of ['content', 'blame']) await denied(await request(`/notes/${route}?path=secret/Secret.md${ref}`));
      await denied(await request(`/notes/raw?path=assets/secret/image.png${ref}`));
    }
    expect(await json(await request('/notes/content?path=public/Shared.md'))).toMatchObject({ content: '# Shared\nPublic initial text.\n' });
    const blame = await json<{ ranges: Array<{ summary: string }> }>(await request('/notes/blame?path=public/Shared.md'));
    expect(blame.ranges[0]?.summary).toBe('Restricted change');
    for (const reader of [bob, admin]) {
      expect(await json(await request('/notes/content?path=secret/Secret.md', reader))).toMatchObject({ content: `${secret} original\n` });
      expect((await json<{ ranges: unknown[] }>(await request('/notes/blame?path=secret/Secret.md', reader))).ranges).toEqual(expect.arrayContaining([expect.objectContaining({ start: 1, end: 1 })]));
      const raw = await request('/notes/raw?path=assets/secret/image.png', reader);
      expect(raw.status).toBe(200);
      expect(Buffer.from(await raw.arrayBuffer())).toEqual(png);
    }
    const raw = await request('/notes/raw?path=assets/public/image.png');
    expect(Buffer.from(await raw.arrayBuffer())).toEqual(png);
  });

  it('paginates readable history before limit, hides rename origins and regenerates only readable patches', async () => {
    const publicSha = await change('Public revision', async (wt) => { await wt.write('public/Shared.md', 'Public revision\n'); });
    const hiddenSha = await change(`${secret} hidden subject`, async (wt) => { await wt.write('secret/Secret.md', `${secret} changed\n`); });
    const mixedSha = await change(`${secret} mixed subject\n\n${secret} body`, async (wt) => {
      await wt.write('public/Shared.md', 'Public mixed revision\n');
      await wt.write('secret/Secret.md', `${secret} mixed revision\n`);
    });
    const renameSha = await change(`${secret} renamed source`, async (wt) => { await wt.move('secret/Names.md', 'public/Renamed.md'); });
    const latestSha = await change('Newest public revision', async (wt) => { await wt.write('public/Shared.md', 'Newest public text\n'); });
    const first = await json<{ commits: CommitInfo[] }>(await request('/history?limit=2'));
    expect(first.commits.map((commit) => commit.sha)).toEqual([latestSha, mixedSha]);
    expect(first.commits[1]).toMatchObject({ subject: 'Restricted change', body: '', trailers: {} });
    const next = await json<{ commits: CommitInfo[] }>(await request(`/history?limit=2&before=${mixedSha}`));
    expect(next.commits.map((commit) => commit.sha)).toEqual([publicSha, seed]);
    const again = await json<{ commits: CommitInfo[] }>(await request(`/history?limit=2&before=${mixedSha}`));
    expect(again).toEqual(next);
    for (const sha of [hiddenSha, renameSha]) await denied(await request(`/history/commits/${sha}`));
    const detail = await json<Detail>(await request(`/history/commits/${mixedSha}`));
    expect(detail.files).toEqual([{ status: 'M', path: 'public/Shared.md' }]);
    expect(detail.patch).toContain('+Public mixed revision');
    expect(JSON.stringify(detail)).not.toContain(secret);
    expect(detail.patch).not.toContain('secret/');
    const comparison = await json<{ files: FileChange[]; patch: string }>(await request(`/history/compare?base=${publicSha}&head=${latestSha}`));
    expect(comparison.files).toEqual([{ status: 'M', path: 'public/Shared.md' }]);
    expect(comparison.patch).toContain('+Newest public text');
    expect(comparison.patch).not.toContain(secret);
    expect(await json(await request(`/history/compare?base=${mixedSha}&head=${renameSha}&path=public/Renamed.md`))).toMatchObject({ files: [], patch: '' });
    expect(await json(await request('/history?path=public/Renamed.md&follow=1'))).toEqual({ commits: [] });
    await denied(await request('/history?path=secret/Secret.md'));
    await denied(await request(`/history/compare?base=${seed}&head=${latestSha}&path=secret/Secret.md`));
    for (const reader of [bob, admin]) {
      expect(await json<Detail>(await request(`/history/commits/${hiddenSha}`, reader))).toMatchObject({ commit: { subject: `${secret} hidden subject` } });
      const rename = await json<Detail>(await request(`/history/commits/${renameSha}`, reader));
      expect(rename.files).toEqual([{ status: 'R', path: 'public/Renamed.md', oldPath: 'secret/Names.md' }]);
      expect(rename.patch).toContain('rename from secret/Names.md');
      expect((await json<{ commits: CommitInfo[] }>(await request('/history?limit=2', reader))).commits.map((commit) => commit.sha)).toEqual([latestSha, renameSha]);
    }
  });

  it('redacts job input, summaries, errors, conflicts, events and commit metadata when source permissions change', async () => {
    const sha = await change(`${secret} job subject`, async (wt) => {
      await wt.write('secret/Secret.md', `${secret} job edit\n`);
      await wt.write('public/Shared.md', 'Public job edit\n');
    });
    const job = jobs.submit({ userId: bob.id, input: `${secret} request`, source: 'web' });
    repository.markMerging(job.id, `${secret} summary`, [sha]);
    repository.recordMerge(job.id, [sha], sha);
    repository.recordConflicts(job.id, ['secret/Secret.md']);
    repository.addEvent(job.id, 'resolving_conflict', { path: 'secret/Secret.md', patch: secret });
    repository.markFailed(job.id, `${secret} failed`, new Date().toISOString());
    const allowed = await json<{ job: WriteJob; commits: CommitInfo[] }>(await request(`/jobs/${job.id}`, bob));
    expect(allowed.job.input).toBe(`${secret} request`);
    const rule = acl.list().find((item) => item.prefix === 'secret/' && item.subjectType === 'user' && item.subject === String(bob.id))!;
    acl.delete(rule.id, admin);
    const detail = await json<{ job: WriteJob; commits: CommitInfo[]; events: Array<{ detail: unknown }> }>(await request(`/jobs/${job.id}`, bob));
    expect(detail.job).toMatchObject({ input: '', summary: null, conflicts: [], commits: [], mergeSha: null });
    expect(detail.commits).toEqual([]);
    expect(detail.events.every((event) => event.detail === null)).toBe(true);
    expect(JSON.stringify(detail)).not.toContain(secret);
    expect(JSON.stringify(detail)).not.toContain('secret/');
    const list = await json<{ jobs: WriteJob[] }>(await request('/jobs', bob));
    expect(list.jobs[0]?.input).toBe('');
    expect(JSON.stringify(list)).not.toContain(secret);
    await denied(await request(`/jobs/${job.id}/retry`, bob, { method: 'POST' }));
    await denied(await request(`/jobs/${job.id}`));
    const privileged = await json<{ job: WriteJob; commits: CommitInfo[] }>(await request(`/jobs/${job.id}`, admin));
    expect(privileged.job.conflicts).toEqual(['secret/Secret.md']);
    expect(privileged.commits[0]?.subject).toBe(`${secret} job subject`);
    const linked = await json<Detail>(await request(`/history/commits/${sha}`, bob));
    expect(linked.job?.input).toBe('');
    expect(linked.patch).toContain('+Public job edit');
    expect(JSON.stringify(linked)).not.toContain(secret);
  });

  it('rejects PUT, moves at either endpoint, delete and revert before mutation, while admins bypass folder rules', async () => {
    const baseSha = await repo.headSha();
    const operations: Array<[string, RequestInit, number]> = [
      ['/notes', { method: 'PUT', body: JSON.stringify({ path: 'readonly/Locked.md', content: 'Denied\n', baseSha }) }, 403],
      ['/notes', { method: 'PUT', body: JSON.stringify({ path: 'secret/New.md', content: 'Denied\n', baseSha, create: true }) }, 404],
      ['/notes/move', { method: 'POST', body: JSON.stringify({ from: 'public/Shared.md', to: 'readonly/Moved.md', baseSha }) }, 403],
      ['/notes/move', { method: 'POST', body: JSON.stringify({ from: 'readonly/Locked.md', to: 'public/Moved.md', baseSha }) }, 403],
      ['/notes/move', { method: 'POST', body: JSON.stringify({ from: 'public/Shared.md', to: 'secret/Moved.md', baseSha }) }, 404],
      ['/notes/move', { method: 'POST', body: JSON.stringify({ from: 'secret/Secret.md', to: 'public/Moved.md', baseSha }) }, 404],
      [`/notes?path=readonly/Locked.md&baseSha=${baseSha}`, { method: 'DELETE' }, 403],
      [`/notes?path=secret/Secret.md&baseSha=${baseSha}`, { method: 'DELETE' }, 404],
      ['/history/revert', { method: 'POST', body: JSON.stringify({ sha: seed, paths: ['readonly/Locked.md'], preview: true }) }, 403],
      ['/history/revert', { method: 'POST', body: JSON.stringify({ sha: seed, paths: ['secret/Secret.md'] }) }, 404],
    ];
    for (const [path, init, status] of operations) await denied(await request(path, alice, init), status);
    expect(await repo.headSha()).toBe(baseSha);
    expect(jobs.list()).toEqual([]);
    const allowed = await json<{ jobId: string; mergeSha: string }>(await request('/notes', admin, {
      method: 'PUT', body: JSON.stringify({ path: 'readonly/Locked.md', content: 'Admin update\n', baseSha }),
    }));
    expect(await repo.readFile('readonly/Locked.md', allowed.mergeSha)).toBe('Admin update\n');
    const secondBase = await repo.headSha();
    await json(await request('/notes/move', bob, { method: 'POST', body: JSON.stringify({ from: 'secret/Secret.md', to: 'secret/Moved.md', baseSha: secondBase }) }), 201);
    expect(await repo.readFile('secret/Moved.md')).toBe(`${secret} original\n`);
    await json(await request(`/notes?path=secret/Moved.md&baseSha=${await repo.headSha()}`, bob, { method: 'DELETE' }));
    expect(await repo.readFile('secret/Moved.md')).toBeNull();
  });
});
