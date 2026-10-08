import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import pino from 'pino';
import request from 'supertest';
import type { Response } from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { CONFIG, DB, LOGGER } from '../common/tokens.js';
import { loadConfig } from '../config.js';
import { openDb, runMigrations, type Db } from '../db/index.js';
import type { DreamRun } from '../dreaming/dream-run.types.js';
import { DreamRunsRepository } from '../dreaming/dream-runs.repository.js';
import { DreamingService } from '../dreaming/dreaming.service.js';
import { EventsController } from '../events/events.controller.js';
import { EventsService } from '../events/events.service.js';
import { ExportController } from '../export/export.controller.js';
import { ExportService } from '../export/export.service.js';
import { git } from '../export/git.js';
import { WriteJobsRepository } from '../jobs/write-jobs.repository.js';
import { WriteJobsService } from '../jobs/write-jobs.service.js';
import { KnowledgeRepo } from '../knowledge/repo.js';
import { IndexerService } from '../rag/indexer.service.js';
import { ActivityService, type ActivityItem } from './activity.service.js';
import { OpsController } from './ops.controller.js';

// Keep real filesystem behavior; selected tests pause a real IO boundary to exercise revocation races.
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof FsPromises>();
  return { ...original, mkdtemp: vi.fn(original.mkdtemp), writeFile: vi.fn(original.writeFile) };
});

const stamp = '2026-01-02T00:00:00.000Z';
const hidden = 'wiki/private/secret.md';
const publicPath = 'wiki/public.md';
const secret = 'CLASSIFIED_FACT';

