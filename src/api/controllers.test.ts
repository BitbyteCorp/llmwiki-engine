import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role, User } from '../auth/users.types.js';
import { UsersService } from '../auth/users.service.js';
import { SessionsService } from '../auth/sessions.service.js';
import { ApiTokensService } from '../auth/api-tokens.service.js';
import { assertSameOrigin } from '../auth/csrf.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter.js';
import { configureApp } from '../common/http/configure-app.js';
import { DB, LOGGER } from '../common/tokens.js';
import { openDb, runMigrations, type Db } from '../db/index.js';
import type { WriteJob } from '../jobs/write-job.types.js';
import { WriteJobsService } from '../jobs/write-jobs.service.js';
import { NoteWriterService } from '../jobs/note-writer.service.js';
import { KnowledgeRepo, type CommitInfo } from '../knowledge/repo.js';
import { LunaService } from '../luna/luna.service.js';
import { EventsService } from '../events/events.service.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { MeController } from './me.controller.js';
import { NotesController } from './notes.controller.js';
import { HistoryController } from './history.controller.js';
import { JobsController } from './jobs.controller.js';
import { ConversationsController } from './conversations.controller.js';
import { AdminController } from './admin.controller.js';
import { ConversationsRepository } from './conversations.repository.js';
import { ConversationsService } from './conversations.service.js';
import { GenerationsService } from './generations.service.js';
import type { Conversation, Message } from './conversations.types.js';
import { NotesService } from './notes.service.js';
import { HistoryService } from './history.service.js';


const head = 'a'.repeat(40);
const writeSha = 'b'.repeat(40);
const mergeSha = 'c'.repeat(40);
const stamp = '2026-01-01T00:00:00.000Z';
const note = '---\ntitle: Navigation\ntags:\n  - maps\n---\n# Navigation\n\nMain branch content.\n';
const commit = (sha: string): CommitInfo => ({
  sha, parents: [], authorName: 'Requester', authorEmail: 'requester@example.com',
  date: stamp, subject: `Change ${sha.slice(0, 7)}`, body: '',
  committerName: 'Luna', committerEmail: 'luna@example.com', committedAt: stamp, trailers: {},
});
const makeJob = (id: string, userId: number, commits: string[] = [], merged: string | null = null): WriteJob => ({
  id, userId, kind: 'luna', source: 'mcp', client: null, conflicts: [], input: 'Update navigation', status: 'succeeded',
  summary: 'Updated navigation', commits, mergeSha: merged, error: null,
  createdAt: stamp, startedAt: stamp, finishedAt: stamp,
});
type Answer = LunaService['answer'];
interface ConversationDetail { conversation: Conversation; messages: Message[] }

function parseEvents(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  return text.split(/\r?\n\r?\n/).filter((block) => block.trim()).map((block) => {
    const lines = block.split(/\r?\n/);
    const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
    const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
    if (!event) throw new Error('SSE event is missing its event name');
    return { event, data: JSON.parse(data) as Record<string, unknown> };
  });
}

function serviceError(status: number, code: string): Error & { status: number; code: string } {
  return Object.assign(new Error('Service operation rejected'), { status, code });
}

