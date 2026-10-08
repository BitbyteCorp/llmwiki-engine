import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response, NextFunction } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { AclService } from '../acl/acl.service.js';
import { ApiError } from '../api/api-error.js';
import { AuditService } from '../audit/audit.service.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import type { User } from '../auth/users.types.js';
import { UsersRepository } from '../auth/users.repository.js';
import { UsersService } from '../auth/users.service.js';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter.js';
import { DB } from '../common/tokens.js';
import { openDb, runMigrations, type Db } from '../db/index.js';
import type { DreamRun } from '../dreaming/dream-run.types.js';
import { DreamRunsRepository } from '../dreaming/dream-runs.repository.js';
import { DreamingService } from '../dreaming/dreaming.service.js';
import { WriteJobsRepository } from '../jobs/write-jobs.repository.js';
import { WriteJobsService } from '../jobs/write-jobs.service.js';
import { KnowledgeRepo, type CommitInfo, type LogOptions } from '../knowledge/repo.js';
import { IndexerService } from '../rag/indexer.service.js';
import { ActivityService } from './activity.service.js';
import { OpsController } from './ops.controller.js';

const stamp = '2026-01-02T00:00:00.000Z';
const viewer: User = { id: 1, email: 'viewer@example.test', name: 'Viewer', role: 'viewer', createdAt: stamp, lastLoginAt: null };
const admin: User = { ...viewer, id: 3, email: 'admin@example.test', role: 'admin' };
function commit(sha: string, at = stamp, source = 'web', jobId?: string): CommitInfo {
  return { sha, parents: [], authorName: 'Writer', authorEmail: 'writer@example.test', date: at,
    committedAt: at, committerName: '도니', committerEmail: 'dony@example.test', subject: 'Updated note', body: '',
    trailers: { 'Wiki-Source': source, ...(jobId ? { 'Wiki-Job': jobId } : {}) } };
}
function dream(id: string, at = stamp): DreamRun {
  return { id, startedAt: at, finishedAt: at, status: 'succeeded', fromSha: null, toSha: null, mergeSha: 'e'.repeat(40),
    pushed: true, error: null, summary: 'Daily summary', changedPaths: ['wiki/route.md', 'journal/2026-01-02.md'], journalPath: 'journal/2026-01-02.md',
    push: { status: 'succeeded', remote: 'origin', sha: 'a'.repeat(40), at, reason: null } };
}