describe('public operations, live events and archives obey folder ACL', () => {
  let root: string;
  let db: Db;
  let app: INestApplication;
  let users: UsersService;
  let acl: AclService;
  let viewer: User;
  let collaborator: User;
  let admin: User;
  let tokens: Record<string, string>;
  let events: EventsService;
  let origin: string;
  let hiddenSha: string;
  let mixedSha: string;
  const connections: AbortController[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'llmwiki-acl-ops-'));
    const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: root });
    const log = pino({ level: 'silent' });
    db = openDb(join(root, 'llmwiki.db'));
    runMigrations(db);
    users = new UsersService(new UsersRepository(db));
    viewer = users.create({ email: 'reader@example.test', role: 'viewer' });
    collaborator = users.create({ email: 'collaborator@example.test', role: 'editor' });
    admin = users.create({ email: 'admin@example.test', role: 'admin' });
    users.create({ email: 'guardian@example.test', role: 'admin' });
    const audit = new AuditService(db);
    acl = new AclService(db, users, audit);
    acl.create({ prefix: 'wiki/private/', subjectType: 'everyone', subject: '', access: 'none' }, admin);
    acl.create({ prefix: 'journal/2026-01-02.md', subjectType: 'everyone', subject: '', access: 'none' }, admin);
    acl.create({ prefix: 'wiki/private/', subjectType: 'user', subject: String(collaborator.id), access: 'read' }, admin);
    const auth = new ApiTokensService(new ApiTokensRepository(db), users, audit);
    tokens = Object.fromEntries([viewer, collaborator, admin].map((user) => [String(user.id), auth.create(user, { name: 'test', scopes: ['read', 'write'] }).token]));
    const path = join(root, 'knowledge');
    await mkdir(join(path, 'wiki/private'), { recursive: true });
    await mkdir(join(path, 'journal'));
    await git(path, ['init', '-b', 'main']);
    await git(path, ['config', 'user.name', 'ACL Test']);
    await git(path, ['config', 'user.email', 'acl@example.test']);
    await writeFile(join(path, publicPath), '# Public\nAllowed fact\n');
    await writeFile(join(path, 'journal/2026-01-01.md'), '# Public journal\n');
    await git(path, ['add', '.']);
    await git(path, ['commit', '-m', 'Public notes']);
    await writeFile(join(path, hidden), `# Secret\n${secret}\n`);
    await writeFile(join(path, 'journal/2026-01-02.md'), `# Journal\n${secret}\n`);
    await git(path, ['add', '.']);
    await git(path, ['commit', '-m', `${secret}\n\nWiki-Source: web\nWiki-Job: 000000000000000000000I`]);
    hiddenSha = (await git(path, ['rev-parse', 'HEAD'])).trim();
    await writeFile(join(path, publicPath), '# Public\nAllowed revised fact\n');
    await writeFile(join(path, hidden), `# Secret\n${secret} revised\n`);
    await git(path, ['add', '.']);
    await git(path, ['commit', '-m', `${secret} mixed update\n\nWiki-Source: web\nWiki-Job: 000000000000000000000J`]);
    mixedSha = (await git(path, ['rev-parse', 'HEAD'])).trim();
    const repo = await KnowledgeRepo.open(config, log);
    const dreams = new DreamRunsRepository(db);
    for (const [id, changedPaths, journalPath] of [
      ['000000000000000000000G', [hidden, 'journal/2026-01-02.md'], 'journal/2026-01-02.md'],
      ['000000000000000000000H', [hidden, publicPath], null],
    ] as const) {
      const run: DreamRun = { id, startedAt: stamp, finishedAt: stamp, status: 'succeeded', fromSha: null,
        toSha: mixedSha, mergeSha: mixedSha, pushed: true, summary: secret, changedPaths: [...changedPaths], journalPath,
        error: `Error ${hidden} ${secret}`, push: { status: 'succeeded', remote: 'origin', sha: mixedSha, at: stamp, reason: `${hidden} ${secret}` } };
      dreams.create(run);
      dreams.finish(run);
    }
    const jobs = new WriteJobsRepository(db);
    jobs.enqueue('000000000000000000000I', viewer.id, secret, stamp, 'web');
    jobs.addEvent('000000000000000000000I', 'queued', { sourceProvenanceComplete: true });
    jobs.markMerging('000000000000000000000I', secret, [hiddenSha]);
    jobs.recordConflicts('000000000000000000000I', [hidden]);
    jobs.enqueue('000000000000000000000J', viewer.id, secret, stamp, 'web');
    jobs.addEvent('000000000000000000000J', 'queued', { sourceProvenanceComplete: true });
    jobs.markMerging('000000000000000000000J', secret, [mixedSha]);
    jobs.recordConflicts('000000000000000000000J', [hidden, publicPath]);
    events = new EventsService();
    const module = await Test.createTestingModule({
      controllers: [OpsController, EventsController, ExportController],
      providers: [ActivityService, ExportService, SessionGuard, RolesGuard,
        { provide: CONFIG, useValue: config }, { provide: DB, useValue: db }, { provide: LOGGER, useValue: log },
        { provide: AclService, useValue: acl }, { provide: UsersService, useValue: users },
        { provide: AuditService, useValue: audit }, { provide: ApiTokensService, useValue: auth },
        { provide: SessionsService, useValue: new SessionsService(config, db, users) },
        { provide: KnowledgeRepo, useValue: repo }, { provide: DreamRunsRepository, useValue: dreams },
        { provide: DreamingService, useValue: { runManual: async () => dreams.get('000000000000000000000H')! } },
        { provide: WriteJobsService, useValue: {} }, { provide: IndexerService, useValue: {} },
        { provide: EventsService, useValue: events }],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new HttpExceptionFilter(log));
    await app.listen(0, '127.0.0.1');
    origin = await app.getUrl();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const connection of connections.splice(0)) connection.abort();
    if (app) await app.close();
    if (db?.open) db.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  function get(path: string, user = viewer) {
    return request(app.getHttpServer()).get(path).auth(tokens[String(user.id)], { type: 'bearer' });
  }

  it('projects dream details, backup status, journal and activity without hidden summaries or paths and pages visible items', async () => {
    for (const path of ['/api/dreams', '/api/dreams/000000000000000000000G', '/api/dreams/000000000000000000000H', '/api/backup/status', '/api/activity']) {
      const response = await get(path).expect(200);
      expect(JSON.stringify(response.body)).not.toContain(hidden);
      expect(JSON.stringify(response.body)).not.toContain('journal/2026-01-02.md');
      expect(JSON.stringify(response.body)).not.toContain(secret);
    }
    const dream = await get('/api/dreams/000000000000000000000G').expect(200);
    expect(dream.body).toMatchObject({ changedPaths: [], journalPath: null, summary: null, error: null, push: { reason: null } });
    const mixed = await get('/api/dreams/000000000000000000000H').expect(200);
    expect(mixed.body).toMatchObject({ changedPaths: [publicPath], summary: null });
    const journal = await get('/api/journal').expect(200);
    expect(journal.body).toEqual([{ date: '2026-01-01', path: 'journal/2026-01-01.md', dreamRunId: null }]);
    const denied = await get(`/api/activity?path=${hidden}`).expect(404);
    expect(denied.body.error.code).toBe('not_found');
    const full = await get('/api/activity?limit=100').expect(200);
    expect(full.body.items.some((item: ActivityItem) => item.id === hiddenSha || item.id === '000000000000000000000I')).toBe(false);
    expect(full.body.items.find((item: ActivityItem) => item.id === '000000000000000000000J')).toMatchObject({ paths: [publicPath], summary: null, job: { conflicts: [publicPath], commits: [] } });
    const ids: string[] = [];
    let before: string | null = null;
    do {
      const page: Response = await get(`/api/activity?limit=1${before ? `&before=${before}` : ''}`).expect(200);
      ids.push(...page.body.items.map((item: ActivityItem) => `${item.type}:${item.id}`));
      before = page.body.nextCursor;
    } while (before);
    expect(ids).toEqual(full.body.items.map((item: ActivityItem) => `${item.type}:${item.id}`));
    const first = await get('/api/activity?limit=1').expect(200);
    await get(`/api/activity?limit=1&before=${first.body.nextCursor}`, collaborator).expect(400);
    acl.create({ prefix: 'wiki/extra/', subjectType: 'everyone', subject: '', access: 'none' }, admin);
    await get(`/api/activity?limit=1&before=${first.body.nextCursor}`).expect(400);
    const allowed = await get('/api/activity?type=commit', collaborator).expect(200);
    expect(allowed.body.items.find((item: ActivityItem) => item.id === mixedSha).summary).toContain(secret);
    const sharedDream = await get('/api/dreams/000000000000000000000H', collaborator).expect(200);
    expect(sharedDream.body).toMatchObject({ changedPaths: [hidden, publicPath], summary: secret });
    const firstDream = await get('/api/dreams?limit=1').expect(200);
    expect(firstDream.body.runs.map((run: DreamRun) => run.id)).toEqual(['000000000000000000000H']);
    const secondDream = await get(`/api/dreams?limit=1&before=${firstDream.body.nextCursor}`).expect(200);
    expect(secondDream.body).toMatchObject({ runs: [{ id: '000000000000000000000G', changedPaths: [], summary: null }], nextCursor: null });
    const bypass = await get('/api/dreams/000000000000000000000G', admin).expect(200);
    expect(bypass.body.changedPaths).toContain(hidden);
    expect(bypass.body.summary).toBe(secret);
    await request(app.getHttpServer()).post('/api/admin/dreams/run').auth(tokens[String(collaborator.id)], { type: 'bearer' }).expect(403);
  });

  it('downloads and unzips only readable committed files, including allowed descendants of a denied prefix', async () => {
    const response = await fetch(`${origin}/api/export?prefix=wiki/`, { headers: { Authorization: `Bearer ${tokens[String(viewer.id)]}` } });
    expect(response.status).toBe(200);
    const archive = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(Object.keys(archive).sort()).toEqual(['manifest.json', 'wiki/', publicPath]);
    expect(strFromU8(archive[publicPath])).toBe('# Public\nAllowed revised fact\n');
    expect(JSON.stringify(response.headers.get('x-export-manifest'))).not.toContain(hidden);
    expect(strFromU8(archive['manifest.json'])).not.toContain(hidden);
    await get('/api/export?prefix=wiki/private/').expect(404);
    const whole = await fetch(`${origin}/api/export`, { headers: { Authorization: `Bearer ${tokens[String(viewer.id)]}` } });
    expect(whole.status).toBe(200);
    const wholeArchive = unzipSync(new Uint8Array(await whole.arrayBuffer()));
    expect(Object.keys(wholeArchive).sort()).toEqual(['journal/', 'journal/2026-01-01.md', 'manifest.json', 'wiki/', publicPath]);
    const shared = await fetch(`${origin}/api/export?prefix=wiki/private/`, { headers: { Authorization: `Bearer ${tokens[String(collaborator.id)]}` } });
    expect(shared.status).toBe(200);
    expect(strFromU8(unzipSync(new Uint8Array(await shared.arrayBuffer()))[hidden])).toContain(secret);
    acl.create({ prefix: hidden, subjectType: 'user', subject: String(viewer.id), access: 'read' }, admin);
    const nested = await fetch(`${origin}/api/export?prefix=wiki/private/`, { headers: { Authorization: `Bearer ${tokens[String(viewer.id)]}` } });
    expect(nested.status).toBe(200);
    const nestedArchive = unzipSync(new Uint8Array(await nested.arrayBuffer()));
    expect(strFromU8(nestedArchive[hidden])).toContain(secret);
    await get('/api/export?format=bundle').expect(403);
    const bypass = await fetch(`${origin}/api/export?prefix=wiki/private/`, { headers: { Authorization: `Bearer ${tokens[String(admin.id)]}` } });
    expect(bypass.status).toBe(200);
    expect(strFromU8(unzipSync(new Uint8Array(await bypass.arrayBuffer()))[hidden])).toContain(secret);
  });

  it('filters real SSE frames per subscriber, drops hidden-only updates and applies policy edits and role demotion live', async () => {
    const streams = await Promise.all([viewer, collaborator, admin].map(async (user) => {
      const connection = new AbortController();
      connections.push(connection);
      const response = await fetch(`${origin}/api/events`, { headers: { Authorization: `Bearer ${tokens[String(user.id)]}` }, signal: connection.signal });
      expect(response.status).toBe(200);
      return response.body!.getReader();
    }));
    async function until(reader: ReadableStreamDefaultReader<Uint8Array>, marker: string) {
      let text = '';
      while (!text.includes(marker)) {
        const next = await reader.read();
        if (next.done) throw new Error('SSE closed before marker');
        text += new TextDecoder().decode(next.value);
      }
      return text;
    }
    events.publish({ type: 'main.updated', sha: 'hidden-only', paths: [hidden] }, 'all');
    events.publish({ type: 'main.updated', sha: 'mixed-barrier', paths: [hidden, publicPath] }, 'all');
    const frames = await Promise.all(streams.map((stream) => until(stream, 'mixed-barrier')));
    expect(frames[0]).not.toContain('hidden-only');
    expect(frames[0]).not.toContain(hidden);
    expect(frames[0]).toContain(publicPath);
    expect(frames[1]).toContain(hidden);
    expect(frames[2]).toContain(hidden);
    users.update(admin.id, { role: 'viewer' });
    acl.create({ prefix: publicPath, subjectType: 'everyone', subject: '', access: 'none' }, users.getByEmail('guardian@example.test')!);
    events.publish({ type: 'main.updated', sha: 'newly-hidden', paths: [publicPath, hidden] }, 'all');
    events.publish({ type: 'main.updated', sha: 'live-policy-barrier', paths: ['journal/2026-01-01.md'] }, 'all');
    const demoted = await until(streams[2], 'live-policy-barrier');
    expect(demoted).not.toContain('newly-hidden');
    expect(demoted).not.toContain(hidden);
    const updated = await until(streams[0], 'live-policy-barrier');
    expect(updated).not.toContain('newly-hidden');
  });

  it('closes an existing SSE subscription when a deleted numeric user ID is reused by an administrator', async () => {
    const originalId = new UsersRepository(db).create('temporary-reader@example.test', null, 'viewer', stamp);
    const original = users.getById(originalId)!;
    const auth = app.get(ApiTokensService);
    const token = auth.create(original, { name: 'temporary', scopes: ['read'] }).token;
    const connection = new AbortController();
    connections.push(connection);
    const response = await fetch(`${origin}/api/events`, {
      headers: { Authorization: `Bearer ${token}` }, signal: connection.signal,
    });
    expect(response.status).toBe(200);
    const stream = response.body!.getReader();
    const initial = await stream.read();
    expect(new TextDecoder().decode(initial.value)).toContain(': connected');
    users.delete(original.id);
    // Explicit legacy/external ID reuse bypasses the repository's monotonic allocation.
    db.prepare('INSERT INTO users(id,email,role,created_at) VALUES(?,?,?,?)')
      .run(original.id, original.email, 'admin', '2026-02-03T00:00:00.000Z');
    events.publish({ type: 'main.updated', sha: 'replacement-only', paths: [hidden] }, 'all');
    const afterReplacement = await stream.read();
    expect(afterReplacement.done).toBe(true);
    expect(new TextDecoder().decode(afterReplacement.value)).not.toContain(hidden);
  });

  it.each(['policy', 'role'] as const)('discards activity projected before an in-flight %s change', async (change) => {
    const repo = app.get(KnowledgeRepo);
    const actualDiff = repo.diffNames.bind(repo);
    const entered = Promise.withResolvers<void>();
    const resumed = Promise.withResolvers<void>();
    let calls = 0;
    vi.spyOn(repo, 'diffNames').mockImplementation(async (...args) => {
      if (++calls === 2) { entered.resolve(); await resumed.promise; }
      return actualDiff(...args);
    });
    const response = get('/api/activity?type=commit', admin).then((result) => result);
    await entered.promise;
    if (change === 'policy') acl.create({ prefix: publicPath, subjectType: 'everyone', subject: '', access: 'none' }, admin);
    else users.update(admin.id, { role: 'viewer' });
    resumed.resolve();
    const result = await response;
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe('forbidden');
    expect(JSON.stringify(result.body)).not.toContain(secret);
    expect(JSON.stringify(result.body)).not.toContain(hidden);
  });

  it('discards a journal response when its requesting administrator is demoted during repository IO', async () => {
    const repo = app.get(KnowledgeRepo);
    const actualList = repo.listFiles.bind(repo);
    const entered = Promise.withResolvers<void>();
    const resumed = Promise.withResolvers<void>();
    vi.spyOn(repo, 'listFiles').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await resumed.promise;
      return actualList(...args);
    });
    const response = get('/api/journal', admin).then((result) => result);
    await entered.promise;
    users.update(admin.id, { role: 'viewer' });
    resumed.resolve();
    const result = await response;
    expect(result.status).toBe(403);
    expect(JSON.stringify(result.body)).not.toContain('journal/2026-01-02.md');
  });

  it.each(['policy', 'role'] as const)('discards ZIP selection after an in-flight %s change while writing its manifest', async (change) => {
    const actualFs = await vi.importActual<typeof FsPromises>('node:fs/promises');
    const entered = Promise.withResolvers<void>();
    const resumed = Promise.withResolvers<void>();
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
      entered.resolve();
      await resumed.promise;
      return actualFs.writeFile(...args);
    });
    const response = get('/api/export?prefix=wiki/', admin).then((result) => result);
    await entered.promise;
    if (change === 'policy') acl.create({ prefix: publicPath, subjectType: 'everyone', subject: '', access: 'none' }, admin);
    else users.update(admin.id, { role: 'viewer' });
    resumed.resolve();
    const result = await response;
    expect(result.status).toBe(403);
    expect(result.headers['x-export-manifest']).toBeUndefined();
    expect(result.body.error.code).toBe('forbidden');
    expect(JSON.stringify(result.body)).not.toContain(secret);
  });

  it('rejects a history bundle when the first ACL rule is added while allocating its temporary directory', async () => {
    for (const rule of acl.list()) acl.delete(rule.id, admin);
    const actualFs = await vi.importActual<typeof FsPromises>('node:fs/promises');
    const entered = Promise.withResolvers<void>();
    const resumed = Promise.withResolvers<void>();
    vi.mocked(mkdtemp).mockImplementationOnce(async (...args) => {
      const directory = await actualFs.mkdtemp(...args);
      entered.resolve();
      await resumed.promise;
      return directory;
    });
    const response = get('/api/export?format=bundle').then((result) => result);
    await entered.promise;
    acl.create({ prefix: 'wiki/private/', subjectType: 'everyone', subject: '', access: 'none' }, admin);
    resumed.resolve();
    const result = await response;
    expect(result.status).toBe(403);
    expect(result.headers['x-export-head']).toBeUndefined();
    expect(result.body.error.code).toBe('forbidden');
  });

  it('redacts owner activity from revoked recorded sources and legacy unknown provenance despite public-only changes', async () => {
    const grant = acl.create({ prefix: hidden, subjectType: 'user', subject: String(viewer.id), access: 'read' }, admin);
    const repo = app.get(KnowledgeRepo);
    const publicCommit = (await repo.log({ limit: null })).find((commit) => commit.subject === 'Public notes')!;
    const jobs = new WriteJobsRepository(db);
    for (const [id, detail] of [
      ['000000000000000000000P', { sourcePath: hidden }],
      ['000000000000000000000Q', { sourcePaths: [hidden] }],
    ] as const) {
      jobs.enqueue(id, viewer.id, secret, stamp, 'web');
      jobs.addEvent(id, 'queued', { sourceProvenanceComplete: true });
      jobs.addEvent(id, 'editing', detail);
      jobs.markMerging(id, secret, [publicCommit.sha]);
      jobs.recordConflicts(id, [publicPath]);
      jobs.markFailed(id, `Error includes ${secret}`, stamp);
    }
    jobs.enqueue('000000000000000000000R', viewer.id, secret, stamp, 'web');
    jobs.markMerging('000000000000000000000R', secret, [publicCommit.sha]);
    jobs.enqueue('000000000000000000000S', viewer.id, 'Known public request', stamp, 'web');
    jobs.addEvent('000000000000000000000S', 'queued', { sourceProvenanceComplete: true });
    jobs.markMerging('000000000000000000000S', 'Public summary', [publicCommit.sha]);
    const beforeRevocation = await get('/api/activity?type=job&limit=100').expect(200);
    expect(beforeRevocation.body.items.find((item: ActivityItem) => item.id === '000000000000000000000P').job.input).toBe(secret);
    acl.delete(grant.id, admin);
    const response = await get('/api/activity?type=job&limit=100').expect(200);
    for (const id of ['000000000000000000000P', '000000000000000000000Q', '000000000000000000000R']) {
      const item = response.body.items.find((item: ActivityItem) => item.id === id);
      expect(item).toMatchObject({ summary: null, job: { summary: null, commits: [], conflicts: [], mergeSha: null } });
      expect(item.paths).toContain(publicPath);
      expect(item.job).not.toHaveProperty('input');
      expect(item.job).not.toHaveProperty('error');
      expect(JSON.stringify(item)).not.toContain(secret);
      expect(JSON.stringify(item)).not.toContain(hidden);
    }
    expect(response.body.items.find((item: ActivityItem) => item.id === '000000000000000000000S'))
      .toMatchObject({ summary: 'Public summary', job: { input: 'Known public request', summary: 'Public summary' } });
    for (const reader of [collaborator, admin]) {
      const allowed = await get('/api/activity?type=job&limit=100', reader).expect(200);
      expect(allowed.body.items.find((item: ActivityItem) => item.id === '000000000000000000000P').summary).toBe(secret);
    }
  });
});
