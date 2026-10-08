import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request } from 'express';
import { createServer, type Server } from 'node:http';
import pino from 'pino';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { AclService } from '../src/acl/acl.service.js';
import { AuditService } from '../src/audit/audit.service.js';
import { ConversationsController } from '../src/api/conversations.controller.js';
import { ConversationsRepository } from '../src/api/conversations.repository.js';
import { ConversationsService } from '../src/api/conversations.service.js';
import type { Message } from '../src/api/conversations.types.js';
import { GenerationsController } from '../src/api/generations.controller.js';
import { GenerationsService } from '../src/api/generations.service.js';
import { UploadsController } from '../src/api/uploads.controller.js';
import { RolesGuard } from '../src/auth/guards/roles.guard.js';
import { SessionGuard } from '../src/auth/guards/session.guard.js';
import { UsersRepository } from '../src/auth/users.repository.js';
import { UsersService } from '../src/auth/users.service.js';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter.js';
import { CONFIG, DB, LOGGER } from '../src/common/tokens.js';
import { loadConfig } from '../src/config.js';
import { openDb, runMigrations } from '../src/db/index.js';
import { EventsService } from '../src/events/events.service.js';
import { NoteWriterService } from '../src/jobs/note-writer.service.js';
import { WriteJobsRepository } from '../src/jobs/write-jobs.repository.js';
import { WriteJobsService } from '../src/jobs/write-jobs.service.js';
import { KnowledgeRepo } from '../src/knowledge/repo.js';
import { AgentService } from '../src/agent/agent.service.js';
import { IndexerService } from '../src/rag/indexer.service.js';
import { SearchService } from '../src/rag/search.service.js';
import { UploadsService } from '../src/uploads/uploads.service.js';
import { startFakeOpenAI, type FakeScript } from './fake-openai.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function fixture(script: FakeScript = [], gate?: { received: () => void; release: Promise<void> }) {
  const fake = await startFakeOpenAI(script);
  cleanup.push(() => fake.close());
  let baseUrl = fake.url;
  if (gate) {
    const proxy = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        if (req.url === '/v1/responses') {
          gate.received();
          await gate.release;
        }
        const upstream = await fetch(`${fake.url.slice(0, -3)}${req.url}`, {
          method: req.method, headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks),
        });
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch (error) {
        res.statusCode = 500;
        res.end(String(error));
      }
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('Expected provider proxy TCP listener');
    baseUrl = `http://127.0.0.1:${address.port}/v1`;
    cleanup.push(async () => {
      proxy.closeAllConnections();
      await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
    });
  }
  const directory = await mkdtemp(join(tmpdir(), 'acl-chat-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: directory, OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: baseUrl, EMBEDDING_DIMENSIONS: '8' });
  const log = pino({ level: 'silent' });
  const db = openDb(':memory:');
  cleanup.push(async () => db.close());
  runMigrations(db);
  const users = new UsersService(new UsersRepository(db));
  for (const [id, role] of [[1, 'editor'], [2, 'editor'], [3, 'admin']] as const) {
    db.prepare('INSERT INTO users(id,email,role,created_at) VALUES(?,?,?,?)').run(id, `${id}@example.test`, role, '2026-10-07T00:00:00Z');
  }
  const audit = new AuditService(db);
  const acl = new AclService(db, users, audit);
  const admin = users.getById(3)!;
  acl.create({ prefix: 'wiki/private/', subjectType: 'everyone', subject: '', access: 'none' }, admin);
  acl.create({ prefix: 'wiki/private/', subjectType: 'user', subject: '1', access: 'write' }, admin);
  acl.create({ prefix: 'MEMORY.md', subjectType: 'user', subject: '2', access: 'none' }, admin);
  const repo = await KnowledgeRepo.open(config, log);
  const wt = await repo.createWorktree('seed-acl-chat');
  try {
    await wt.write('wiki/public.md', '# Public\nQuartz public fact.');
    await wt.write('wiki/private/secret.md', '# Secret\nQuartz secret treasure is SAPPHIRE.');
    await wt.write('MEMORY.md', 'MEMORY_PRIVATE_TOKEN');
    await wt.commit('Seed source permissions', { name: 'Fixture', email: 'fixture@example.test' });
    await wt.fastForwardMain();
  } finally { await wt.dispose(); }
  const events = new EventsService();
  const indexer = new IndexerService(config, db, log, repo, events);
  indexer.init();
  await indexer.syncToHead();
  const search = new SearchService(config, db, log, acl, repo);
  const agent = new AgentService(config, log, repo, search, acl);
  const jobs = new WriteJobsRepository(db);
  const writer = new NoteWriterService(jobs, repo, users, indexer, events, log, acl, audit);
  const writeJobs = new WriteJobsService(jobs, agent, indexer, repo, users, log, events, acl, writer);
  const repository = new ConversationsRepository(db);
  const module = await Test.createTestingModule({
    controllers: [ConversationsController, GenerationsController, UploadsController],
    providers: [ConversationsService, GenerationsService, UploadsService, RolesGuard,
      { provide: ConversationsRepository, useValue: repository }, { provide: CONFIG, useValue: config },
      { provide: DB, useValue: db }, { provide: LOGGER, useValue: log }, { provide: AclService, useValue: acl },
      { provide: AgentService, useValue: agent }, { provide: EventsService, useValue: events },
      { provide: KnowledgeRepo, useValue: repo },
      { provide: WriteJobsService, useValue: writeJobs },
      { provide: NoteWriterService, useValue: writer }, { provide: AuditService, useValue: audit }],
  }).overrideGuard(SessionGuard).useValue({ canActivate(context: { switchToHttp(): { getRequest(): Request } }) {
    const req = context.switchToHttp().getRequest();
    req.user = users.getById(Number(req.headers['x-user'])) ?? undefined;
    return !!req.user;
  } }).compile();
  const app = module.createNestApplication({ logger: false });
  app.useGlobalFilters(new HttpExceptionFilter(log));
  await app.listen(0, '127.0.0.1');
  const server = app.getHttpServer() as Server;
  cleanup.push(async () => { server.closeAllConnections(); await app.close(); });
  const origin = await app.getUrl();
  const conversation = repository.create(1, 'Shared discussion');
  repository.addMember(conversation.id, '2@example.test', 'editor');
  repository.addMember(conversation.id, '3@example.test', 'editor');
  const api = (path: string, user = 1) => request(server).get(`/api${path}`).set('x-user', String(user));
  const post = (path: string, body: unknown, user = 1) => request(server).post(`/api${path}`).set('x-user', String(user)).send(body);
  return { db, fake, repo, repository, conversation, acl, admin, api, post, server, origin, generations: app.get(GenerationsService) };
}

function frames(text: string) {
  return text.split('\n\n').filter(block => block.includes('event:')).map(block => {
    const rows = block.split('\n');
    return { id: Number(rows.find(row => row.startsWith('id:'))!.slice(3)),
      event: rows.find(row => row.startsWith('event:'))!.slice(6).trim(),
      data: JSON.parse(rows.find(row => row.startsWith('data:'))!.slice(5)) };
  });
}

describe('folder ACL at chat HTTP seams', () => {
  it('scopes real model search and reads, suppresses denied tool paths, and denies pinned context before generation', async () => {
    const f = await fixture([{ name: 'search', arguments: { query: 'Quartz', limit: 1 } },
      { name: 'read_note', arguments: { path: 'wiki/private/secret.md' } },
      { name: 'read_note', arguments: { path: 'wiki/public.md' } }, '[Public](wiki/public.md#public) Quartz public fact.']);
    const path = `/conversations/${f.conversation.id}/messages`;
    const denied = await f.post(path, { content: 'Explain', context: { notePath: 'wiki/private/secret.md', selection: 'SAPPHIRE' } }, 2).expect(404);
    expect(denied.body).toMatchObject({ error: { code: 'not_found' } });
    const output = await f.post(path, { content: 'Quartz?' }, 2).expect(200);
    expect(output.text).not.toContain('wiki/private/secret.md');
    expect(output.text).not.toContain('SAPPHIRE');
    const requests = f.fake.requests.filter(req => req.path.endsWith('/responses'));
    expect(JSON.stringify(requests)).not.toContain('MEMORY_PRIVATE_TOKEN');
    const tools = requests.flatMap(req => req.body.input as Array<{type?:string;output?:string}>).filter(input => input.type === 'function_call_output');
    const search = tools.find(input => input.output?.includes('wiki/public.md'))!;
    expect(JSON.parse(search.output!)).toMatchObject([{ path: 'wiki/public.md' }]);
    expect(JSON.stringify(tools)).not.toContain('SAPPHIRE');
    expect(frames(output.text).at(-1)!.data.message.citations).toMatchObject([{ path: 'wiki/public.md', anchor: 'public' }]);
    expect((await f.api(`/conversations/${f.conversation.id}`, 2)).body.messages).toHaveLength(2);
  });

  it('redacts complete mixed-source turns for a member on detail, search snippets and replay, while admin bypasses', async () => {
    const f = await fixture([{ name: 'read_note', arguments: { path: 'wiki/public.md' } },
      { name: 'read_note', arguments: { path: 'wiki/private/secret.md' } },
      'SAPPHIRE [Secret](wiki/private/secret.md) and [Public](wiki/public.md).', 'Safe member answer.']);
    const answer = await f.post(`/conversations/${f.conversation.id}/messages`, { content: 'SAPPHIRE question', context: { notePath: 'wiki/private/secret.md', selection: 'secret selection' } }).expect(200);
    const emitted = frames(answer.text);
    const generation = emitted.find(frame => frame.event === 'generation')!.data.generationId;
    const detail = await f.api(`/conversations/${f.conversation.id}`, 2).expect(200);
    expect(detail.body.messages.map((m:Message) => m.content)).toEqual(['', '']);
    expect(detail.body.messages.every((m:Message) => m.context === null)).toBe(true);
    expect(detail.body.messages[1].citations).toMatchObject([{ path: 'wiki/public.md' }]);
    expect(JSON.stringify(detail.body)).not.toContain('SAPPHIRE');
    expect(JSON.stringify(detail.body)).not.toContain('wiki/private/');
    const replay = await f.api(`/generations/${generation}/events`, 2).expect(200);
    expect(replay.text).not.toContain('SAPPHIRE');
    expect(replay.text).not.toContain('wiki/private/');
    expect(frames(replay.text).filter(frame => ['delta', 'tool'].includes(frame.event))).toEqual([]);
    const last = frames(replay.text).at(-1)!.id;
    expect((await f.api(`/generations/${generation}/events`, 2).set('Last-Event-ID', String(last))).text).toBe('');
    expect((await f.api('/conversations?q=SAPPHIRE', 2)).body.conversations).toEqual([]);
    const admin = await f.api(`/generations/${generation}/events`, 3).expect(200);
    expect(admin.text).toContain('SAPPHIRE');
    await f.post(`/conversations/${f.conversation.id}/messages`, { content: 'Safe follow-up' }, 2).expect(200);
    const latest = f.fake.requests.filter(req => req.path.endsWith('/responses')).at(-1)!;
    expect(JSON.stringify(latest.body.input)).not.toContain('SAPPHIRE');
    expect(JSON.stringify(latest.body.input)).not.toContain('wiki/private/');
  });

  it('withholds live member deltas until later source disclosure and redacts terminal content', async () => {
    const f = await fixture();
    const user = f.repository.addMessage(f.conversation.id, 1, 'user', 'Question')!;
    const assistant = f.repository.addMessage(f.conversation.id, 1, 'assistant', '', [], { status: 'running' })!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let emit!: (event: 'delta'|'sources'|'done', data: unknown) => void;
    const generation = f.generations.start({ conversationId: f.conversation.id, userId: 1, userMessageId: user.id, assistantMessageId: assistant.id }, async (_signal, send) => { emit = send; await gate; });
    await new Promise<void>(resolve => setImmediate(resolve));
    const response = await fetch(`${f.origin}/api/generations/${generation.id}/events`, { headers: { 'x-user': '2' } });
    emit('delta', { text: 'SAPPHIRE early' });
    emit('sources', { paths: ['wiki/private/secret.md'] });
    emit('done', { message: { ...assistant, content: 'SAPPHIRE early', status: 'completed', citations: [{ path: 'wiki/private/secret.md' }] } });
    release();
    const output = await response.text();
    expect(output).not.toContain('SAPPHIRE');
    expect(output).not.toContain('wiki/private/');
    expect(frames(output).at(-1)!.data.message.content).toBe('');
    expect(frames(output).some(frame => frame.event === 'delta')).toBe(false);
  });

  it('denies unreadable proposal sources, explicit and generated read-only targets, and upload save writes', async () => {
    const f = await fixture(['# Draft\nProposed content.']);
    f.repository.addMessage(f.conversation.id, 1, 'user', 'Question');
    const hidden = f.repository.addMessage(f.conversation.id, 1, 'assistant', 'SAPPHIRE', [{ path: 'wiki/private/secret.md' }])!;
    await f.post(`/conversations/${f.conversation.id}/messages/${hidden.id}/proposal`, { mode: 'new' }, 2).expect(404);
    f.acl.create({ prefix: 'wiki/', subjectType: 'user', subject: '2', access: 'read' }, f.admin);
    const visible = f.repository.addMessage(f.conversation.id, 1, 'user', 'Another question')!;
    const answer = f.repository.addMessage(f.conversation.id, 1, 'assistant', '# Draft\nPublic answer.')!;
    f.generations.start({ conversationId: f.conversation.id, userId: 1, userMessageId: visible.id, assistantMessageId: answer.id }, async (_signal, emit) => {
      emit('done', { message: answer });
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    await f.post(`/conversations/${f.conversation.id}/messages/${answer.id}/proposal`, { mode: 'new' }, 2).expect(403);
    await f.post(`/conversations/${f.conversation.id}/messages/${answer.id}/proposal`, { mode: 'edit', path: 'wiki/public.md' }, 2).expect(403);
    const proposal = await f.post(`/conversations/${f.conversation.id}/messages/${answer.id}/proposal`, { mode: 'new' }, 3).expect(200);
    expect(proposal.body.path).toBe('wiki/draft.md');
    f.acl.create({ prefix: 'assets/', subjectType: 'user', subject: '2', access: 'read' }, f.admin);
    const upload = await request(f.server).post('/api/uploads').set('x-user', '2').attach('file', Buffer.from('public attachment'), 'note.txt').expect(201);
    const sha = await f.repo.headSha();
    await f.post(`/uploads/${upload.body.id}/save`, { path: 'assets/note.txt', baseSha: sha }, 2).expect(403);
    expect(await f.repo.headSha()).toBe(sha);
    expect(await f.repo.readFile('assets/note.txt', 'main')).toBeNull();
  });

  it('redacts legacy uncited answers after ACL rules are added, but preserves administrator access', async () => {
    const f = await fixture(['Legacy SAPPHIRE answer with no citations.', 'New safe answer.']);
    for (const rule of f.acl.list()) f.acl.delete(rule.id, f.admin);
    const output = await f.post(`/conversations/${f.conversation.id}/messages`, { content: 'Old question' }).expect(200);
    const generation = frames(output.text).find(frame => frame.event === 'generation')!.data.generationId;
    // Seed the persisted format from before source tracking was introduced.
    f.db.prepare("UPDATE generation_frames SET data=json_remove(data,'$.sourceTracking') WHERE generation_id=? AND event='generation'").run(generation);
    f.db.prepare("DELETE FROM generation_frames WHERE generation_id=? AND event='sources'").run(generation);
    expect(JSON.stringify((await f.api(`/conversations/${f.conversation.id}`, 2)).body)).toContain('Legacy SAPPHIRE');
    f.acl.create({ prefix: 'wiki/private/', subjectType: 'everyone', subject: '', access: 'none' }, f.admin);
    const detail = await f.api(`/conversations/${f.conversation.id}`, 2).expect(200);
    expect(detail.body.messages.map((message: Message) => message.content)).toEqual(['', '']);
    expect((await f.api(`/generations/${generation}/events`, 2)).text).not.toContain('SAPPHIRE');
    expect((await f.api(`/generations/${generation}/events`, 3)).text).toContain('SAPPHIRE');
    await f.post(`/conversations/${f.conversation.id}/messages`, { content: 'New question' }, 2).expect(200);
    const latest = f.fake.requests.filter(req => req.path.endsWith('/responses')).at(-1)!;
    expect(JSON.stringify(latest.body.input)).not.toContain('SAPPHIRE');
    const current = await f.api(`/conversations/${f.conversation.id}`, 2).expect(200);
    expect(current.body.messages.at(-1).content).toBe('New safe answer.');
  });

  it.each(['target', 'role', 'instructions'] as const)('withholds an edit proposal when %s access changes during the real provider request', async (revocation) => {
    let received!: () => void;
    let release!: () => void;
    const requested = new Promise<void>(resolve => { received = resolve; });
    const providerGate = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture(['# Secret\nSAPPHIRE proposal body.'], { received, release: providerGate });
    const user = f.repository.addMessage(f.conversation.id, 1, 'user', 'Draft a note')!;
    const answer = f.repository.addMessage(f.conversation.id, 1, 'assistant', '# Public\nQuartz public fact.', [{ path: 'wiki/public.md' }])!;
    f.generations.start({ conversationId: f.conversation.id, userId: 1, userMessageId: user.id, assistantMessageId: answer.id }, async (_signal, emit) => {
      emit('done', { message: answer });
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    const proposal = f.post(`/conversations/${f.conversation.id}/messages/${answer.id}/proposal`,
      { mode: 'edit', path: 'wiki/private/secret.md' }).then(response => response);
    await requested;
    try {
      if (revocation === 'role') f.db.prepare("UPDATE users SET role='viewer' WHERE id=1").run();
      else f.acl.create({ prefix: revocation === 'target' ? 'wiki/private/secret.md' : 'MEMORY.md',
        subjectType: 'user', subject: '1', access: 'none' }, f.admin);
    } finally { release(); }
    const response = await proposal;
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: 'not_found' } });
    expect(response.text).not.toContain('SAPPHIRE');
    expect(response.body.original).toBeUndefined();
    expect(response.body.proposed).toBeUndefined();
    const provider = f.fake.requests.find(req => req.path.endsWith('/responses'))!;
    expect(JSON.stringify(provider.body.input)).toContain('SAPPHIRE');
  });

  it('does not send a stale readable-history summary into the next answer request after source revocation', async () => {
    let received!: () => void;
    let release!: () => void;
    const requested = new Promise<void>(resolve => { received = resolve; });
    const providerGate = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture(['SAPPHIRE stale summary.', 'Must not consume revoked summary.'], { received, release: providerGate });
    for (let index = 0; index < 9; index++) {
      const user = f.repository.addMessage(f.conversation.id, 1, 'user', `Question ${index}`)!;
      const assistant = f.repository.addMessage(f.conversation.id, 1, 'assistant', `SAPPHIRE fact ${index}`, [{ path: 'wiki/private/secret.md' }])!;
      f.generations.start({ conversationId: f.conversation.id, userId: 1, userMessageId: user.id, assistantMessageId: assistant.id }, async (_signal, emit) => {
        emit('done', { message: assistant });
      });
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const answer = f.post(`/conversations/${f.conversation.id}/messages`, { content: 'Follow up' }).then(response => response);
    await requested;
    try {
      f.acl.create({ prefix: 'wiki/private/', subjectType: 'user', subject: '1', access: 'none' }, f.admin);
    } finally { release(); }
    const response = await answer;
    expect(response.status).toBe(200);
    expect(frames(response.text).at(-1)!.data).toMatchObject({ code: 'generation_failed' });
    expect(response.text).not.toContain('SAPPHIRE');
    const provider = f.fake.requests.filter(req => req.path.endsWith('/responses'));
    expect(provider).toHaveLength(1);
    expect(provider[0]!.body.stream).toBe(false);
    expect(JSON.stringify(provider[0]!.body.input)).toContain('SAPPHIRE');
  });
});
