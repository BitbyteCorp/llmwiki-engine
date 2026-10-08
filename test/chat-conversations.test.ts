import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationsController } from '../src/api/conversations.controller.js';
import { ConversationsRepository } from '../src/api/conversations.repository.js';
import { ConversationsService } from '../src/api/conversations.service.js';
import type { Conversation, Message, SubmitMessage } from '../src/api/conversations.types.js';
import { GenerationsController } from '../src/api/generations.controller.js';
import { GenerationsService } from '../src/api/generations.service.js';
import { ApiTokensService } from '../src/auth/api-tokens.service.js';
import { assertSameOrigin } from '../src/auth/csrf.js';
import { RolesGuard } from '../src/auth/guards/roles.guard.js';
import { SessionGuard } from '../src/auth/guards/session.guard.js';
import { SessionsService } from '../src/auth/sessions.service.js';
import type { User } from '../src/auth/users.types.js';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter.js';
import { configureApp } from '../src/common/http/configure-app.js';
import { DB, LOGGER } from '../src/common/tokens.js';
import { loadConfig } from '../src/config.js';
import { openDb, runMigrations } from '../src/db/index.js';
import { EventsService } from '../src/events/events.service.js';
import type { EventAudience, WikiEvent } from '../src/events/events.types.js';
import { KnowledgeRepo } from '../src/knowledge/repo.js';
import { AgentService } from '../src/agent/agent.service.js';
import { SearchService } from '../src/rag/search.service.js';
import { UploadsService } from '../src/uploads/uploads.service.js';
import { startFakeOpenAI, type FakeScript } from './fake-openai.js';
import { AclService } from '../src/acl/acl.service.js';
import { AuditService } from '../src/audit/audit.service.js';
import { UsersService } from '../src/auth/users.service.js';
import { UsersRepository } from '../src/auth/users.repository.js';

