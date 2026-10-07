import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Response as ExpressResponse } from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
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
import type { JobEvent, WriteJob } from '../jobs/write-job.types.js';
import { WriteJobsRepository } from '../jobs/write-jobs.repository.js';
import { WriteJobsService } from '../jobs/write-jobs.service.js';
import { KnowledgeRepo, type BlameRange, type CommitInfo, type FileChange } from '../knowledge/repo.js';
import { LunaService } from '../luna/luna.service.js';
import { IndexerService } from '../rag/indexer.service.js';
import { HistoryController } from './history.controller.js';
import { HistoryService } from './history.service.js';
import { JobsController } from './jobs.controller.js';
import { NotesController } from './notes.controller.js';
import { NotesService } from './notes.service.js';

interface WriteResponse { jobId: string; mergeSha: string }
interface NoteResponse { path: string; content: string; frontmatter: Record<string, unknown>; body: string; updatedSha: string; ref: string }
interface JobDetail { job: WriteJob; user: { email: string; name: string | null }; commits: CommitInfo[]; events: JobEvent[] }
interface CommitDetail { commit: CommitInfo; files: FileChange[]; patch: string; job: WriteJob | null }
const original = '---\ntitle: Navigation\n---\n# Navigation\n\nOld directions.\n';
const updated = '---\ntitle: Navigation\n---\n# Navigation\n\nNew directions.\n';