describe('operations activity and REST', () => {
  let db: Db;
  let dreams: DreamRunsRepository;
  let jobRows: WriteJobsRepository;
  let activity: ActivityService;
  let commits: Array<CommitInfo & { files?: string[] }>;
  let app: INestApplication | undefined;
  let manual: ReturnType<typeof vi.fn<() => Promise<DreamRun>>>;
  let index: { status: ReturnType<typeof vi.fn>; reindex: ReturnType<typeof vi.fn> };
  let jobs: { retry: Mock; cancel: Mock; get: Mock; isResumable: Mock };

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
    for (const user of [viewer, { ...viewer, id: 2, email: 'other@example.test' }, admin]) {
      db.prepare('INSERT INTO users(id,email,role,created_at) VALUES(?,?,?,?)').run(user.id, user.email, user.role, stamp);
    }
    const users = new UsersService(new UsersRepository(db));
    dreams = new DreamRunsRepository(db);
    jobRows = new WriteJobsRepository(db);
    commits = [];
    const repo = {
      log: async (path?: string, options: Omit<LogOptions, 'path'> = {}) => {
        const matching = commits.filter((row) => !path || row.files?.includes(path));
        return options.limit === null ? matching : matching.slice(0, options.limit ?? 50);
      },
      diffNames: async (_from: string | null, sha: string) =>
        (commits.find((row) => row.sha === sha)?.files ?? ['wiki/route.md']).map((path) => ({ status: 'M' as const, path })),
      listFiles: async () => ['journal/2026-01-01.md', 'journal/2026-01-02.md', 'journal/not-a-date.md', 'journal/sub/2026-01-03.md'],
    } as unknown as KnowledgeRepo;
    activity = new ActivityService(db, repo, dreams, new AclService(db, users, new AuditService(db)), users);
    manual = vi.fn(async () => dream('0000000000000000000005'));
    index = { status: vi.fn(async () => ({ indexedSha: 'main', syncing: false })), reindex: vi.fn(async () => {}) };
    jobs = {
      get: vi.fn((id: string) => jobRows.get(id)),
      isResumable: vi.fn(async () => false),
      retry: vi.fn((id: string) => {
        const original = jobRows.get(id);
        if (!original) throw new ApiError(404, 'not_found', 'Write job not found');
        if (original.status !== 'failed') throw new ApiError(409, 'job_not_retryable', 'Only failed jobs can be retried');
        jobRows.enqueue('0000000000000000000006', original.userId, original.input, stamp, original.source);
        return jobRows.get('0000000000000000000006')!;
      }),
      cancel: vi.fn((id: string) => {
        if (!jobRows.cancelQueued(id, stamp)) throw new ApiError(409, 'job_not_cancelable', 'Only queued jobs can be canceled');
        return jobRows.get(id)!;
      }),
    };
  });

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    db.close();
  });

  function saveDream(run: DreamRun) {
    dreams.create(run);
    dreams.finish(run);
  }

  async function server() {
    const module = await Test.createTestingModule({
      controllers: [OpsController],
      providers: [RolesGuard,
        { provide: DB, useValue: db }, { provide: ActivityService, useValue: activity },
        { provide: DreamRunsRepository, useValue: dreams }, { provide: DreamingService, useValue: { runManual: manual } },
        { provide: WriteJobsService, useValue: jobs }, { provide: IndexerService, useValue: index }, AuditService],
    }).overrideGuard(SessionGuard).useValue({ canActivate: () => true }).compile();
    app = module.createNestApplication();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.user = req.headers['x-admin'] === '1' ? admin : viewer;
      next();
    });
    app.useGlobalFilters(new HttpExceptionFilter(pino({ level: 'silent' })));
    await app.init();
    return app.getHttpServer();
  }

  it('pages tied mixed sources without duplicates after a newer insertion', async () => {
    jobRows.enqueue('0000000000000000000003', 1, 'owner prompt', stamp, 'web');
    jobRows.enqueue('0000000000000000000001', 2, 'private other prompt', stamp, 'mcp');
    saveDream(dream('0000000000000000000004'));
    commits.push(commit('c'.repeat(40)), commit('b'.repeat(40)));
    const first = await activity.list({ limit: 2 }, viewer);
    expect(first.items.map((item) => [item.type, item.id])).toEqual([['job', '0000000000000000000003'], ['job', '0000000000000000000001']]);
    jobRows.enqueue('0000000000000000000002', 2, 'new private prompt', '2026-01-03T00:00:00.000Z', 'web');
    commits.unshift(commit('d'.repeat(40), '2026-01-03T00:00:00.000Z'));
    const second = await activity.list({ limit: 2, before: first.nextCursor! }, viewer);
    expect(second.items.map((item) => [item.type, item.id])).toEqual([['dream', '0000000000000000000004'], ['commit', 'c'.repeat(40)]]);
    const third = await activity.list({ limit: 2, before: second.nextCursor! }, viewer);
    expect(third.items.map((item) => [item.type, item.id])).toEqual([['commit', 'b'.repeat(40)], ['backup', '0000000000000000000004']]);
    expect(third.nextCursor).toBeNull();
  });

  it('retains arbitrarily old commit pages, including nonmonotonic git dates', async () => {
    for (let i = 0; i < 301; i++) commits.push(commit(i.toString(16).padStart(40, '0'), `2025-01-01T00:${Math.floor(i / 60).toString().padStart(2, '0')}:${(i % 60).toString().padStart(2, '0')}.000Z`));
    const ids: string[] = [];
    let before: string | undefined;
    do {
      const page = await activity.list({ limit: 37, before, type: 'commit' }, viewer);
      ids.push(...page.items.map((item) => item.id));
      before = page.nextCursor ?? undefined;
    } while (before);
    expect(ids).toEqual(Array.from({ length: 301 }, (_, i) => (300 - i).toString(16).padStart(40, '0')));
  });

  it('keeps API ID tie ordering across pages when SQLite storage ordering differs', async () => {
    for (const id of ['000000000000000000003M', '0000000000000000000001', '000000000000000000000C']) jobRows.enqueue(id, 1, 'prompt', stamp, 'web');
    const first = await activity.list({ limit: 1, type: 'job' }, viewer);
    const second = await activity.list({ limit: 1, type: 'job', before: first.nextCursor! }, viewer);
    const third = await activity.list({ limit: 1, type: 'job', before: second.nextCursor! }, viewer);
    expect([first.items[0]!.id, second.items[0]!.id, third.items[0]!.id]).toEqual(['000000000000000000003M', '000000000000000000000C', '0000000000000000000001']);
    expect(third.nextCursor).toBeNull();
  });

  it('filters path, source and type together and protects other users raw inputs and errors', async () => {
    jobRows.enqueue('0000000000000000000007', 1, 'visible owner prompt', stamp, 'web');
    jobRows.enqueue('0000000000000000000008', 2, 'secret other prompt', stamp, 'web');
    jobRows.markFailed('0000000000000000000008', 'error containing secret prompt', stamp);
    jobRows.enqueue('0000000000000000000009', 2, 'other file prompt', stamp, 'mcp');
    commits.push({ ...commit('a'.repeat(40), stamp, 'web', '0000000000000000000008'), files: ['wiki/route.md'] });
    const shared = await activity.list({ limit: 10, type: 'job' }, viewer);
    expect(shared.items.find((item) => item.id === '0000000000000000000007')!.job!.input).toBe('visible owner prompt');
    expect(shared.items.find((item) => item.id === '0000000000000000000008')!.job).not.toHaveProperty('input');
    expect(shared.items.find((item) => item.id === '0000000000000000000008')!.job).not.toHaveProperty('error');
    const filtered = await activity.list({ limit: 10, type: 'job', path: 'wiki/route.md', source: 'web' }, viewer);
    expect(filtered.items.map((item) => item.id)).toEqual(['0000000000000000000008']);
    expect(JSON.stringify(filtered)).not.toContain('secret');
    const privileged = await activity.list({ limit: 10, type: 'job' }, admin);
    expect(privileged.items.find((item) => item.id === '0000000000000000000008')!.job!.input).toBe('secret other prompt');
    await expect(activity.list({ limit: 10, before: 'bad-cursor' }, viewer)).rejects.toMatchObject({ status: 400, code: 'invalid_cursor' });
  });

  it('supports asset path activity while rejecting paths outside the repository', async () => {
    commits.push({ ...commit('a'.repeat(40)), files: ['assets/image.png'] });
    const http = await server();
    const feed = await request(http).get('/api/activity').query({ path: 'assets/image.png', type: 'commit' }).expect(200);
    expect(feed.body.items).toMatchObject([{ id: 'a'.repeat(40), type: 'commit', paths: ['assets/image.png'] }]);
    expect(feed.body.nextCursor).toBeNull();
    await request(http).get('/api/activity').query({ path: '../assets/image.png' }).expect(400);
    await request(http).get('/api/activity').query({ path: '.git/config' }).expect(400);
  });

  it('serves viewer dream list/detail, backup outcomes, and newest dated journals', async () => {
    saveDream(dream('000000000000000000000A', '2026-01-01T00:00:00.000Z'));
    saveDream(dream('000000000000000000000B'));
    const http = await server();
    const first = await request(http).get('/api/dreams?limit=1').expect(200);
    expect(first.body.runs.map((run: DreamRun) => run.id)).toEqual(['000000000000000000000B']);
    expect(first.body.nextCursor).toBe('000000000000000000000B');
    const second = await request(http).get('/api/dreams?limit=1&before=000000000000000000000B').expect(200);
    expect(second.body).toMatchObject({ runs: [{ id: '000000000000000000000A' }], nextCursor: null });
    const detail = await request(http).get('/api/dreams/000000000000000000000B').expect(200);
    expect(detail.body).toEqual(dream('000000000000000000000B'));
    await request(http).get('/api/dreams/000000000000000000000Z').expect(404);
    await request(http).get('/api/dreams?limit=0').expect(400);
    const backup = await request(http).get('/api/backup/status').expect(200);
    expect(backup.body).toMatchObject({ lastAttempt: { id: '000000000000000000000B' }, lastSuccess: { id: '000000000000000000000B' } });
    const journal = await request(http).get('/api/journal').expect(200);
    expect(journal.body).toEqual([
      { date: '2026-01-02', path: 'journal/2026-01-02.md', dreamRunId: '000000000000000000000B' },
      { date: '2026-01-01', path: 'journal/2026-01-01.md', dreamRunId: null },
    ]);
  });

  it('does not let an unmerged or unchanged later dream steal a published journal association', async () => {
    saveDream(dream('000000000000000000000C'));
    saveDream({ ...dream('000000000000000000000D', '2026-01-03T00:00:00.000Z'), status: 'failed', mergeSha: null, error: 'Journal validation failed' });
    saveDream({ ...dream('000000000000000000000E', '2026-01-04T00:00:00.000Z'), changedPaths: ['wiki/route.md'] });
    expect(await activity.journal(viewer)).toEqual([
      { date: '2026-01-02', path: 'journal/2026-01-02.md', dreamRunId: '000000000000000000000C' },
      { date: '2026-01-01', path: 'journal/2026-01-01.md', dreamRunId: null },
    ]);
  });

  it('reports admin queue states with sanitized failures and rejects viewer operations', async () => {
    jobRows.enqueue('000000000000000000000N', 1, 'queued private prompt', stamp, 'web');
    jobRows.enqueue('000000000000000000000O', 1, 'running private prompt', stamp, 'web');
    jobRows.markRunning('000000000000000000000O', stamp);
    jobRows.enqueue('000000000000000000000M', 2, 'merging private prompt', stamp, 'chat');
    jobRows.markMerging('000000000000000000000M', 'Merge summary', []);
    jobRows.enqueue('000000000000000000000L', 2, 'failed private prompt', stamp, 'mcp');
    jobRows.markFailed('000000000000000000000L', 'Provider failed', stamp);
    const http = await server();
    await request(http).get('/api/admin/ops').expect(403);
    await request(http).post('/api/admin/dreams/run').expect(403);
    const response = await request(http).get('/api/admin/ops').set('x-admin', '1').expect(200);
    expect(response.body.queue).toEqual({ queued: 1, running: 2, oldestQueuedAt: stamp });
    expect(response.body.failedJobs).toMatchObject([{ id: '000000000000000000000L', error: 'Provider failed' }]);
    expect(JSON.stringify(response.body.failedJobs)).not.toContain('private prompt');
    expect(response.body.index).toEqual({ indexedSha: 'main', syncing: false });
    const feed = await request(http).get('/api/activity?type=job&limit=2').expect(200);
    expect(feed.body.items.map((item: { id: string }) => item.id)).toEqual(['000000000000000000000O', '000000000000000000000N']);
  });

  it('audits manual run outcomes and propagates operational failures', async () => {
    const http = await server();
    const ok = await request(http).post('/api/admin/dreams/run').set('x-admin', '1').expect(201);
    expect(ok.body.status).toBe('succeeded');
    manual.mockResolvedValueOnce({ ...dream('000000000000000000000F'), status: 'failed', error: 'Dony failed' });
    const failedRun = await request(http).post('/api/admin/dreams/run').set('x-admin', '1').expect(201);
    expect(failedRun.body.status).toBe('failed');
    manual.mockRejectedValueOnce(new ApiError(503, 'unavailable', 'Dony unavailable'));
    await request(http).post('/api/admin/dreams/run').set('x-admin', '1').expect(503);
    const records = new AuditService(db).list({ limit: 10 }).events;
    expect(records.map((record) => [record.actorId, record.action, record.target, record.outcome])).toEqual([
      [3, 'dream.run', 'dreaming', 'failed'], [3, 'dream.run', '000000000000000000000F', 'failed'], [3, 'dream.run', '0000000000000000000005', 'succeeded'],
    ]);
  });

  it('audits retry, cancel and reindex successes and failures without suppressing errors', async () => {
    jobRows.enqueue('000000000000000000000L', 1, 'retry original', stamp, 'web');
    jobRows.markFailed('000000000000000000000L', 'Provider failed', stamp);
    jobRows.enqueue('000000000000000000000N', 1, 'cancel original', stamp, 'mcp');
    const http = await server();
    const retried = await request(http).post('/api/admin/jobs/000000000000000000000L/retry').set('x-admin', '1').expect(201);
    expect(retried.body.job).toMatchObject({ id: '0000000000000000000006', status: 'queued' });
    const canceled = await request(http).post('/api/admin/jobs/000000000000000000000N/cancel').set('x-admin', '1').expect(201);
    expect(canceled.body.job).toMatchObject({ id: '000000000000000000000N', status: 'failed', error: 'canceled' });
    await request(http).post('/api/admin/jobs/000000000000000000000N/cancel').set('x-admin', '1').expect(409);
    await request(http).post('/api/admin/jobs/000000000000000000000Z/retry').set('x-admin', '1').expect(404);
    await request(http).post('/api/admin/index/reindex').set('x-admin', '1').send({ full: true }).expect(201);
    index.reindex.mockRejectedValueOnce(new ApiError(503, 'index_unavailable', 'Embedding failed'));
    await request(http).post('/api/admin/index/reindex').set('x-admin', '1').send({ full: false }).expect(503);
    await request(http).post('/api/admin/index/reindex').set('x-admin', '1').send({ full: 'yes' }).expect(400);
    expect(new AuditService(db).list({ limit: 10 }).events.map((row) => [row.action, row.outcome])).toEqual([
      ['index.reindex', 'failed'], ['index.reindex', 'succeeded'], ['job.retry', 'failed'],
      ['job.cancel', 'failed'], ['job.cancel', 'succeeded'], ['job.retry', 'succeeded'],
    ]);
  });
});