interface Frame { id: number; event: string; data: Record<string, unknown> }
function frames(text: string): Frame[] {
  return text.split(/\r?\n\r?\n/).filter(block => block.includes('event:')).map(block => {
    const lines = block.split(/\r?\n/);
    return {
      id: Number(lines.find(line => line.startsWith('id:'))!.slice(3).trim()),
      event: lines.find(line => line.startsWith('event:'))!.slice(6).trim(),
      data: JSON.parse(lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')),
    };
  });
}
const disposals: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

async function fixture(script: FakeScript, authorRole: 'viewer' | 'editor' = 'viewer') {
  const fake = await startFakeOpenAI(script);
  disposals.push(() => fake.close());
  const directory = await mkdtemp(join(tmpdir(), 'conversation-http-'));
  disposals.push(() => rm(directory, { recursive: true, force: true }));
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: directory, OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: fake.url });
  const log = pino({ level: 'silent' });
  const repo = await KnowledgeRepo.open(config, log);
  const wt = await repo.createWorktree('conversation-fixture');
  try {
    await wt.write('wiki/facts.md', '# Facts\nCitrine is a yellow quartz.');
    await wt.commit('Seed conversation source', { name: 'Fixture', email: 'fixture@example.test' });
    await wt.fastForwardMain();
  } finally { await wt.dispose(); }
  const db = openDb(join(directory, 'chat.db'));
  disposals.push(async () => db.close());
  runMigrations(db);
  const acl = new AclService(db, new UsersService(new UsersRepository(db)), new AuditService(db));
  const agent = new AgentService(config, log, repo, { search: async () => [] } as unknown as SearchService, acl);
  const users = new Map<number, User>([1, 2, 3, 4].map(id => [id, {
    id, email: `user${id}@example.test`, name: `User ${id}`, role: id === 4 ? 'admin' : id === 1 ? authorRole : 'viewer',
    createdAt: '2026-10-07T00:00:00.000Z', lastLoginAt: null,
  }]));
  for (const user of users.values()) db.prepare('INSERT INTO users(id,email,name,role,created_at) VALUES(?,?,?,?,?)').run(user.id, user.email, user.name, user.role, user.createdAt);
  const published: Array<{ event: WikiEvent; audience: EventAudience }> = [];
  const events = new EventsService();
  events.subscribe((event, audience) => published.push({ event, audience }));
  let origin = '';
  const module = await Test.createTestingModule({
    controllers: [ConversationsController, GenerationsController],
    providers: [ConversationsRepository, ConversationsService, GenerationsService, SessionGuard, RolesGuard,
      { provide: DB, useValue: db }, { provide: LOGGER, useValue: log },
      { provide: AclService, useValue: acl },
      { provide: AgentService, useValue: agent }, { provide: EventsService, useValue: events },
      { provide: UploadsService, useValue: { parts: async () => [], get: async () => { throw new Error('No upload in this fixture'); } } },
      { provide: ApiTokensService, useValue: { authenticate: () => null } },
      { provide: SessionsService, useValue: {
        sessionUser: (req: Request) => users.get(Number(req.get('x-user-id'))) ?? null,
        assertSameOrigin: (req: Request) => assertSameOrigin(req, origin),
      } },
    ],
  }).compile();
  const app: INestApplication = module.createNestApplication({ logger: false });
  configureApp(app);
  app.useGlobalFilters(new HttpExceptionFilter(log));
  await app.listen(0, '127.0.0.1');
  const server = app.getHttpServer() as Server;
  disposals.push(async () => { server.closeAllConnections(); await app.close(); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected ephemeral TCP listener');
  origin = `http://127.0.0.1:${address.port}`;
  async function request(path: string, method = 'GET', body?: unknown, userId = 1) {
    return fetch(`${origin}/api${path}`, { method, headers: {
      'x-user-id': String(userId), origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function create(title = 'Discussion') {
    const response = await request('/conversations', 'POST', { title });
    expect(response.status).toBe(201);
    return (await response.json() as { conversation: Conversation }).conversation;
  }
  async function detail(id: string, userId = 1) {
    const response = await request(`/conversations/${id}`, 'GET', undefined, userId);
    expect(response.status).toBe(200);
    return await response.json() as { conversation: Conversation; messages: Message[] };
  }
  async function stream(path: string, method = 'POST', body?: unknown, userId = 1) {
    const response = await request(path, method, body, userId);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const result = frames(await response.text());
    return result;
  }
  async function send(id: string, input: SubmitMessage) { return stream(`/conversations/${id}/messages`, 'POST', input); }
  return { request, create, detail, stream, send, agent, fake, repo, published };
}
async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
}
function done(result: Frame[]): Message {
  expect(result.at(-1)?.event).toBe('done');
  return result.at(-1)!.data.message as Message;
}

describe('conversation consumer contract', () => {
  it('replays an idempotent clientId without another turn and persists grounded citation and usage frames', async () => {
    const f = await fixture([{ name: 'read_note', arguments: { path: 'wiki/facts.md' } }, {
      text: '[Citrine](wiki/facts.md#facts) is yellow.', usage: { inputTokens: 12, outputTokens: 8, reasoningTokens: 3 },
    }]);
    const conversation = await f.create();
    const input = { content: 'What is citrine?', clientId: 'client-turn-1', effort: 'low' as const };
    const first = await f.send(conversation.id, input);
    const duplicate = await f.send(conversation.id, input);
    expect(duplicate).toEqual(first);
    expect(first[0]).toMatchObject({ event: 'generation', data: { generationId: expect.any(String), userMessageId: expect.any(String) } });
    expect(first.filter(frame => frame.event === 'tool').map(frame => frame.data)).toEqual([
      { name: 'read_note', state: 'start', summary: 'wiki/facts.md', path: 'wiki/facts.md' },
      { name: 'read_note', state: 'end', summary: 'wiki/facts.md', path: 'wiki/facts.md' },
    ]);
    const citation = { path: 'wiki/facts.md', heading: 'Facts', anchor: 'facts', sha: await f.repo.headSha() };
    expect(first.find(frame => frame.event === 'citation')?.data).toEqual(citation);
    expect(first.find(frame => frame.event === 'usage')?.data).toEqual({ inputTokens: 12, outputTokens: 8, reasoningTokens: 3 });
    expect(done(first)).toMatchObject({ status: 'completed', citations: [citation], usage: { inputTokens: 12, outputTokens: 8, reasoningTokens: 3 }, effort: 'low' });
    expect((await f.detail(conversation.id)).messages.map(message => [message.role, message.content])).toEqual([
      ['user', 'What is citrine?'], ['assistant', '[Citrine](wiki/facts.md#facts) is yellow.'],
    ]);
    expect(f.fake.requests).toHaveLength(2);
  });

  it('joins concurrent sends with the same clientId while rejecting a different turn during generation', async () => {
    const f = await fixture([]);
    const completion = Promise.withResolvers<void>();
    vi.spyOn(f.agent, 'answer').mockImplementationOnce(async (_messages, delta) => {
      delta('Partial');
      await completion.promise;
      return { text: 'Completed once', citations: [] };
    });
    const conversation = await f.create();
    const path = `/conversations/${conversation.id}/messages`;
    const input = { content: 'One question', clientId: 'concurrent-turn' };
    const [first, second] = await Promise.all([
      f.request(path, 'POST', input), f.request(path, 'POST', input),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expectError(await f.request(path, 'POST', { content: 'Another question', clientId: 'different-turn' }), 409, 'generation_active');
    expect((await f.detail(conversation.id)).messages.map(message => [message.role, message.content, message.status])).toEqual([
      ['user', 'One question', 'completed'], ['assistant', 'Partial', 'running'],
    ]);
    completion.resolve();
    const [firstFrames, secondFrames] = await Promise.all([first.text().then(frames), second.text().then(frames)]);
    expect(secondFrames).toEqual(firstFrames);
    expect(done(firstFrames).content).toBe('Completed once');
    expect((await f.detail(conversation.id)).messages.map(message => [message.role, message.content])).toEqual([
      ['user', 'One question'], ['assistant', 'Completed once'],
    ]);
  });

  it('completes and replays an editor-started answer to the owner after the editor loses membership', async () => {
    const f = await fixture([]);
    const started = Promise.withResolvers<void>();
    const completion = Promise.withResolvers<void>();
    vi.spyOn(f.agent, 'answer').mockImplementationOnce(async (_messages, delta) => {
      delta('Partial');
      started.resolve();
      await completion.promise;
      return { text: 'Finished for remaining members', citations: [] };
    });
    const conversation = await f.create();
    await f.request(`/conversations/${conversation.id}/members`, 'POST', { email: 'user2@example.test', role: 'editor' });
    const response = await f.request(`/conversations/${conversation.id}/messages`, 'POST', { content: 'Editor question' }, 2);
    expect(response.status).toBe(200);
    await started.promise;
    expect((await f.request(`/conversations/${conversation.id}/members/2`, 'DELETE')).status).toBe(204);
    completion.resolve();
    const result = frames(await response.text());
    const generationId = result.find(frame => frame.event === 'generation')!.data.generationId;
    const replay = await f.stream(`/generations/${generationId}/events`, 'GET');
    expect(done(replay)).toMatchObject({ role: 'assistant', status: 'completed', content: 'Finished for remaining members' });
    expect((await f.detail(conversation.id)).messages.map(message => [message.role, message.content, message.status])).toEqual([
      ['user', 'Editor question', 'completed'], ['assistant', 'Finished for remaining members', 'completed'],
    ]);
    await expectError(await f.request(`/generations/${generationId}/events`, 'GET', undefined, 2), 404, 'not_found');
    await expectError(await f.request(`/conversations/${conversation.id}`, 'GET', undefined, 2), 404, 'not_found');
  });

  it('keeps a failed partial answer and retries its user turn without duplication or leaking provider errors', async () => {
    const f = await fixture(['Recovered answer']);
    vi.spyOn(f.agent, 'answer').mockImplementationOnce(async (_messages, delta) => {
      delta('Partial fact');
      throw new Error('private provider credential');
    });
    const conversation = await f.create();
    const failed = await f.send(conversation.id, { content: 'Original question' });
    expect(failed.at(-1)).toMatchObject({ event: 'error', data: { code: 'generation_failed', message: expect.any(String) } });
    expect(JSON.stringify(failed)).not.toContain('private provider credential');
    const before = await f.detail(conversation.id);
    expect(before.messages.map(message => [message.role, message.content, message.status])).toEqual([
      ['user', 'Original question', 'completed'], ['assistant', 'Partial fact', 'failed'],
    ]);
    const retry = await f.stream(`/conversations/${conversation.id}/messages/${before.messages[1].id}/retry`);
    expect(done(retry).content).toBe('Recovered answer');
    const after = await f.detail(conversation.id);
    expect(after.messages.map(message => [message.role, message.content])).toEqual([
      ['user', 'Original question'], ['assistant', 'Recovered answer'],
    ]);
    expect(after.messages[0].id).toBe(before.messages[0].id);
    expect(after.messages[1].id).not.toBe(before.messages[1].id);
    expect(JSON.stringify(f.fake.requests[0].body.input)).not.toContain('Partial fact');
  });

  it.each(['retry', 'regenerate'] as const)('%s in the middle drops later turns and preserves the preceding user', async operation => {
    const f = await fixture(['First answer', 'Later answer', 'Replacement answer']);
    const conversation = await f.create();
    await f.send(conversation.id, { content: 'First question' });
    await f.send(conversation.id, { content: 'Later question' });
    const before = await f.detail(conversation.id);
    const target = before.messages[operation === 'retry' ? 0 : 1];
    const replacement = await f.stream(`/conversations/${conversation.id}/messages/${target.id}/${operation}`);
    expect(done(replacement).content).toBe('Replacement answer');
    expect((await f.detail(conversation.id)).messages.map(message => [message.role, message.content])).toEqual([
      ['user', 'First question'], ['assistant', 'Replacement answer'],
    ]);
    expect(f.fake.requests[2].body.input).toEqual([{ role: 'user', content: 'First question' }]);
  });

  it('edits an earlier user turn in place and regenerates without retaining stale later messages', async () => {
    const f = await fixture(['Old answer', 'Later answer', 'Corrected answer']);
    const conversation = await f.create();
    await f.send(conversation.id, { content: 'Wrong premise' });
    await f.send(conversation.id, { content: 'Later question' });
    const before = await f.detail(conversation.id);
    const result = await f.stream(`/conversations/${conversation.id}/messages/${before.messages[0].id}`, 'PATCH', { content: 'Correct premise' });
    expect(done(result).content).toBe('Corrected answer');
    const after = await f.detail(conversation.id);
    expect(after.messages.map(message => [message.role, message.content])).toEqual([
      ['user', 'Correct premise'], ['assistant', 'Corrected answer'],
    ]);
    expect(after.messages[0].id).toBe(before.messages[0].id);
    expect(f.fake.requests[2].body.input).toEqual([{ role: 'user', content: 'Correct premise' }]);
  });

  it('retains a discarded turn clientId so retrying its send cannot resurrect an edited-away conversation branch', async () => {
    const f = await fixture(['First answer', 'Discarded answer', 'Corrected answer']);
    const conversation = await f.create();
    await f.send(conversation.id, { content: 'First question' });
    const discardedInput = { content: 'Discarded question', clientId: 'discarded-turn' };
    const discarded = await f.send(conversation.id, discardedInput);
    const before = await f.detail(conversation.id);
    await f.stream(`/conversations/${conversation.id}/messages/${before.messages[0].id}`, 'PATCH', { content: 'Corrected question' });
    const replay = await f.send(conversation.id, discardedInput);
    expect(replay).toEqual(discarded);
    expect((await f.detail(conversation.id)).messages.map(message => [message.role, message.content])).toEqual([
      ['user', 'Corrected question'], ['assistant', 'Corrected answer'],
    ]);
    expect(f.fake.requests).toHaveLength(3);
  });

  it('hides nonmembers, enforces member roles, and allows a global viewer who owns the conversation to write', async () => {
    const f = await fixture(['Owner answer', 'Editor answer']);
    const conversation = await f.create();
    const ownerAnswer = done(await f.send(conversation.id, { content: 'Owner question' }));
    const original = await f.detail(conversation.id);
    await expectError(await f.request(`/conversations/${conversation.id}/messages/${ownerAnswer.id}/retry`, 'POST'), 409, 'not_retryable');
    expect((await f.detail(conversation.id)).messages).toEqual(original.messages);
    await expectError(await f.request(`/conversations/${conversation.id}/members/1`, 'DELETE'), 409, 'owner_required');
    for (const userId of [2, 4]) {
      await expectError(await f.request(`/conversations/${conversation.id}`, 'GET', undefined, userId), 404, 'not_found');
      await expectError(await f.request(`/conversations/${conversation.id}/messages`, 'POST', { content: 'Intrusion' }, userId), 404, 'not_found');
    }
    expect((await f.request(`/conversations/${conversation.id}/members`, 'POST', { email: 'user2@example.test', role: 'viewer' })).status).toBe(201);
    expect((await f.detail(conversation.id, 2)).conversation.role).toBe('viewer');
    for (const [path, method, body] of [
      [`/conversations/${conversation.id}/messages`, 'POST', { content: 'Viewer write' }],
      [`/conversations/${conversation.id}`, 'PATCH', { title: 'Viewer rename' }],
      [`/conversations/${conversation.id}`, 'DELETE', undefined],
      [`/conversations/${conversation.id}/members`, 'POST', { email: 'user3@example.test', role: 'editor' }],
      [`/conversations/${conversation.id}/messages/${original.messages[0].id}`, 'PATCH', { content: 'Viewer edit' }],
      [`/conversations/${conversation.id}/messages/${ownerAnswer.id}/retry`, 'POST', undefined],
      [`/conversations/${conversation.id}/messages/${ownerAnswer.id}/regenerate`, 'POST', undefined],
    ] as const) await expectError(await f.request(path, method, body, 2), 403, 'forbidden');
    await f.request(`/conversations/${conversation.id}/members`, 'POST', { email: 'user3@example.test', role: 'editor' });
    expect((await f.detail(conversation.id, 3)).conversation.role).toBe('editor');
    const editor = await f.stream(`/conversations/${conversation.id}/messages`, 'POST', { content: 'Editor question' }, 3);
    expect(done(editor).content).toBe('Editor answer');
    expect((await f.request(`/conversations/${conversation.id}`, 'PATCH', { title: 'Shared title' }, 3)).status).toBe(200);
    await expectError(await f.request(`/conversations/${conversation.id}`, 'DELETE', undefined, 3), 403, 'forbidden');
    await expectError(await f.request(`/conversations/${conversation.id}/members/2`, 'DELETE', undefined, 3), 403, 'forbidden');
    expect((await f.request(`/conversations/${conversation.id}/members/2`, 'DELETE')).status).toBe(204);
    await expectError(await f.request(`/conversations/${conversation.id}`, 'GET', undefined, 2), 404, 'not_found');
  });

  it('searches titles and message snippets only among memberships and publishes presence to members until expiry', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const f = await fixture(['The citrine answer']);
    const conversation = await f.create('Mineral discussion');
    await f.send(conversation.id, { content: 'Tell me about citrine' });
    await f.request(`/conversations/${conversation.id}/members`, 'POST', { email: 'user2@example.test', role: 'viewer' });
    const found = await f.request('/conversations?q=CITRINE', 'GET', undefined, 2);
    expect(await found.json()).toMatchObject({ conversations: [{ id: conversation.id, role: 'viewer', snippet: expect.stringMatching(/citrine/i) }] });
    expect(await (await f.request('/conversations?q=citrine', 'GET', undefined, 4)).json()).toEqual({ conversations: [] });
    await f.request(`/conversations/${conversation.id}`, 'PATCH', { title: 'Quartz library' });
    expect(await (await f.request('/conversations?q=Quartz')).json()).toMatchObject({ conversations: [{ id: conversation.id, title: 'Quartz library', snippet: 'Quartz library' }] });
    const update = f.published.filter(item => item.event.type === 'conversation.updated').at(-1)!;
    expect(update.audience).toEqual({ userIds: [1, 2] });
    const presence = await f.request(`/conversations/${conversation.id}/presence`, 'POST', { typing: true }, 2);
    expect(presence.status).toBe(201);
    const active = f.published.filter(item => item.event.type === 'conversation.presence').at(-1)!;
    expect(active).toEqual({ event: { type: 'conversation.presence', conversationId: conversation.id, users: [{ id: 2, name: 'User 2', typing: true }] }, audience: { userIds: [1, 2] } });
    await vi.advanceTimersByTimeAsync(31_000);
    const expired = f.published.filter(item => item.event.type === 'conversation.presence').at(-1)!;
    expect(expired).toEqual({ event: { type: 'conversation.presence', conversationId: conversation.id, users: [] }, audience: { userIds: [1, 2] } });
  });

  it('returns a note proposal from a completed answer without writing knowledge or changing the conversation', async () => {
    const proposed = '# Facts\nCitrine is yellow quartz with an updated explanation.';
    const f = await fixture(['Citrine is yellow quartz.', proposed], 'editor');
    const conversation = await f.create();
    const assistant = done(await f.send(conversation.id, { content: 'Explain citrine' }));
    const before = await f.detail(conversation.id);
    const sha = await f.repo.headSha();
    const original = await f.repo.readFile('wiki/facts.md');
    await f.request(`/conversations/${conversation.id}/members`, 'POST', { email: 'user2@example.test', role: 'editor' });
    const path = `/conversations/${conversation.id}/messages/${assistant.id}/proposal`;
    await expectError(await f.request(path, 'POST', { mode: 'edit', path: 'wiki/facts.md' }, 2), 403, 'forbidden');
    await expectError(await f.request(`/conversations/${conversation.id}/messages/${before.messages[0].id}/proposal`, 'POST', { mode: 'edit', path: 'wiki/facts.md' }), 404, 'not_found');
    const response = await f.request(path, 'POST', { mode: 'edit', path: 'wiki/facts.md' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: 'wiki/facts.md', baseSha: sha, original, proposed });
    expect(await f.repo.headSha()).toBe(sha);
    expect(await f.repo.readFile('wiki/facts.md')).toBe(original);
    expect((await f.detail(conversation.id)).messages).toEqual(before.messages);
  });

  it('compacts long history but invalidates the old summary when an earlier user message is edited', async () => {
    const f = await fixture([
      ...Array.from({ length: 8 }, (_, index) => `Answer ${index}`),
      'STALE SUMMARY: original mineral question', 'Ninth answer', 'Corrected first answer',
    ]);
    const conversation = await f.create();
    for (let index = 0; index < 9; index++) await f.send(conversation.id, { content: `Question ${index}` });
    const summaryRequest = f.fake.requests.find(request => request.body.stream === false);
    expect(JSON.stringify(summaryRequest?.body.input)).toContain('Question 0');
    expect(JSON.stringify(f.fake.requests.at(-1)!.body.input)).toContain('STALE SUMMARY');
    const before = await f.detail(conversation.id);
    const edited = await f.stream(`/conversations/${conversation.id}/messages/${before.messages[0].id}`, 'PATCH', { content: 'Corrected first question' });
    expect(done(edited).content).toBe('Corrected first answer');
    expect(f.fake.requests.at(-1)!.body.input).toEqual([{ role: 'user', content: 'Corrected first question' }]);
    expect((await f.detail(conversation.id)).messages.map(message => [message.role, message.content])).toEqual([
      ['user', 'Corrected first question'], ['assistant', 'Corrected first answer'],
    ]);
  });
});
