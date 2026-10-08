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
import { ApiTokensRepository } from '../src/auth/api-tokens.repository.js';
import { WriteJobsRepository } from '../src/jobs/write-jobs.repository.js';
import { WriteJobsService } from '../src/jobs/write-jobs.service.js';
import { IndexerService } from '../src/rag/indexer.service.js';

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
    await wt.write('wiki/updates.md', '# Updates\nCitrine should be stored away from heat.');
    await wt.commit('Seed conversation source', { name: 'Fixture', email: 'fixture@example.test' });
    await wt.fastForwardMain();
  } finally { await wt.dispose(); }
  const db = openDb(join(directory, 'chat.db'));
  disposals.push(async () => db.close());
  runMigrations(db);
  const userService = new UsersService(new UsersRepository(db));
  const audit = new AuditService(db);
  const acl = new AclService(db, userService, audit);
  const agent = new AgentService(config, log, repo, { search: async () => [] } as unknown as SearchService, acl);
  const users = new Map<number, User>([1, 2, 3, 4].map(id => [id, {
    id, email: `user${id}@example.test`, name: `User ${id}`, role: id === 4 ? 'admin' : id === 1 ? authorRole : 'viewer',
    createdAt: '2026-10-07T00:00:00.000Z', lastLoginAt: null,
  }]));
  for (const user of users.values()) db.prepare('INSERT INTO users(id,email,name,role,created_at) VALUES(?,?,?,?,?)').run(user.id, user.email, user.name, user.role, user.createdAt);
  const published: Array<{ event: WikiEvent; audience: EventAudience }> = [];
  const events = new EventsService();
  events.subscribe((event, audience) => published.push({ event, audience }));
  const jobRepository = new WriteJobsRepository(db);
  const jobs = new WriteJobsService(jobRepository, agent, new IndexerService(config, db, log, repo, events), repo, userService, log, events, acl);
  const tokens = new ApiTokensService(new ApiTokensRepository(db), userService, audit);
  let origin = '';
  const module = await Test.createTestingModule({
    controllers: [ConversationsController, GenerationsController],
    providers: [ConversationsRepository, ConversationsService, GenerationsService, SessionGuard, RolesGuard,
      { provide: DB, useValue: db }, { provide: LOGGER, useValue: log },
      { provide: AclService, useValue: acl },
      { provide: AgentService, useValue: agent }, { provide: EventsService, useValue: events },
      { provide: KnowledgeRepo, useValue: repo },
      { provide: WriteJobsService, useValue: jobs },
      { provide: UploadsService, useValue: { parts: async () => [], get: async () => { throw new Error('No upload in this fixture'); } } },
      { provide: ApiTokensService, useValue: tokens },
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
  async function request(path: string, method = 'GET', body?: unknown, userId = 1, token?: string) {
    return fetch(`${origin}/api${path}`, { method, headers: {
      'x-user-id': String(userId), origin, ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
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
  async function stream(path: string, method = 'POST', body?: unknown, userId = 1, token?: string) {
    const response = await request(path, method, body, userId, token);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const result = frames(await response.text());
    return result;
  }
  async function send(id: string, input: SubmitMessage) { return stream(`/conversations/${id}/messages`, 'POST', input); }
  return { request, create, detail, stream, send, agent, fake, repo, published, db, acl, users, jobs, jobRepository, tokens };
}
async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error: { code } });
}
function done(result: Frame[]): Message {
  expect(result.at(-1)?.event).toBe('done');
  return result.at(-1)!.data.message as Message;
}

describe('chat write job monitoring', () => {
  it('returns own job status and the latest subagent snapshot with job links in both tool events', async () => {
    const args = { jobId: '' };
    const f = await fixture([{ name: 'get_write_status', arguments: args }, 'The write is in progress.'], 'editor');
    const conversation = await f.create();
    const job = f.jobs.submit({ userId: 1, input: 'Record a fact.', source: 'chat', client: conversation.id });
    args.jobId = job.id;
    f.jobRepository.markRunning(job.id, new Date().toISOString());
    const subagent = { id: 'sub-1', name: '정리', status: 'running', files: ['wiki/facts.md'], toolCalls: 1 };
    f.jobs.phase(job.id, 'editing', { subagent });
    f.jobs.phase(job.id, 'editing', { subagent: { ...subagent, status: 'completed', toolCalls: 3, result: '사실을 정리했다.', task: 'Private task text' } });
    const result = await f.send(conversation.id, { content: 'Check my write.' });
    const output = (f.fake.requests[1].body.input as Array<{ type: string; output?: string }>).find(item => item.type === 'function_call_output')!;
    expect(JSON.parse(output.output!)).toEqual({
      jobId: job.id, status: 'running', phase: 'editing', summary: null, error: null, mergeSha: null, commits: [],
      subagents: [{ ...subagent, status: 'completed', toolCalls: 3, result: '사실을 정리했다.' }],
    });
    expect(result.filter(frame => frame.event === 'tool').map(frame => frame.data)).toEqual([
      { name: 'get_write_status', state: 'start', summary: job.id, jobId: job.id },
      { name: 'get_write_status', state: 'end', summary: job.id, jobId: job.id },
    ]);
    expect(JSON.stringify(f.fake.requests[1].body.input)).not.toContain('Private task text');
  });

  it('tracks commit paths so job-derived answers remain private to authorized conversation members', async () => {
    const args = { jobId: '' };
    const f = await fixture([{ name: 'get_write_status', arguments: args }, 'PRIVATE_JOB_RESULT'], 'editor');
    const conversation = await f.create();
    await f.request(`/conversations/${conversation.id}/members`, 'POST', { email: 'user2@example.test', role: 'viewer' });
    const wt = await f.repo.createWorktree('job-status-private-result');
    let sha: string;
    try {
      await wt.write('wiki/job-result.md', '# Job result\nPRIVATE_JOB_RESULT');
      await wt.commit('Add private job result', { name: 'Fixture', email: 'fixture@example.test' });
      await wt.fastForwardMain();
      sha = await f.repo.headSha();
    } finally { await wt.dispose(); }
    f.acl.create({ prefix: 'wiki/job-result.md', subjectType: 'user', subject: '2', access: 'none' }, f.users.get(4)!);
    const job = f.jobs.submit({ userId: 1, input: 'Record a fact.', source: 'chat', client: conversation.id });
    args.jobId = job.id;
    f.jobRepository.markMerging(job.id, 'PRIVATE_JOB_RESULT', [sha]);
    f.jobRepository.markSucceeded(job.id, new Date().toISOString());
    f.jobs.phase(job.id, 'done');
    await f.send(conversation.id, { content: 'Check my write.' });
    expect(JSON.stringify((await f.detail(conversation.id)).messages)).toContain('PRIVATE_JOB_RESULT');
    expect(JSON.stringify((await f.detail(conversation.id, 2)).messages)).not.toContain('PRIVATE_JOB_RESULT');
  });

  it('omits summaries and subagent result text when current folder permissions hide the job input', async () => {
    const args = { jobId: '' };
    const f = await fixture([{ name: 'get_write_status', arguments: args }, 'Details are restricted.'], 'editor');
    const conversation = await f.create();
    f.acl.create({ prefix: 'wiki/updates.md', subjectType: 'user', subject: '1', access: 'none' }, f.users.get(4)!);
    const job = f.jobs.submit({ userId: 1, input: 'PRIVATE_INPUT', source: 'chat', client: conversation.id, sourcePaths: ['wiki/updates.md'] });
    args.jobId = job.id;
    f.jobRepository.markMerging(job.id, 'PRIVATE_SUMMARY', []);
    f.jobs.phase(job.id, 'editing', { subagent: {
      id: 'sub-1', name: '정리', status: 'completed', files: ['wiki/updates.md'], toolCalls: 2, result: 'PRIVATE_RESULT', error: 'PRIVATE_ERROR',
    } });
    await f.send(conversation.id, { content: 'Check my write.' });
    const output = (f.fake.requests[1].body.input as Array<{ type: string; output?: string }>).find(item => item.type === 'function_call_output')!;
    expect(JSON.parse(output.output!)).toMatchObject({
      jobId: job.id, status: 'merging', summary: null, subagents: [{ id: 'sub-1', name: '정리', status: 'completed', files: [], toolCalls: 2 }],
    });
    expect(output.output).not.toContain('PRIVATE_');
  });

  it.each(['get_write_status', 'wait_write'])('hides another requester job from %s', async name => {
    const args = { jobId: '' };
    const f = await fixture([{ name, arguments: args }, 'The job was not found.'], 'editor');
    const conversation = await f.create();
    const job = f.jobs.submit({ userId: 4, input: 'Other user private request.', source: 'chat' });
    args.jobId = job.id;
    await f.send(conversation.id, { content: 'Check a job.' });
    const output = (f.fake.requests[1].body.input as Array<{ type: string; output?: string }>).find(item => item.type === 'function_call_output')!;
    expect(JSON.parse(output.output!)).toEqual({ error: 'not found' });
    expect(JSON.stringify(f.fake.requests[1].body.input)).not.toContain('Other user private request.');
  });

  it('waits for persisted success and reports the final outcome without timing out', async () => {
    const args = { jobId: '', timeoutSeconds: 2 };
    const f = await fixture([{ name: 'wait_write', arguments: args }, 'The write succeeded.'], 'editor');
    const conversation = await f.create();
    const job = f.jobs.submit({ userId: 1, input: 'Record a fact.', source: 'chat', client: conversation.id });
    args.jobId = job.id;
    f.jobRepository.markMerging(job.id, '사실을 기록했다.', []);
    f.jobRepository.markSucceeded(job.id, new Date().toISOString());
    f.jobs.phase(job.id, 'done');
    const result = await f.send(conversation.id, { content: 'Wait for my write.' });
    const output = (f.fake.requests[1].body.input as Array<{ type: string; output?: string }>).find(item => item.type === 'function_call_output')!;
    expect(JSON.parse(output.output!)).toEqual({
      jobId: job.id, status: 'succeeded', phase: 'done', summary: '사실을 기록했다.', error: null, mergeSha: null, commits: [], timedOut: false,
    });
    expect(result.filter(frame => frame.event === 'tool').map(frame => frame.data)).toEqual([
      { name: 'wait_write', state: 'start', summary: job.id, jobId: job.id },
      { name: 'wait_write', state: 'end', summary: job.id, jobId: job.id },
    ]);
  });

  it('reports a timeout without settling or cancelling the write job', async () => {
    const args = { jobId: '', timeoutSeconds: 0 };
    const f = await fixture([{ name: 'wait_write', arguments: args }, 'The write is still running.'], 'editor');
    const conversation = await f.create();
    const job = f.jobs.submit({ userId: 1, input: 'Record a fact.', source: 'chat', client: conversation.id });
    args.jobId = job.id;
    await f.send(conversation.id, { content: 'Wait briefly.' });
    const output = (f.fake.requests[1].body.input as Array<{ type: string; output?: string }>).find(item => item.type === 'function_call_output')!;
    expect(JSON.parse(output.output!)).toMatchObject({ jobId: job.id, status: 'queued', phase: 'queued', timedOut: true });
    expect(f.jobs.get(job.id)?.status).toBe('queued');
  });

  it('observes queued-to-success transitions and a bounded deadline while polling', async () => {
    const f = await fixture([]);
    const job = f.jobs.submit({ userId: 1, input: 'Record a fact.', source: 'chat' });
    vi.useFakeTimers();
    const waiting = f.jobs.waitForSettled(job.id, 2_000);
    await vi.advanceTimersByTimeAsync(999);
    f.jobRepository.markSucceeded(job.id, new Date().toISOString());
    await vi.advanceTimersByTimeAsync(1);
    await expect(waiting).resolves.toMatchObject({ job: { id: job.id, status: 'succeeded' }, timedOut: false });
    const pending = f.jobs.submit({ userId: 1, input: 'Pending fact.', source: 'chat' });
    const deadline = f.jobs.waitForSettled(pending.id, 1_500);
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(deadline).resolves.toMatchObject({ job: { id: pending.id, status: 'queued' }, timedOut: true });
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('cancels a pending wait promptly without cancelling the write job', async () => {
    const f = await fixture([]);
    const job = f.jobs.submit({ userId: 1, input: 'Record a fact.', source: 'chat' });
    const controller = new AbortController();
    const waiting = f.jobs.waitForSettled(job.id, 60_000, controller.signal);
    controller.abort(new Error('Answer cancelled'));
    await expect(waiting).rejects.toThrow('Answer cancelled');
    expect(f.jobs.get(job.id)?.status).toBe('queued');
    await expect(f.jobs.waitForSettled(job.id, 60_000, controller.signal)).rejects.toThrow('Answer cancelled');
  });
});

describe('conversation consumer contract', () => {
  it('queues an explicit editor write with complete chat provenance and persists its job ID for replay', async () => {
    const content = 'Citrine is yellow quartz. Store it away from heat.';
    const f = await fixture([
      { name: 'read_note', arguments: { path: 'wiki/facts.md' } }, '[Citrine](wiki/facts.md#facts) is yellow quartz.',
      { name: 'write_knowledge', arguments: { content } }, 'The knowledge update is queued.',
    ], 'editor');
    // Source membership must survive either completion order of parallel context reads.
    const readFile = f.repo.readFile.bind(f.repo);
    let releaseRules!: () => void;
    const memoryLoaded = new Promise<void>(resolve => { releaseRules = resolve; });
    const contextRead = vi.spyOn(f.repo, 'readFile').mockImplementation(async (path, ref) => {
      if (path === 'AGENTS.md') await memoryLoaded;
      try { return await readFile(path, ref); }
      finally { if (path === 'MEMORY.md') releaseRules(); }
    });
    const conversation = await f.create();
    await f.send(conversation.id, { content: 'What is citrine?' });
    contextRead.mockRestore();
    const result = await f.send(conversation.id, {
      content: 'Save this fact and its storage advice in the wiki.', clientId: 'save-citrine',
      context: { notePath: 'wiki/updates.md' },
    });
    const generationId = result[0].data.generationId as string;
    const toolEnd = result.find(frame => frame.event === 'tool' && frame.data.name === 'write_knowledge' && frame.data.state === 'end')!;
    expect(toolEnd.data).toMatchObject({ name: 'write_knowledge', state: 'end', summary: content, jobId: expect.any(String) });
    const jobId = toolEnd.data.jobId as string;
    expect(f.jobs.get(jobId)).toMatchObject({ userId: 1, kind: 'agent', status: 'queued', input: content, source: 'chat', client: conversation.id });
    const jobEvents = f.jobs.events(jobId);
    expect(jobEvents).toMatchObject([{ phase: 'queued', detail: { sourceProvenanceComplete: true } }]);
    expect(new Set(jobEvents[0]!.detail!.sourcePaths as string[])).toEqual(new Set([
      'wiki/facts.md', 'AGENTS.md', 'MEMORY.md', 'wiki/updates.md',
    ]));
    const persisted = f.db.prepare("SELECT data FROM generation_frames WHERE generation_id = ? AND event = 'tool' ORDER BY seq")
      .all(generationId) as Array<{ data: string }>;
    expect(persisted.map(frame => JSON.parse(frame.data))).toContainEqual(toolEnd.data);
    expect(await f.stream(`/generations/${generationId}/events`, 'GET')).toEqual(result);
    expect(await f.send(conversation.id, { content: 'Save this fact and its storage advice in the wiki.', clientId: 'save-citrine' })).toEqual(result);
    expect(f.jobRepository.list()).toHaveLength(1);
    expect(done(result)).toMatchObject({ status: 'completed', content: 'The knowledge update is queued.' });
  });

  it('does not grant a global viewer knowledge writes even when they own the conversation', async () => {
    const f = await fixture([{ name: 'write_knowledge', arguments: { content: 'Save this in the wiki.' } }, 'I cannot save knowledge.']);
    const conversation = await f.create();
    const result = await f.send(conversation.id, { content: 'Save this in the wiki.' });
    const requestTools = f.fake.requests[0].body.tools as Array<{ name: string }>;
    expect(requestTools.map(tool => tool.name)).not.toContain('write_knowledge');
    expect(f.jobRepository.list()).toEqual([]);
    expect(result.filter(frame => frame.event === 'tool').every(frame => frame.data.jobId === undefined)).toBe(true);
    expect(done(result).content).toBe('I cannot save knowledge.');
  });

  it('rejects read-scope Bearer mutations before the model and permits a write-scope editor token', async () => {
    const f = await fixture([{ name: 'write_knowledge', arguments: { content: 'Save the approved fact.' } }, 'Queued.'], 'editor');
    const conversation = await f.create();
    const read = f.tokens.create(f.users.get(1)!, { name: 'Read only', scopes: ['read'] });
    const write = f.tokens.create(f.users.get(1)!, { name: 'Write', scopes: ['write'] });
    const path = `/conversations/${conversation.id}/messages`;
    await expectError(await f.request(path, 'POST', { content: 'Save the approved fact.' }, 1, read.token), 403, 'insufficient_scope');
    expect(f.fake.requests).toEqual([]);
    expect(f.jobRepository.list()).toEqual([]);
    expect((await f.detail(conversation.id)).messages).toEqual([]);
    const result = await f.stream(path, 'POST', { content: 'Save the approved fact.' }, 1, write.token);
    const toolEnd = result.find(frame => frame.event === 'tool' && frame.data.state === 'end')!;
    expect(f.jobs.get(toolEnd.data.jobId as string)).toMatchObject({ userId: 1, source: 'chat', client: conversation.id, status: 'queued' });
    expect(done(result).content).toBe('Queued.');
  });

  it.each(['edit', 'regenerate', 'retry'] as const)('binds knowledge submitted by %s to the current requester, not the original author', async action => {
    const f = await fixture(['Initial answer.', { name: 'write_knowledge', arguments: { content: 'A requested correction.' } }, 'Correction queued.']);
    const conversation = await f.create();
    await f.request(`/conversations/${conversation.id}/members`, 'POST', { email: 'user4@example.test', role: 'editor' });
    const first = await f.send(conversation.id, { content: 'Original question.' });
    const userMessageId = first[0].data.userMessageId as string;
    const assistantMessageId = done(first).id;
    const path = `/conversations/${conversation.id}/messages/${action === 'regenerate' ? assistantMessageId : userMessageId}`;
    const result = action === 'edit'
      ? await f.stream(path, 'PATCH', { content: 'Save a requested correction.' }, 4)
      : await f.stream(`${path}/${action}`, 'POST', undefined, 4);
    const toolEnd = result.find(frame => frame.event === 'tool' && frame.data.name === 'write_knowledge' && frame.data.state === 'end')!;
    expect(f.jobs.get(toolEnd.data.jobId as string)).toMatchObject({
      userId: 4, source: 'chat', client: conversation.id, input: 'A requested correction.', status: 'queued',
    });
    expect(done(result).content).toBe('Correction queued.');
  });

  it.each(['membership', 'role', 'policy'] as const)('rechecks current %s immediately before enqueueing a model-requested write', async revocation => {
    const f = await fixture([{ name: 'write_knowledge', arguments: { content: 'Do not queue after revocation.' } }, 'Finished.'], 'editor');
    const conversation = await f.create();
    const answer = f.agent.answer.bind(f.agent);
    vi.spyOn(f.agent, 'answer').mockImplementationOnce((messages, delta, signal, options) => answer(messages, delta, signal, {
      ...options, submitKnowledge: async content => {
        if (revocation === 'membership') f.db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = 1').run(conversation.id);
        if (revocation === 'role') f.db.prepare("UPDATE users SET role = 'viewer' WHERE id = 1").run();
        if (revocation === 'policy') f.acl.create({ prefix: 'wiki/', subjectType: 'everyone', subject: '', access: 'none' }, f.users.get(4)!);
        return options!.submitKnowledge!(content);
      },
    }));
    const result = await f.send(conversation.id, { content: 'Save a fact.' });
    expect(f.jobRepository.list()).toEqual([]);
    expect(result.filter(frame => frame.event === 'tool').every(frame => frame.data.jobId === undefined)).toBe(true);
  });

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