describe('web REST API', () => {
  let directory: string;
  let db: Db;
  let server: Server;
  let app: INestApplication;
  let origin: string;
  let userRows: Map<number, User>;
  let jobRows: Map<string, WriteJob>;
  let repo: {
    headSha: ReturnType<typeof vi.fn<() => Promise<string>>>;
    readFile: ReturnType<typeof vi.fn<(path: string, ref?: string) => Promise<string | null>>>;
    listFiles: ReturnType<typeof vi.fn<(prefix?: string, ref?: string) => Promise<string[]>>>;
    log: ReturnType<typeof vi.fn<(opts?: { path?: string; limit?: number; sinceSha?: string; beforeSha?: string }) => Promise<CommitInfo[]>>>;
    show: ReturnType<typeof vi.fn<(sha: string) => Promise<{ commit: CommitInfo; files: Array<{ status: 'M'; path: string }>; patch: string }>>>;
  };
  let answer: ReturnType<typeof vi.fn<Answer>>;
  let users: {
    getById: ReturnType<typeof vi.fn<(id: number) => User | null>>;
    list: ReturnType<typeof vi.fn<() => User[]>>;
    create: ReturnType<typeof vi.fn<(input: { email: string; name?: string | null; role: Role }) => User>>;
    update: ReturnType<typeof vi.fn<(id: number, input: { role?: Role; name?: string | null }) => User>>;
    delete: ReturnType<typeof vi.fn<(id: number) => void>>;
    getSettings: ReturnType<typeof vi.fn<() => { allowlistEnabled: boolean; allowedDomains: string[] }>>;
    setSettings: ReturnType<typeof vi.fn<(input: { allowlistEnabled?: boolean; allowedDomains?: string[] }) => { allowlistEnabled: boolean; allowedDomains: string[] }>>;
  };

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'llmwiki-api-'));
    db = openDb(join(directory, 'api.db'));
    runMigrations(db);
    userRows = new Map([1, 2, 3].map((id) => [id, {
      id, email: `user${id}@example.com`, name: `User ${id}`,
      role: id === 3 ? 'admin' as const : 'viewer' as const,
      createdAt: stamp, lastLoginAt: null,
    }]));
    for (const user of userRows.values()) {
      db.prepare('INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(user.id, user.email, user.name, user.role, user.createdAt);
    }
    jobRows = new Map();
    repo = {
      headSha: vi.fn(async () => head),
      readFile: vi.fn(async (path, ref = 'main') =>
        path === 'wiki/Navigation.md' && (ref === 'main' || ref === head) ? note : null),
      listFiles: vi.fn(async (_prefix, ref = 'main') =>
        ref === 'main' ? ['index.md', 'wiki/Navigation.md', 'journal/2026-01-01.md'] : ['wiki/Unmerged.md']),
      log: vi.fn(async () => [commit(head)]),
      show: vi.fn(async (sha) => ({ commit: commit(sha), files: [{ status: 'M' as const, path: 'wiki/Navigation.md' }], patch: '+Main branch content' })),
    };
    answer = vi.fn(async (_messages, delta, _signal, options) => {
      delta('Read ');
      delta('Navigation.');
      const usage = { inputTokens: 10, outputTokens: 4, reasoningTokens: 1 };
      options?.onEvent?.('citation', { path: 'wiki/Navigation.md' });
      options?.onEvent?.('usage', usage);
      return { text: 'Read Navigation.', citations: [{ path: 'wiki/Navigation.md' }], usage };
    });
    let settings = { allowlistEnabled: true, allowedDomains: ['example.com'] };
    users = {
      getById: vi.fn((id) => userRows.get(id) ?? null),
      list: vi.fn(() => [...userRows.values()]),
      create: vi.fn((input) => {
        const user = { ...input, id: 4, name: input.name ?? null, createdAt: stamp, lastLoginAt: null };
        userRows.set(user.id, user);
        return user;
      }),
      update: vi.fn((id, input) => {
        const current = userRows.get(id);
        if (!current) throw serviceError(404, 'not_found');
        if (current.role === 'admin' && input.role && input.role !== 'admin') throw serviceError(409, 'last_admin');
        const updated = { ...current, ...input };
        userRows.set(id, updated);
        return updated;
      }),
      delete: vi.fn((id) => {
        const current = userRows.get(id);
        if (!current) throw serviceError(404, 'not_found');
        if (current.role === 'admin') throw serviceError(409, 'last_admin');
        userRows.delete(id);
      }),
      getSettings: vi.fn(() => settings),
      setSettings: vi.fn((partial) => { settings = { ...settings, ...partial }; return settings; }),
    };
    const log = { error: vi.fn() };
    const module = await Test.createTestingModule({
      controllers: [
        MeController, NotesController, HistoryController,
        JobsController, ConversationsController, AdminController,
      ],
      providers: [
        ConversationsRepository, ConversationsService, GenerationsService, NotesService, HistoryService,
        SessionGuard, RolesGuard,
        { provide: DB, useValue: db },
        { provide: LOGGER, useValue: log },
        { provide: KnowledgeRepo, useValue: repo },
        { provide: NoteWriterService, useValue: {} },
        { provide: LunaService, useValue: { answer, validateModel: () => 'gpt-6-luna', validateEffort: (effort?: string) => effort ?? 'medium', summarize: async () => 'Summary', proposal: vi.fn() } },
        { provide: UploadsService, useValue: { parts: async () => [], get: vi.fn() } },
        { provide: EventsService, useValue: { publish: vi.fn() } },
        { provide: UsersService, useValue: users },
        { provide: ApiTokensService, useValue: { authenticate: vi.fn() } },
        { provide: SessionsService, useValue: {
          assertSameOrigin: (req: Request) => assertSameOrigin(req, new URL(origin).origin),
          sessionUser: (req: Request): User | null => {
            const id = req.get('x-user-id');
            if (!id) return null;
            return {
              id: Number(id), email: `user${id}@example.com`, name: `User ${id}`,
              role: (req.get('x-role') ?? 'viewer') as Role,
              createdAt: stamp, lastLoginAt: null,
            };
          },
        } },
        { provide: WriteJobsService, useValue: {
          get: (id: string) => jobRows.get(id) ?? null,
          events: () => [],
          list: (opts?: { userId?: number; limit?: number; before?: string }) => [...jobRows.values()]
            .filter((job) => opts?.userId === undefined || job.userId === opts.userId)
            .filter((job) => !opts?.before || job.createdAt < opts.before)
            .slice(0, opts?.limit),
        } },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    configureApp(app);
    app.useGlobalFilters(new HttpExceptionFilter(log as unknown as ConstructorParameters<typeof HttpExceptionFilter>[0]));
    await app.listen(0, '127.0.0.1');
    server = app.getHttpServer() as Server;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    origin = `http://127.0.0.1:${address.port}/api`;
  });

  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await app.close();
    }
    if (db?.open) db.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  function request(path: string, init: RequestInit = {}, userId: number | null = 1, role: Role = 'viewer'): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('origin', new URL(origin).origin);
    if (userId !== null) {
      headers.set('x-user-id', String(userId));
      headers.set('x-role', role);
    }
    if (typeof init.body === 'string') headers.set('content-type', 'application/json');
    return fetch(`${origin}${path}`, { ...init, headers });
  }
  async function expectError(response: Response, status: number, code: string): Promise<void> {
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code, message: expect.any(String) } });
  }
  async function createConversation(title?: string, userId = 1): Promise<Conversation> {
    const response = await request('/conversations', { method: 'POST', body: JSON.stringify(title === undefined ? {} : { title }) }, userId);
    expect(response.status).toBe(201);
    return (await response.json() as { conversation: Conversation }).conversation;
  }
  function seedJob(job: WriteJob): void {
    jobRows.set(job.id, job);
    db.prepare(`INSERT INTO write_jobs
      (id, user_id, source, input, status, summary, commits, merge_sha, error, created_at, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(job.id, job.userId, job.source, job.input, job.status, job.summary, JSON.stringify(job.commits), job.mergeSha,
        job.error, job.createdAt, job.startedAt, job.finishedAt);
  }

  it('rejects anonymous reads and non-admin administration but exposes the authenticated user', async () => {
    await expectError(await request('/me', {}, null), 401, 'unauthorized');
    await expectError(await request('/conversations', { method: 'POST', body: '{}' }, null), 401, 'unauthorized');
    for (const role of ['viewer', 'editor'] as const) {
      await expectError(await request('/admin/users', {}, 1, role), 403, 'forbidden');
      await expectError(await request('/admin/settings', { method: 'PUT', body: '{"allowlistEnabled":false}' }, 1, role), 403, 'forbidden');
    }
    expect(await (await request('/me')).json()).toMatchObject({ user: { id: 1, role: 'viewer', email: 'user1@example.com' } });
  });

  it('reads main Markdown with parsed frontmatter and resolves wikilinks by case-insensitive basename', async () => {
    expect(await (await request('/notes/tree')).json()).toEqual({ files: ['index.md', 'wiki/Navigation.md', 'journal/2026-01-01.md'] });
    const response = await request('/notes/content?path=wiki%2FNavigation.md');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path: 'wiki/Navigation.md', content: note,
      frontmatter: { title: 'Navigation', tags: ['maps'] },
      body: '# Navigation\n\nMain branch content.\n', updatedSha: head, ref: head,
    });
    expect(await (await request('/notes/resolve?name=nAvIgAtIoN')).json()).toEqual({ path: 'wiki/Navigation.md', candidates: ['wiki/Navigation.md'] });
    expect(await (await request('/notes/resolve?name=NAVIGATION.md')).json()).toEqual({ path: 'wiki/Navigation.md', candidates: ['wiki/Navigation.md'] });
    await expectError(await request('/notes/content?path=wiki%2FUnmerged.md'), 404, 'not_found');
    await expectError(await request('/notes/resolve?name=Missing'), 404, 'not_found');
  });

  it.each([
    '/notes/content', '/notes/content?path=..%2Fsecret.md', '/notes/content?path=%2Fsecret.md',
    '/notes/content?path=.git%2Fsecret.md', '/notes/content?path=wiki%5Csecret.md', '/notes/content?path=notes.txt',
    '/notes/content?path=.GIT%2Fsecret.md', '/notes/content?path=C%3A%2Fsecret.md',
    '/notes/resolve?name=%20', '/history?before=not-a-sha', '/history?limit=NaN', '/history/commits/not-a-sha',
    '/jobs?mine=2', '/jobs?before=not-a-date',
  ])('rejects invalid query input at %s', async (path) => {
    await expectError(await request(path), 400, 'invalid_input');
  });


  it.each(['commits', 'mergeSha'] as const)('links commit details to a write job through %s', async (source) => {
    const job = makeJob(`job-${source}`, 2, source === 'commits' ? [writeSha] : [], source === 'mergeSha' ? writeSha : null);
    seedJob(job);
    const response = await request(`/history/commits/${writeSha}`, {}, 3, 'admin');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      commit: commit(writeSha), files: [{ status: 'M', path: 'wiki/Navigation.md' }], patch: '+Main branch content', job,
    });
    expect(await (await request(`/history/commits/${head}`)).json()).toMatchObject({ job: null });
  });

  it('isolates job lists and details to owners while allowing administrators', async () => {
    const own = makeJob('own', 1, [writeSha], mergeSha);
    const other = makeJob('other', 2, [head]);
    seedJob(own);
    seedJob(other);
    expect(await (await request('/jobs?limit=2')).json()).toEqual({ jobs: [
      { ...own, user: { email: 'user1@example.com', name: 'User 1' } },
    ] });
    expect(await (await request('/jobs?limit=2', {}, 3, 'admin')).json()).toEqual({ jobs: [
      { ...own, user: { email: 'user1@example.com', name: 'User 1' } },
      { ...other, user: { email: 'user2@example.com', name: 'User 2' } },
    ] });
    await expectError(await request('/jobs/other'), 404, 'not_found');
    expect(await (await request('/jobs/other', {}, 3, 'admin')).json()).toMatchObject({ job: other });
    expect(await (await request('/jobs?mine=1')).json()).toEqual({ jobs: [{ ...own, user: { email: 'user1@example.com', name: 'User 1' } }] });
    expect(await (await request('/jobs/own')).json()).toEqual({
      job: own, user: { email: 'user1@example.com', name: 'User 1' }, commits: [commit(writeSha), commit(mergeSha)], events: [],
    });
    expect(await (await request(`/jobs?before=${encodeURIComponent(stamp)}`)).json()).toEqual({ jobs: [] });
    await expectError(await request('/jobs/missing'), 404, 'not_found');
  });

  it('isolates conversation list, read, send, and deletion from nonmembers even administrators', async () => {
    const owned = await createConversation('Private discussion');
    const other = await createConversation('Other discussion', 2);
    expect(await (await request('/conversations')).json()).toEqual({ conversations: [owned] });
    expect(await (await request('/conversations', {}, 2)).json()).toEqual({ conversations: [other] });
    for (const [id, role] of [[2, 'viewer'], [3, 'admin']] as const) {
      await expectError(await request(`/conversations/${owned.id}`, {}, id, role), 404, 'not_found');
      await expectError(await request(`/conversations/${owned.id}/messages`, { method: 'POST', body: '{"content":"Intrusion"}' }, id, role), 404, 'not_found');
      await expectError(await request(`/conversations/${owned.id}`, { method: 'DELETE' }, id, role), 404, 'not_found');
    }
    const detail = await (await request(`/conversations/${owned.id}`)).json() as ConversationDetail;
    expect(detail.messages).toEqual([]);
    expect(detail.conversation.title).toBe('Private discussion');
    expect(answer).not.toHaveBeenCalled();
    expect((await request(`/conversations/${owned.id}`, { method: 'DELETE' })).status).toBe(204);
    await expectError(await request(`/conversations/${owned.id}`), 404, 'not_found');
    expect(await (await request('/conversations')).json()).toEqual({ conversations: [] });
  });

  it('streams answers and persists turns, citation objects, and usage', async () => {
    const conversation = await createConversation();
    const response = await request(`/conversations/${conversation.id}/messages`, { method: 'POST', body: '{"content":"Where should I start?"}' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const events = parseEvents(await response.text());
    expect(events.filter(({ event }) => event === 'delta').map(({ data }) => data)).toEqual([{ text: 'Read ' }, { text: 'Navigation.' }]);
    expect(events[0]?.event).toBe('generation');
    expect(events.at(-1)?.event).toBe('done');
    const done = events.at(-1)!.data.message as Message;
    expect(done).toMatchObject({ role: 'assistant', content: 'Read Navigation.', status: 'completed', citations: [{ path: 'wiki/Navigation.md' }], usage: { inputTokens: 10, outputTokens: 4, reasoningTokens: 1 } });
    const detail = await (await request(`/conversations/${conversation.id}`)).json() as ConversationDetail;
    expect(detail.conversation.title).toBe('Where should I start?');
    expect(detail.messages).toEqual([
      expect.objectContaining({ id: expect.any(String), role: 'user', content: 'Where should I start?', citations: [], createdAt: expect.any(String) }), done,
    ]);
    const followup = await request(`/conversations/${conversation.id}/messages`, { method: 'POST', body: '{"content":"What next?"}' });
    await followup.text();
    const after = await (await request(`/conversations/${conversation.id}`)).json() as ConversationDetail;
    expect(after.messages.map(({ role, content, citations }) => ({ role, content, citations }))).toEqual([
      { role: 'user', content: 'Where should I start?', citations: [] },
      { role: 'assistant', content: 'Read Navigation.', citations: [{ path: 'wiki/Navigation.md' }] },
      { role: 'user', content: 'What next?', citations: [] },
      { role: 'assistant', content: 'Read Navigation.', citations: [{ path: 'wiki/Navigation.md' }] },
    ]);
    expect(after.conversation.title).toBe('Where should I start?');
  });

  it('continues generation after disconnect and replays its completed answer without another user turn', async () => {
    const conversation = await createConversation('Detached answer');
    let signal: AbortSignal | undefined;
    const pending = Promise.withResolvers<{ text: string; citations: Message['citations'] }>();
    const started = Promise.withResolvers<void>();
    answer.mockImplementation((_messages, delta, incomingSignal) => {
      signal = incomingSignal;
      delta('Starting');
      started.resolve();
      return pending.promise;
    });
    const controller = new AbortController();
    const response = await request(`/conversations/${conversation.id}/messages`, {
      method: 'POST', body: '{"content":"Slow question","clientId":"detached-turn"}', signal: controller.signal,
    });
    const reader = response.body!.getReader();
    await reader.read();
    await started.promise;
    controller.abort();
    pending.resolve({ text: 'Finished answer', citations: [] });
    const replay = await request(`/conversations/${conversation.id}/messages`, {
      method: 'POST', body: '{"content":"Slow question","clientId":"detached-turn"}',
    });
    expect(parseEvents(await replay.text()).at(-1)).toMatchObject({ event: 'done', data: { message: { content: 'Finished answer' } } });
    expect(signal?.aborted).toBe(false);
    const detail = await (await request(`/conversations/${conversation.id}`)).json() as ConversationDetail;
    expect(detail.messages.map(({ role, content, status }) => ({ role, content, status }))).toEqual([
      { role: 'user', content: 'Slow question', status: 'completed' },
      { role: 'assistant', content: 'Finished answer', status: 'completed' },
    ]);
  });

  it('emits a generic SSE error without done and stores a failed assistant on answer failure', async () => {
    const conversation = await createConversation('Failed answer');
    answer.mockRejectedValueOnce(new Error('Model unavailable'));
    const response = await request(`/conversations/${conversation.id}/messages`, { method: 'POST', body: '{"content":"Question"}' });
    const events = parseEvents(await response.text());
    expect(events.at(-1)).toMatchObject({ event: 'error', data: { code: 'generation_failed', message: expect.any(String) } });
    expect(events.some(({ event }) => event === 'done')).toBe(false);
    const detail = await (await request(`/conversations/${conversation.id}`)).json() as ConversationDetail;
    expect(detail.messages.map(({ role, content, status }) => ({ role, content, status }))).toEqual([
      { role: 'user', content: 'Question', status: 'completed' },
      { role: 'assistant', content: '', status: 'failed' },
    ]);
  });

  it('rejects malformed chat input before starting an answer', async () => {
    await expectError(await request('/conversations', { method: 'POST', body: JSON.stringify({ title: 'x'.repeat(201) }) }), 400, 'invalid_input');
    const conversation = await createConversation('Valid');
    for (const body of [{}, { content: '' }, { content: ' \n ' }, { content: 42 }, { content: 'x'.repeat(100001) }]) {
      await expectError(await request(`/conversations/${conversation.id}/messages`, { method: 'POST', body: JSON.stringify(body) }), 400, 'invalid_input');
    }
    expect(answer).not.toHaveBeenCalled();
    expect((await (await request(`/conversations/${conversation.id}`)).json() as ConversationDetail).messages).toEqual([]);
  });

  it('allows admin user and settings management while preserving partial settings', async () => {
    expect(await (await request('/admin/users', {}, 3, 'admin')).json()).toEqual({ users: [...userRows.values()] });
    const created = await request('/admin/users', { method: 'POST', body: '{"email":"new@example.com","name":"New editor","role":"editor"}' }, 3, 'admin');
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ user: { id: 4, email: 'new@example.com', name: 'New editor', role: 'editor' } });
    expect(await (await request('/admin/users/4', { method: 'PATCH', body: '{"role":"viewer"}' }, 3, 'admin')).json()).toMatchObject({ user: { id: 4, role: 'viewer' } });
    expect((await request('/admin/users/4', { method: 'DELETE' }, 3, 'admin')).status).toBe(204);
    const remaining = await (await request('/admin/users', {}, 3, 'admin')).json() as { users: User[] };
    expect(remaining.users.map(({ id }) => id)).toEqual([1, 2, 3]);
    expect(await (await request('/admin/settings', {}, 3, 'admin')).json()).toEqual({ allowlistEnabled: true, allowedDomains: ['example.com'] });
    expect(await (await request('/admin/settings', { method: 'PUT', body: '{"allowlistEnabled":false}' }, 3, 'admin')).json()).toEqual({ allowlistEnabled: false, allowedDomains: ['example.com'] });
    expect(await (await request('/admin/settings', { method: 'PUT', body: '{"allowedDomains":["new.example.com"]}' }, 3, 'admin')).json()).toEqual({ allowlistEnabled: false, allowedDomains: ['new.example.com'] });
  });

  it('returns last-admin conflicts for deletion and demotion and preserves the administrator', async () => {
    await expectError(await request('/admin/users/3', { method: 'DELETE' }, 3, 'admin'), 409, 'last_admin');
    await expectError(await request('/admin/users/3', { method: 'PATCH', body: '{"role":"viewer"}' }, 3, 'admin'), 409, 'last_admin');
    expect(await (await request('/admin/users', {}, 3, 'admin')).json()).toMatchObject({ users: expect.arrayContaining([expect.objectContaining({ id: 3, role: 'admin' })]) });
    await expectError(await request('/admin/users/999', { method: 'DELETE' }, 3, 'admin'), 404, 'not_found');
    users.create.mockImplementationOnce(() => { throw serviceError(409, 'conflict'); });
    await expectError(await request('/admin/users', { method: 'POST', body: '{"email":"user1@example.com","role":"viewer"}' }, 3, 'admin'), 409, 'conflict');
  });

  it.each([
    ['POST', '/admin/users', { email: 'not-an-email', role: 'viewer' }],
    ['POST', '/admin/users', { email: 'new@example.com', role: 'owner' }],
    ['PATCH', '/admin/users/1', {}],
    ['PATCH', '/admin/users/-1', { name: 'Changed' }],
    ['PUT', '/admin/settings', { allowlistEnabled: 'false' }],
    ['PUT', '/admin/settings', { allowedDomains: ['https://example.com'] }],
  ])('rejects invalid admin input for %s %s', async (method, path, body) => {
    await expectError(await request(path as string, { method: method as string, body: JSON.stringify(body) }, 3, 'admin'), 400, 'invalid_input');
  });

  it('returns a structured internal error when a read service fails', async () => {
    repo.readFile.mockRejectedValueOnce(new Error('Private upstream credentials'));
    const response = await request('/notes/content?path=wiki%2FNavigation.md');
    const leaked = await response.clone().text();
    expect(leaked).not.toContain('Private upstream credentials');
    await expectError(response, 500, 'internal_error');
  });
});
