import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Response as ExpressResponse } from 'express';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
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
import { legacyUuidToApi, newId } from '../common/ids.js';
import { loadConfig } from '../config.js';
import { openDb, runMigrations, type Db } from '../db/index.js';
import { EventsService } from '../events/events.service.js';
import { DreamRunsRepository } from '../dreaming/dream-runs.repository.js';
import { DreamingService } from '../dreaming/dreaming.service.js';
import { NoteWriterService } from '../jobs/note-writer.service.js';
import type { JobEvent, WriteJob } from '../jobs/write-job.types.js';
import { WriteJobsRepository } from '../jobs/write-jobs.repository.js';
import { WriteJobsService } from '../jobs/write-jobs.service.js';
import { KnowledgeRepo, type BlameRange, type CommitInfo, type FileChange } from '../knowledge/repo.js';
import { AgentService } from '../agent/agent.service.js';
import { IndexerService } from '../rag/indexer.service.js';
import { ActivityService } from '../ops/activity.service.js';
import { OpsController } from '../ops/ops.controller.js';
import { HistoryController } from './history.controller.js';
import { HistoryService } from './history.service.js';
import { JobsController } from './jobs.controller.js';
import { NotesController } from './notes.controller.js';
import { NotesService } from './notes.service.js';

interface WriteResponse { jobId: string; mergeSha: string }
interface NoteResponse { path: string; content: string; frontmatter: Record<string, unknown>; body: string; updatedSha: string; ref: string }
type JobPayload = WriteJob & { resumable: boolean };
interface JobDetail { job: JobPayload; user: { email: string; name: string | null }; commits: CommitInfo[]; events: JobEvent[] }
interface CommitDetail { commit: CommitInfo; files: FileChange[]; patch: string; job: JobPayload | null }
const noteFrontmatter = `---
type: note
aliases: []
description: Exercises exact note history and recovery.
author: ["Editor"]
date created: 2020-01-01
date modified: 2026-10-10
tags: [history]
---
`;
function noteContent(body: string): string { return noteFrontmatter + body; }
const navigationFrontmatter = noteFrontmatter.replace('type: note\n', 'title: Navigation\ntype: note\n');
const original = navigationFrontmatter + '# Navigation\n\nOld directions.\n';
const updated = navigationFrontmatter + '# Navigation\n\nNew directions.\n';

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
  let agent: { runWrite: Mock<AgentService['runWrite']>; resolveConflicts: Mock<AgentService['resolveConflicts']> };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-10T00:00:00.000Z'));
    directory = await mkdtemp(join(tmpdir(), 'llmwiki-write-history-http-'));
    const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: directory, PUBLIC_URL: 'http://localhost:3000' });
    const log = pino({ level: 'silent' });
    db = openDb(join(directory, 'wiki.db'));
    runMigrations(db);
    repo = await KnowledgeRepo.open(config, log);
    agent = {
      runWrite: vi.fn<AgentService['runWrite']>(async () => { throw new Error('Unexpected Dony call in direct-write test'); }),
      resolveConflicts: vi.fn<AgentService['resolveConflicts']>(async () => { throw new Error('Unexpected Dony conflict-resolution call'); }),
    };
    const module = await Test.createTestingModule({
      controllers: [NotesController, HistoryController, JobsController, OpsController],
      providers: [
        NotesService, HistoryService, NoteWriterService, WriteJobsService, WriteJobsRepository,
        UsersService, UsersRepository, SessionsService, ApiTokensService, ApiTokensRepository,
        SessionGuard, RolesGuard, EventsService, AuditService, AclService,
        ActivityService, DreamRunsRepository,
        { provide: DreamingService, useValue: {} },
        { provide: CONFIG, useValue: config },
        { provide: DB, useValue: db },
        { provide: LOGGER, useValue: log },
        { provide: KnowledgeRepo, useValue: repo },
        { provide: AgentService, useValue: agent },
        { provide: IndexerService, useValue: {
          syncToHead: async () => ({ indexedSha: await repo.headSha(), changedFiles: 1 }),
          status: async () => ({ indexedSha: await repo.headSha(), syncing: false }),
        } },
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
    vi.useRealTimers();
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

  it('links migrated jobs to historical UUID Git trailers in history and path activity', async () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const id = legacyUuidToApi(uuid);
    const path = 'wiki/legacy-job.md';
    const at = new Date().toISOString();
    repository.enqueue(id, editor.id, 'Legacy source', at, 'web');
    repository.addEvent(id, 'queued', { sourceProvenanceComplete: true });
    const wt = await repo.createWorktree('legacy-job-link');
    await wt.write(path, 'Legacy knowledge\n');
    const git = promisify(execFile);
    await git('git', ['add', '--all'], { cwd: wt.path });
    await git('git', ['commit', '-m', `Legacy job\n\nWiki-Job: ${uuid}\nWiki-Source: web\nWiki-Requester: ${editor.email}`], { cwd: wt.path });
    const sha = (await git('git', ['rev-parse', 'HEAD'], { cwd: wt.path })).stdout.trim();
    await wt.fastForwardMain();
    await wt.dispose();
    const activity = new ActivityService(db, repo, new DreamRunsRepository(db), app.get(AclService), app.get(UsersService));
    // No merge SHA or recorded commits: this association must come from the legacy trailer.
    const feed = await activity.list({ limit: 10, type: 'job', path }, editor);
    expect(feed.items).toMatchObject([{ id, paths: [path], job: { id } }]);
    repository.markMerging(id, 'Legacy summary', [sha]);
    repository.recordMerge(id, [sha], sha);
    repository.markSucceeded(id, at);
    const detail = await json<CommitDetail>(await request(`/history/commits/${sha}`));
    expect(detail.commit.trailers['Wiki-Job']).toBe(id);
    expect(detail.job).toMatchObject({ id, userId: editor.id, mergeSha: sha });
    const legacyLink = await json<JobDetail>(await request(`/jobs/${uuid}`));
    expect(legacyLink.job.id).toBe(id);
    expect(legacyLink.commits).toMatchObject([{ sha, trailers: { 'Wiki-Job': id } }]);
  });

  it.each(['files', 'sources'] as const)('redacts unreadable child %s and results without treating assignments as accessed sources', async (hiddenField) => {
    app.get(AclService).create({ prefix: 'secret/', subjectType: 'everyone', subject: '', access: 'none' }, admin);
    const submitted = jobs.submit({ userId: editor.id, input: 'Public request', source: 'chat' });
    repository.markMerging(submitted.id, 'Public summary', []);
    const childId = newId();
    const publicChildId = newId();
    jobs.phase(submitted.id, 'editing', { subagent: {
      id: childId, name: 'Writer', status: 'failed', files: ['wiki/public.md'],
      sources: ['raw/public.md'], [hiddenField]: hiddenField === 'files' ? ['wiki/public.md', 'secret/plan.md'] : ['raw/public.md', 'secret/plan.md'],
      toolCalls: 1, startedAt: submitted.createdAt, result: 'secret/plan.md detail', error: 'Denied secret/plan.md',
    } });
    jobs.phase(submitted.id, 'editing', { subagent: {
      id: publicChildId, name: 'Public writer', status: 'completed', files: ['wiki/public.md'], toolCalls: 2, result: 'Public result',
    } });
    const detail = await json<JobDetail>(await request(`/jobs/${submitted.id}`));
    expect(detail.job).toMatchObject({ input: 'Public request', summary: 'Public summary' });
    expect(detail.events.find(event => (event.detail?.subagent as { id?: string } | undefined)?.id === childId)?.detail?.subagent).toMatchObject({
      id: childId, files: ['wiki/public.md'], sources: ['raw/public.md'], status: 'failed', toolCalls: 1,
    });
    expect(JSON.stringify(detail)).not.toContain('secret/plan.md');
    expect(detail.events.find(event => (event.detail?.subagent as { id?: string } | undefined)?.id === publicChildId)?.detail?.subagent).toMatchObject({ sources: [], result: 'Public result' });
    const unrestricted = await json<JobDetail>(await request(`/jobs/${submitted.id}`, {}, admin));
    expect(unrestricted.events.find(event => (event.detail?.subagent as { id?: string } | undefined)?.id === childId)?.detail?.subagent).toMatchObject({
      [hiddenField]: hiddenField === 'files' ? ['wiki/public.md', 'secret/plan.md'] : ['raw/public.md', 'secret/plan.md'],
      error: 'Denied secret/plan.md', result: 'secret/plan.md detail',
    });
  });

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

  it('lets editors cancel only their queued jobs and retry failed jobs under a new identity with retained provenance', async () => {
    const queued = jobs.submit({ userId: editor.id, input: 'Cancel this request', source: 'web', client: 'web' });
    await error(await request(`/jobs/${queued.id}/cancel`, { method: 'POST' }, other), 404, 'not_found');
    const canceled = await json<{ job: WriteJob }>(await request(`/jobs/${queued.id}/cancel`, { method: 'POST' }), 201);
    expect(canceled.job).toMatchObject({ id: queued.id, userId: editor.id, status: 'failed', error: 'canceled', resumable: false });
    expect((await json<JobDetail>(await request(`/jobs/${queued.id}`))).job).toEqual(canceled.job);
    await error(await request(`/jobs/${queued.id}/cancel`, { method: 'POST' }), 409, 'job_not_cancelable');

    const running = jobs.submit({ userId: editor.id, input: 'Already running', source: 'mcp' });
    repository.markRunning(running.id, new Date().toISOString());
    await error(await request(`/jobs/${running.id}/cancel`, { method: 'POST' }), 409, 'job_not_cancelable');
    await error(await request(`/jobs/${running.id}/retry`, { method: 'POST' }), 409, 'job_not_retryable');

    const failed = jobs.submit({ userId: editor.id, input: 'Retry the original source', source: 'chat', client: 'conversation-editor' });
    repository.markFailed(failed.id, 'External model unavailable', new Date().toISOString());
    await error(await request(`/jobs/${failed.id}/retry`, { method: 'POST' }, other), 404, 'not_found');
    const retried = await json<{ job: WriteJob }>(await request(`/jobs/${failed.id}/retry`, { method: 'POST' }), 201);
    expect(retried.job.id).not.toBe(failed.id);
    expect(retried.job).toMatchObject({
      userId: editor.id, input: 'Retry the original source', status: 'queued', kind: 'agent',
      source: 'chat', client: 'conversation-editor', error: null, resumable: false,
    });
    const detail = await json<JobDetail>(await request(`/jobs/${retried.job.id}`));
    expect(detail.events.map((event) => event.phase)).toContain('queued');
    expect((await json<JobDetail>(await request(`/jobs/${failed.id}`))).job).toMatchObject({
      id: failed.id, status: 'failed', error: 'External model unavailable',
    });
  });

  it('exposes resumability for preserved failed work and continues both committed and unfinished changes under a new identity', async () => {
    const preserved = noteContent('Committed before failure\n');
    const unfinished = noteContent('Uncommitted before failure\n');
    const continued = noteContent('Uncommitted before failure\nCompleted continuation\n');
    agent.runWrite.mockImplementationOnce(async (_job, wt, author) => {
      await wt.write('wiki/preserved.md', preserved);
      await wt.commit('Preserved progress', author);
      await wt.write('wiki/unfinished.md', unfinished);
      throw new Error('Provider interrupted after editing');
    });
    const submitted = jobs.submit({ userId: editor.id, input: 'Continue preserved progress', source: 'chat', client: 'conversation-editor' });
    jobs.start();
    await vi.waitFor(() => expect(jobs.get(submitted.id)?.status).toBe('failed'), { timeout: 15000 });
    await jobs.stop();
    const failed = await json<JobDetail>(await request(`/jobs/${submitted.id}`));
    expect(failed.job).toMatchObject({ status: 'failed', resumable: true, error: 'Provider interrupted after editing' });
    expect(await repo.readFile('wiki/preserved.md')).toBeNull();
    expect(await repo.readFile('wiki/unfinished.md')).toBeNull();
    const list = await json<{ jobs: JobPayload[] }>(await request('/jobs'));
    expect(list.jobs.find(job => job.id === submitted.id)?.resumable).toBe(true);
    await error(await request('/admin/ops'), 403, 'forbidden');
    const ops = await json<{ failedJobs: JobPayload[] }>(await request('/admin/ops', {}, admin));
    expect(ops.failedJobs.find(job => job.id === submitted.id)).toMatchObject({ resumable: true });
    expect(ops.failedJobs.find(job => job.id === submitted.id)).not.toHaveProperty('input');
    const activity = await json<{ items: Array<{ job?: JobPayload }> }>(await request('/activity?type=job'));
    expect(activity.items.find(item => item.job?.id === submitted.id)?.job).toMatchObject({ resumable: true });
    await error(await request(`/jobs/${submitted.id}`, {}, other), 404, 'not_found');
    await error(await request(`/jobs/${submitted.id}/retry`, { method: 'POST' }, other), 404, 'not_found');
    const retried = await json<{ job: JobPayload }>(await request(`/jobs/${submitted.id}/retry`, { method: 'POST' }), 201);
    expect(retried.job.id).not.toBe(submitted.id);
    expect(retried.job).toMatchObject({ status: 'queued', resumable: false, source: 'chat', client: 'conversation-editor' });
    const adminRetry = await json<{ job: JobPayload }>(await request(`/admin/jobs/${submitted.id}/retry`, { method: 'POST' }, admin), 201);
    expect(adminRetry.job).toMatchObject({ status: 'queued', resumable: false });
    const adminCanceled = await json<{ job: JobPayload }>(await request(`/admin/jobs/${adminRetry.job.id}/cancel`, { method: 'POST' }, admin), 201);
    expect(adminCanceled.job).toMatchObject({ status: 'failed', error: 'canceled', resumable: true });
    agent.runWrite.mockImplementationOnce(async (_job, wt) => {
      expect(await wt.read('wiki/preserved.md')).toBe(preserved);
      expect(await wt.read('wiki/unfinished.md')).toBe(unfinished);
      await wt.write('wiki/unfinished.md', continued);
      return { summary: 'Continue preserved progress' };
    });
    jobs.start();
    await vi.waitFor(() => expect(jobs.get(retried.job.id)?.status).toBe('succeeded'), { timeout: 15000 });
    await jobs.stop();
    expect(await repo.readFile('wiki/preserved.md')).toBe(preserved);
    expect(await repo.readFile('wiki/unfinished.md')).toBe(continued);
    expect((await json<JobDetail>(await request(`/jobs/${submitted.id}`))).job).toEqual(failed.job);
    const completed = await json<JobDetail>(await request(`/jobs/${retried.job.id}`));
    expect(completed.job).toMatchObject({ status: 'succeeded', resumable: false });
    expect((await json<CommitDetail>(await request(`/history/commits/${completed.job.mergeSha}`))).job).toMatchObject({ id: retried.job.id, resumable: false });
  }, 20000);

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
    const temporary = noteContent('Temporary knowledge\n');
    const created = await put('wiki/delete-me.md', temporary, baseSha, true);
    const deleted = await json<WriteResponse>(await request(query('/notes', { path: 'wiki/delete-me.md', baseSha: created.mergeSha }), { method: 'DELETE' }));
    await error(await request(query('/notes/content', { path: 'wiki/delete-me.md' })), 404, 'not_found');
    expect((await note('index.md')).updatedSha).toBe(deleted.mergeSha);
    expect((await note('wiki/delete-me.md', created.mergeSha)).content).toBe(temporary);
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
      expect.objectContaining({ start: 1, end: 12, sha: created.mergeSha, authorName: 'Editor', jobId: created.jobId, source: 'web' }),
      expect.objectContaining({ start: 13, end: 13, sha: changed.mergeSha, authorName: 'Editor', jobId: changed.jobId, source: 'web' }),
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
    const seed = await put('wiki/shared.md', noteContent('Original claim\n'), baseSha, true);
    agent.runWrite.mockImplementation(async (_job, wt) => {
      await wt.write('wiki/shared.md', noteContent('Dony claim\n'));
      await put('wiki/shared.md', noteContent('Concurrent claim\n'), seed.mergeSha, false, other);
      return { summary: 'Resolve knowledge claim' };
    });
    agent.resolveConflicts.mockImplementation(async (wt) => {
      await wt.write('wiki/shared.md', noteContent('Dony claim and concurrent claim\n'));
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
      id: submitted.id, userId: editor.id, kind: 'agent', source: 'chat', client: 'chat',
      conflicts: ['wiki/shared.md'], input: 'Private source text',
    });
    expect(completed.user).toEqual({ email: editor.email, name: editor.name });
    expect(completed.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'resolving_conflict', at: expect.any(String), detail: { files: ['wiki/shared.md'] } }),
      expect.objectContaining({ phase: 'done', at: expect.any(String) }),
    ]));
    expect((await note('wiki/shared.md')).content).toBe(noteContent('Dony claim and concurrent claim\n'));
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