describe('write and history HTTP acceptance with real Git and SQLite', () => {
  let directory: string;
  let db: Db;
  let app: INestApplication;
  let server: Server;
  let origin: string;
  let repo: KnowledgeRepo;
  let jobs: WriteJobsService;
  let repository: WriteJobsRepository;
  let viewer: User;
  let editor: User;
  let other: User;
  let admin: User;
  let cookies: Map<number, string>;
  let luna: { runWrite: Mock<LunaService['runWrite']>; resolveConflicts: Mock<LunaService['resolveConflicts']> };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'llmwiki-write-history-http-'));
    const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: directory, PUBLIC_URL: 'http://localhost:3000' });
    const log = pino({ level: 'silent' });
    db = openDb(join(directory, 'wiki.db'));
    runMigrations(db);
    repo = await KnowledgeRepo.open(config, log);
    luna = {
      runWrite: vi.fn<LunaService['runWrite']>(async () => { throw new Error('Unexpected Luna call in direct-write test'); }),
      resolveConflicts: vi.fn<LunaService['resolveConflicts']>(async () => { throw new Error('Unexpected Luna conflict-resolution call'); }),
    };
    const module = await Test.createTestingModule({
      controllers: [NotesController, HistoryController, JobsController],
      providers: [
        NotesService, HistoryService, NoteWriterService, WriteJobsService, WriteJobsRepository,
        UsersService, UsersRepository, SessionsService, ApiTokensService, ApiTokensRepository,
        SessionGuard, RolesGuard, EventsService, AuditService,
        { provide: CONFIG, useValue: config },
        { provide: DB, useValue: db },
        { provide: LOGGER, useValue: log },
        { provide: KnowledgeRepo, useValue: repo },
        { provide: LunaService, useValue: luna },
        { provide: IndexerService, useValue: { syncToHead: async () => ({ indexedSha: await repo.headSha(), changedFiles: 1 }) } },
      ],
    }).compile();
    const users = module.get(UsersService);
    viewer = users.create({ email: 'viewer@example.test', name: 'Viewer', role: 'viewer' });
    editor = users.create({ email: 'editor@example.test', name: 'Editor', role: 'editor' });
    other = users.create({ email: 'other@example.test', name: 'Other editor', role: 'editor' });
    admin = users.create({ email: 'admin@example.test', name: 'Administrator', role: 'admin' });
    cookies = new Map();
    for (const user of [viewer, editor, other, admin]) {
      module.get(SessionsService).create({
        cookie: (name: string, value: string) => { cookies.set(user.id, `${name}=${value}`); },
      } as unknown as ExpressResponse, user);
    }
    jobs = module.get(WriteJobsService);
    repository = module.get(WriteJobsRepository);
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

  function request(path: string, init: RequestInit = {}, user: User = editor): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('cookie', cookies.get(user.id)!);
    headers.set('origin', 'http://localhost:3000');
    if (typeof init.body === 'string') headers.set('content-type', 'application/json');
    return fetch(`${origin}${path}`, { ...init, headers });
  }
  function query(path: string, values: Record<string, string>): string {
    return `${path}?${new URLSearchParams(values)}`;
  }
  async function json<T>(response: Response, status = 200): Promise<T> {
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(status);
    return body as T;
  }
  async function error(response: Response, status: number, code: string): Promise<{ error: { code: string; message: string } }> {
    const body = await json<{ error: { code: string; message: string } }>(response, status);
    expect(body).toMatchObject({ error: { code, message: expect.any(String) } });
    return body;
  }
  async function note(path: string, ref?: string): Promise<NoteResponse> {
    return json(await request(query('/notes/content', { path, ...(ref ? { ref } : {}) })));
  }
  async function put(path: string, content: string, baseSha: string, create = false, user = editor): Promise<WriteResponse> {
    return json(await request('/notes', { method: 'PUT', body: JSON.stringify({ path, content, baseSha, create }) }, user));
  }
  async function history(values: Record<string, string> = {}): Promise<CommitInfo[]> {
    return (await json<{ commits: CommitInfo[] }>(await request(query('/history', values)))).commits;
  }

  it('denies viewer PUT, move, delete, revert, retry and cancel without changing notes or jobs', async () => {
    const baseSha = (await note('index.md')).updatedSha;
    const queued = jobs.submit({ userId: viewer.id, input: 'Queued private request', source: 'web' });
    const failed = jobs.submit({ userId: viewer.id, input: 'Failed private request', source: 'web' });
    repository.markFailed(failed.id, 'External model unavailable', new Date().toISOString());
    const operations: Array<[string, RequestInit]> = [
      ['/notes', { method: 'PUT', body: JSON.stringify({ path: 'wiki/forbidden.md', content: 'No\n', baseSha, create: true }) }],
      ['/notes/move', { method: 'POST', body: JSON.stringify({ from: 'index.md', to: 'wiki/moved.md', baseSha }) }],
      [query('/notes', { path: 'index.md', baseSha }), { method: 'DELETE' }],
      ['/history/revert', { method: 'POST', body: JSON.stringify({ sha: baseSha }) }],
      [`/jobs/${failed.id}/retry`, { method: 'POST' }],
      [`/jobs/${queued.id}/cancel`, { method: 'POST' }],
    ];
    for (const [path, init] of operations) await error(await request(path, init, viewer), 403, 'forbidden');
    expect((await note('index.md')).updatedSha).toBe(baseSha);
    await error(await request(query('/notes/content', { path: 'wiki/forbidden.md' })), 404, 'not_found');
    const ownJobs = await json<{ jobs: WriteJob[] }>(await request('/jobs', {}, viewer));
    expect(ownJobs.jobs.map(({ id, status }) => ({ id, status }))).toEqual(expect.arrayContaining([
      { id: queued.id, status: 'queued' }, { id: failed.id, status: 'failed' },
    ]));
    expect(ownJobs.jobs).toHaveLength(2);
  });

  it('creates and updates a note while preserving ref snapshots and rejecting stale edits and duplicate creation', async () => {
    const baseSha = (await note('index.md')).updatedSha;
    const created = await put('wiki/Navigation.md', original, baseSha, true);
    expect(await note('wiki/Navigation.md')).toMatchObject({
      path: 'wiki/Navigation.md', content: original, frontmatter: { title: 'Navigation' },
      body: '# Navigation\n\nOld directions.\n', updatedSha: created.mergeSha, ref: created.mergeSha,
    });
    const changed = await put('wiki/Navigation.md', updated, created.mergeSha);
    expect(await note('wiki/Navigation.md')).toMatchObject({ content: updated, updatedSha: changed.mergeSha, ref: changed.mergeSha });
    expect(await note('wiki/Navigation.md', created.mergeSha.slice(0, 12))).toMatchObject({
      content: original, updatedSha: created.mergeSha, ref: created.mergeSha,
    });
    const stale = await error(await request('/notes', {
      method: 'PUT', body: JSON.stringify({ path: 'wiki/Navigation.md', content: 'Lost update\n', baseSha: created.mergeSha }),
    }), 409, 'stale_note');
    expect(stale.error.message).toContain(changed.mergeSha);
    await error(await request('/notes', {
      method: 'PUT', body: JSON.stringify({ path: 'wiki/Navigation.md', content: 'Duplicate\n', baseSha: changed.mergeSha, create: true }),
    }), 409, 'note_exists');
    expect(await note('wiki/Navigation.md')).toMatchObject({ content: updated, updatedSha: changed.mergeSha });
  });

  it('returns 404 for missing move and delete sources, and deletes existing notes without losing snapshots', async () => {
    const baseSha = (await note('index.md')).updatedSha;
    await error(await request('/notes/move', {
      method: 'POST', body: JSON.stringify({ from: 'wiki/missing.md', to: 'wiki/destination.md', baseSha }),
    }), 404, 'note_missing');
    await error(await request(query('/notes', { path: 'wiki/missing.md', baseSha }), { method: 'DELETE' }), 404, 'note_missing');
    const created = await put('wiki/delete-me.md', 'Temporary knowledge\n', baseSha, true);
    const deleted = await json<WriteResponse>(await request(query('/notes', { path: 'wiki/delete-me.md', baseSha: created.mergeSha }), { method: 'DELETE' }));
    await error(await request(query('/notes/content', { path: 'wiki/delete-me.md' })), 404, 'not_found');
    expect((await note('index.md')).updatedSha).toBe(deleted.mergeSha);
    expect((await note('wiki/delete-me.md', created.mergeSha)).content).toBe('Temporary knowledge\n');
  });

  it('resolves folder-qualified case-insensitive wikilinks and fragments, but returns sorted ambiguous candidates', async () => {
    const baseSha = (await note('index.md')).updatedSha;
    const first = await put('wiki/Zulu/Topic.md', 'Zulu topic\n', baseSha, true);
    await put('wiki/Alpha/topic.md', 'Alpha topic\n', first.mergeSha, true);
    expect(await json(await request(query('/notes/resolve', { name: 'WIKI/ZULU/tOpIc.MD#Heading' })))).toEqual({
      path: 'wiki/Zulu/Topic.md', candidates: ['wiki/Zulu/Topic.md'],
    });
    expect(await json(await request(query('/notes/resolve', { name: 'TOPIC#Heading' })))).toEqual({
      path: null, candidates: ['wiki/Alpha/topic.md', 'wiki/Zulu/Topic.md'],
    });
    await error(await request(query('/notes/resolve', { name: 'wiki/Missing/Topic#Heading' })), 404, 'not_found');
  });

  it('follows a move through old paths, compares unified patches and attributes blame to job and source', async () => {
    const baseSha = (await note('index.md')).updatedSha;
    const created = await put('wiki/Navigation.md', original, baseSha, true);
    const changed = await put('wiki/Navigation.md', updated, created.mergeSha);
    const comparison = await json<{ base: string; head: string; files: FileChange[]; patch: string }>(await request(query('/history/compare', {
      base: created.mergeSha, head: changed.mergeSha, path: 'wiki/Navigation.md',
    })));
    expect(comparison).toMatchObject({ base: created.mergeSha, head: changed.mergeSha, files: [{ status: 'M', path: 'wiki/Navigation.md' }] });
    expect(comparison.patch).toContain('diff --git a/wiki/Navigation.md b/wiki/Navigation.md');
    expect(comparison.patch).toContain('@@');
    expect(comparison.patch).toContain('-Old directions.\n+New directions.');
    const blame = await json<{ ref: string; ranges: BlameRange[] }>(await request(query('/notes/blame', { path: 'wiki/Navigation.md', ref: changed.mergeSha })));
    expect(blame.ref).toBe(changed.mergeSha);
    expect(blame.ranges).toEqual([
      expect.objectContaining({ start: 1, end: 5, sha: created.mergeSha, authorName: 'Editor', jobId: created.jobId, source: 'web' }),
      expect.objectContaining({ start: 6, end: 6, sha: changed.mergeSha, authorName: 'Editor', jobId: changed.jobId, source: 'web' }),
    ]);
    const moved = await json<WriteResponse>(await request('/notes/move', {
      method: 'POST', body: JSON.stringify({ from: 'wiki/Navigation.md', to: 'wiki/routes/Navigation.md', baseSha: changed.mergeSha }),
    }), 201);
    expect((await note('wiki/routes/Navigation.md')).content).toBe(updated);
    await error(await request(query('/notes/content', { path: 'wiki/Navigation.md' })), 404, 'not_found');
    const followed = await history({ path: 'wiki/routes/Navigation.md', follow: '1' });
    expect(followed.map(({ sha }) => sha)).toEqual([moved.mergeSha, changed.mergeSha, created.mergeSha]);
    expect(followed[0]).toMatchObject({ path: 'wiki/routes/Navigation.md', oldPath: 'wiki/Navigation.md' });
    expect(followed[1]).toMatchObject({ path: 'wiki/Navigation.md' });
    expect(followed[2]).toMatchObject({ path: 'wiki/Navigation.md' });
    const page = await history({ path: 'wiki/routes/Navigation.md', follow: '1', before: moved.mergeSha, limit: '1' });
    expect(page).toEqual([expect.objectContaining({ sha: changed.mergeSha, path: 'wiki/Navigation.md' })]);
    const moveDetail = await json<CommitDetail>(await request(`/history/commits/${moved.mergeSha}`));
    expect(moveDetail.files).toEqual([{ status: 'R', path: 'wiki/routes/Navigation.md', oldPath: 'wiki/Navigation.md' }]);
  });

  it('previews an inverse patch without publishing, then reverts via a new main commit that retains history', async () => {
    const baseSha = (await note('index.md')).updatedSha;
    const created = await put('wiki/Navigation.md', original, baseSha, true);
    const changed = await put('wiki/Navigation.md', updated, created.mergeSha);
    const preview = await json<{ files: FileChange[]; patch: string }>(await request('/history/revert', {
      method: 'POST', body: JSON.stringify({ sha: changed.mergeSha, paths: ['wiki/Navigation.md'], preview: true }),
    }), 201);
    expect(preview.files).toEqual([{ status: 'M', path: 'wiki/Navigation.md' }]);
    expect(preview.patch).toContain('-New directions.\n+Old directions.');
    expect(await note('wiki/Navigation.md')).toMatchObject({ content: updated, updatedSha: changed.mergeSha });
    expect((await history({ path: 'wiki/Navigation.md' })).map(({ sha }) => sha)).toEqual([changed.mergeSha, created.mergeSha]);
    const reverted = await json<WriteResponse>(await request('/history/revert', {
      method: 'POST', body: JSON.stringify({ sha: changed.mergeSha, paths: ['wiki/Navigation.md'] }),
    }), 201);
    expect(reverted.mergeSha).not.toBe(changed.mergeSha);
    expect(reverted.mergeSha).not.toBe(created.mergeSha);
    expect(await note('wiki/Navigation.md')).toMatchObject({ content: original, updatedSha: reverted.mergeSha });
    expect((await note('wiki/Navigation.md', changed.mergeSha)).content).toBe(updated);
    expect((await history({ path: 'wiki/Navigation.md' })).map(({ sha }) => sha)).toEqual([reverted.mergeSha, changed.mergeSha, created.mergeSha]);
    const detail = await json<CommitDetail>(await request(`/history/commits/${reverted.mergeSha}`));
    expect(detail.commit).toMatchObject({ parents: [changed.mergeSha], trailers: {
      'Wiki-Job': reverted.jobId, 'Wiki-Source': 'revert', 'Wiki-Requester': editor.email, 'Wiki-Client': 'web',
    } });
    const job = await json<JobDetail>(await request(`/jobs/${reverted.jobId}`));
    expect(job.job).toMatchObject({ kind: 'revert', source: 'revert', status: 'succeeded', mergeSha: reverted.mergeSha });
  });

  it('restricts jobs to their owner or admin, exposes conflict events and hides cross-owner jobs in commit details', async () => {
    const baseSha = (await note('index.md')).updatedSha;
    const seed = await put('wiki/shared.md', 'Original claim\n', baseSha, true);
    luna.runWrite.mockImplementation(async (_job, wt) => {
      await wt.write('wiki/shared.md', 'Luna claim\n');
      await put('wiki/shared.md', 'Concurrent claim\n', seed.mergeSha, false, other);
      return { summary: 'Resolve knowledge claim' };
    });
    luna.resolveConflicts.mockImplementation(async (wt) => {
      await wt.write('wiki/shared.md', 'Luna claim and concurrent claim\n');
    });
    const submitted = jobs.submit({ userId: editor.id, input: 'Private source text', source: 'chat', client: 'chat' });
    jobs.start();
    let completed!: JobDetail;
    await vi.waitFor(async () => {
      completed = await json<JobDetail>(await request(`/jobs/${submitted.id}`));
      expect(completed.job.status).toBe('succeeded');
    }, { timeout: 15000, interval: 25 });
    await jobs.stop();
    completed = await json<JobDetail>(await request(`/jobs/${submitted.id}`));
    expect(completed.job).toMatchObject({
      id: submitted.id, userId: editor.id, kind: 'luna', source: 'chat', client: 'chat',
      conflicts: ['wiki/shared.md'], input: 'Private source text',
    });
    expect(completed.user).toEqual({ email: editor.email, name: editor.name });
    expect(completed.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'resolving_conflict', at: expect.any(String), detail: { files: ['wiki/shared.md'] } }),
      expect.objectContaining({ phase: 'done', at: expect.any(String) }),
    ]));
    expect((await note('wiki/shared.md')).content).toBe('Luna claim and concurrent claim\n');
    const adminDetail = await json<JobDetail>(await request(`/jobs/${submitted.id}`, {}, admin));
    expect(adminDetail).toEqual(completed);
    await error(await request(`/jobs/${submitted.id}`, {}, other), 404, 'not_found');
    for (const action of ['retry', 'cancel']) {
      await error(await request(`/jobs/${submitted.id}/${action}`, { method: 'POST' }, other), 404, 'not_found');
    }
    const own = await json<{ jobs: WriteJob[] }>(await request('/jobs'));
    expect(own.jobs.map(({ id }) => id).sort()).toEqual([seed.jobId, submitted.id].sort());
    const others = await json<{ jobs: WriteJob[] }>(await request('/jobs', {}, other));
    expect(others.jobs).toEqual([expect.objectContaining({ userId: other.id, kind: 'direct', source: 'web' })]);
    const all = await json<{ jobs: WriteJob[] }>(await request('/jobs', {}, admin));
    expect(all.jobs.map(({ id }) => id).sort()).toEqual([seed.jobId, submitted.id, others.jobs[0]!.id].sort());
    expect((await json<{ jobs: WriteJob[] }>(await request('/jobs?mine=1', {}, admin))).jobs).toEqual([]);
    const sha = completed.job.mergeSha!;
    expect((await json<CommitDetail>(await request(`/history/commits/${sha}`))).job).toMatchObject({ id: submitted.id });
    expect((await json<CommitDetail>(await request(`/history/commits/${sha}`, {}, admin))).job).toMatchObject({ id: submitted.id });
    const hidden = await json<CommitDetail>(await request(`/history/commits/${sha}`, {}, other));
    expect(hidden.job).toBeNull();
    expect(hidden.commit.sha).toBe(sha);
    expect(JSON.stringify(hidden)).not.toContain('Private source text');
  }, 20000);
});
