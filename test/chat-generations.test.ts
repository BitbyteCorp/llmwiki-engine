import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GenerationsController } from '../src/api/generations.controller.js';
import { GenerationsService } from '../src/api/generations.service.js';
import type { GenerationEvent } from '../src/api/generations.types.js';
import { RolesGuard } from '../src/auth/guards/roles.guard.js';
import { SessionGuard } from '../src/auth/guards/session.guard.js';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter.js';
import { DB } from '../src/common/tokens.js';
import { openDb, type Db } from '../src/db/index.js';
import type { Logger } from '../src/log.js';

const schemas = ['001_core.sql', '004_chat.sql', '010_chat.sql'].map((name) =>
  readFileSync(new URL(`../src/db/migrations/${name}`, import.meta.url), 'utf8'));
const stamp = '2026-10-07T00:00:00.000Z';
let directory: string;
let db: Db;
let service: GenerationsService;
let app: INestApplication;
let origin: string;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function input(conversationId = 'conversation') {
  const n = db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number };
  const userMessageId = `user-${n.n}`;
  const assistantMessageId = `assistant-${n.n}`;
  const insert = db.prepare("INSERT INTO messages (id,conversation_id,role,content,created_at,status,citations) VALUES (?,?,?,?,?,?,'[]')");
  insert.run(userMessageId, conversationId, 'user', 'Question', stamp, 'completed');
  insert.run(assistantMessageId, conversationId, 'assistant', '', stamp, 'streaming');
  return { conversationId, userMessageId, assistantMessageId, userId: 1 };
}

function events(text: string) {
  return text.split('\n\n').filter((frame) => frame.startsWith('id:')).map((frame) => {
    const rows = frame.split('\n');
    return { id: Number(rows[0]!.slice(4)), event: rows[1]!.slice(7), data: JSON.parse(rows[2]!.slice(6)) as unknown };
  });
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'chat-generations-'));
  db = openDb(join(directory, 'chat.sqlite'));
  for (const schema of schemas) db.exec(schema);
  for (const id of [1, 2, 3, 4]) {
    db.prepare('INSERT INTO users (id,email,role,created_at) VALUES (?,?,?,?)').run(id, `${id}@example.test`, id === 4 ? 'admin' : 'viewer', stamp);
  }
  for (const id of ['conversation', 'other']) {
    db.prepare('INSERT INTO conversations (id,user_id,title,created_at,updated_at) VALUES (?,1,?,?,?)').run(id, id, stamp, stamp);
    for (const [userId, role] of [[1, 'owner'], [2, 'editor'], [3, 'viewer']] as const) {
      db.prepare('INSERT INTO conversation_members VALUES (?,?,?)').run(id, userId, role);
    }
  }
  const module = await Test.createTestingModule({
    controllers: [GenerationsController],
    providers: [GenerationsService, RolesGuard, { provide: DB, useValue: db }],
  }).overrideGuard(SessionGuard).useValue({
    canActivate(context: { switchToHttp(): { getRequest(): Request } }) {
      const request = context.switchToHttp().getRequest();
      const id = Number(request.headers['x-user']);
      if (![1, 2, 3, 4].includes(id)) return false;
      request.user = { id, email: `${id}@example.test`, name: null, role: id === 4 ? 'admin' : 'viewer', createdAt: stamp, lastLoginAt: null };
      return true;
    },
  }).compile();
  app = module.createNestApplication();
  app.useGlobalFilters(new HttpExceptionFilter({ error() {} } as unknown as Logger));
  await app.listen(0, '127.0.0.1');
  origin = await app.getUrl();
  service = module.get(GenerationsService);
});

afterEach(async () => {
  await app?.close();
  db?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

function replay(id: string, user = 1, last?: string) {
  return fetch(`${origin}/api/generations/${id}/events`, {
    headers: { 'x-user': String(user), ...(last === undefined ? {} : { 'Last-Event-ID': last }) },
  });
}

async function settle() {
  await new Promise<void>((resolve) => { setImmediate(resolve); });
}

describe('detached replayable generations', () => {
  it('runs independently of connections and preserves every missed frame after Last-Event-ID', async () => {
    const gate = deferred();
    let emit!: (event: GenerationEvent, data: unknown) => void;
    let signal!: AbortSignal;
    const generation = service.start({ ...input(), clientId: 'request-one' }, async (s, send) => {
      signal = s;
      emit = send;
      await gate.promise;
      send('done', { message: { content: 'Complete answer' } });
    });
    expect(service.findClient('conversation', 'request-one')?.id).toBe(generation.id);
    await settle();
    emit('delta', { text: 'Before connection' });
    const connection = await replay(generation.id);
    const reader = connection.body!.getReader();
    const initial = new TextDecoder().decode((await reader.read()).value);
    expect(events(initial).map(({ id, event }) => ({ id, event }))).toEqual([
      { id: 1, event: 'generation' }, { id: 2, event: 'status' }, { id: 3, event: 'delta' },
    ]);
    await reader.cancel();
    await settle();
    expect(signal.aborted).toBe(false);
    for (let n = 0; n < 1500; n++) emit('delta', { text: String(n) });
    gate.resolve();
    await settle();
    const resumed = events(await (await replay(generation.id, 3, '1499')).text());
    expect(resumed).toEqual([
      { id: 1500, event: 'delta', data: { text: '1496' } },
      { id: 1501, event: 'delta', data: { text: '1497' } },
      { id: 1502, event: 'delta', data: { text: '1498' } },
      { id: 1503, event: 'delta', data: { text: '1499' } },
      { id: 1504, event: 'done', data: { message: { content: 'Complete answer' } } },
    ]);
    expect(service.get(generation.id, 3).status).toBe('succeeded');
    expect(service.active('conversation')).toBe(false);
  });

  it('serializes each conversation while allowing other conversations to progress and duplicate clients to reconnect', async () => {
    const firstGate = deferred();
    const secondGate = deferred();
    let firstRuns = 0;
    let secondRuns = 0;
    const firstInput = { ...input(), clientId: 'same-request' };
    const first = service.start(firstInput, async (_signal, emit) => {
      firstRuns++;
      await firstGate.promise;
      emit('done', { message: { content: 'First answer' } });
    });
    const duplicate = service.start(firstInput, async () => { throw new Error('Duplicate must not execute'); });
    expect(duplicate.id).toBe(first.id);
    expect(() => service.start(input(), async () => {})).toThrowError('A generation is already running');
    const other = service.start(input('other'), async (_signal, emit) => {
      secondRuns++;
      await secondGate.promise;
      emit('done', { message: { content: 'Independent answer' } });
    });
    await settle();
    expect([firstRuns, secondRuns]).toEqual([1, 1]);
    secondGate.resolve();
    await settle();
    expect(service.get(other.id, 1).status).toBe('succeeded');
    expect(service.get(first.id, 1).status).toBe('running');
    firstGate.resolve();
    await settle();
    expect(events(await (await replay(first.id)).text()).at(-1)).toEqual({
      id: 3, event: 'done', data: { message: { content: 'First answer' } },
    });
  });

  it('enforces member rights and explicit cancellation without letting later completion resurrect a cancelled run', async () => {
    const aborted = deferred();
    let signal!: AbortSignal;
    const started = input();
    const generation = service.start(started, async (s, emit) => {
      signal = s;
      s.addEventListener('abort', aborted.resolve, { once: true });
      emit('delta', { text: 'Partial answer' });
      await aborted.promise;
      emit('done', { message: { content: 'Late answer' } });
    });
    await settle();
    expect((await replay(generation.id, 4)).status).toBe(404);
    expect((await fetch(`${origin}/api/generations/${generation.id}/events`)).status).toBe(403);
    expect((await replay(generation.id, 1, 'invalid')).status).toBe(400);
    expect((await replay(generation.id, 1, '9007199254740992')).status).toBe(400);
    for (const [user, expected] of [[3, 403], [4, 404]] as const) {
      const response = await fetch(`${origin}/api/generations/${generation.id}/cancel`, { method: 'POST', headers: { 'x-user': String(user) } });
      expect(response.status).toBe(expected);
    }
    expect(signal.aborted).toBe(false);
    const live = await replay(generation.id, 3);
    const body = live.text();
    const cancel = await fetch(`${origin}/api/generations/${generation.id}/cancel`, { method: 'POST', headers: { 'x-user': '2' } });
    expect(cancel.status).toBe(204);
    expect(signal.aborted).toBe(true);
    expect(events(await body)).toEqual([
      { id: 1, event: 'generation', data: { generationId: generation.id, userMessageId: started.userMessageId } },
      { id: 2, event: 'status', data: { phase: 'queued' } },
      { id: 3, event: 'delta', data: { text: 'Partial answer' } },
      { id: 4, event: 'error', data: { code: 'generation_cancelled', message: 'Generation cancelled' } },
    ]);
    expect(service.get(generation.id, 2).status).toBe('cancelled');
    expect(db.prepare('SELECT status FROM messages WHERE id = ?').get(started.assistantMessageId)).toEqual({ status: 'cancelled' });
    const repeat = await fetch(`${origin}/api/generations/${generation.id}/cancel`, { method: 'POST', headers: { 'x-user': '1' } });
    expect(repeat.status).toBe(204);
    expect(events(await (await replay(generation.id, 1, '4')).text())).toEqual([]);
  });

  it('maps uncaught run failures to safe persisted terminal errors', async () => {
    const generation = service.start(input(), async (_signal, emit) => {
      emit('delta', { text: 'Saved prefix' });
      throw new Error('secret API key sk-private and upstream stack trace');
    });
    await settle();
    const output = events(await (await replay(generation.id)).text());
    expect(output.at(-1)).toEqual({
      id: 4, event: 'error', data: { code: 'generation_failed', message: 'Generation failed' },
    });
    expect(service.get(generation.id, 1).status).toBe('failed');
    expect(service.active('conversation')).toBe(false);
  });

  it('persists startup interruption after reopening SQLite and preserves already delivered frames', async () => {
    const started = input();
    const generation = service.start(started, async (_signal, emit) => {
      emit('delta', { text: 'Before crash' });
      await new Promise<void>(() => {});
    });
    await settle();
    const reopened = openDb(join(directory, 'chat.sqlite'));
    try {
      const restarted = new GenerationsService(reopened);
      restarted.onModuleInit();
      expect(restarted.get(generation.id, 3).status).toBe('interrupted');
      expect(restarted.active('conversation')).toBe(false);
      expect(reopened.prepare('SELECT status FROM messages WHERE id = ?').get(started.assistantMessageId)).toEqual({ status: 'interrupted' });
      expect(events(await (await replay(generation.id, 3, '2')).text())).toEqual([
        { id: 3, event: 'delta', data: { text: 'Before crash' } },
        { id: 4, event: 'error', data: { code: 'generation_interrupted', message: 'Generation interrupted by server restart' } },
      ]);
      restarted.onModuleInit();
      expect(events(await (await replay(generation.id, 3, '4')).text())).toEqual([]);
    } finally {
      reopened.close();
    }
  });

  it('aborts active jobs on lifecycle shutdown and closes their streams', async () => {
    const aborted = deferred();
    let signal!: AbortSignal;
    const generation = service.start(input(), async (s) => {
      signal = s;
      s.addEventListener('abort', aborted.resolve, { once: true });
      await aborted.promise;
    });
    await settle();
    const response = await replay(generation.id);
    const body = response.text();
    service.onModuleDestroy();
    expect(signal.aborted).toBe(true);
    expect(events(await body).at(-1)).toEqual({
      id: 3, event: 'error', data: { code: 'generation_cancelled', message: 'Generation cancelled' },
    });
    expect(service.get(generation.id, 1).status).toBe('cancelled');
    await settle();
  });

  it('ends a revoked member stream before sending additional frames without cancelling the shared run', async () => {
    const gate = deferred();
    let emit!: (event: GenerationEvent, data: unknown) => void;
    let signal!: AbortSignal;
    const generation = service.start(input(), async (s, send) => {
      signal = s;
      emit = send;
      await gate.promise;
      send('done', { message: { content: 'Member-only answer' } });
    });
    await settle();
    const revoked = await replay(generation.id, 3);
    const revokedBody = revoked.text();
    db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').run('conversation', 3);
    emit('delta', { text: 'Confidential continuation' });
    expect(events(await revokedBody).map(({ event }) => event)).toEqual(['generation', 'status']);
    expect(signal.aborted).toBe(false);
    expect((await replay(generation.id, 3)).status).toBe(404);
    gate.resolve();
    await settle();
    expect(events(await (await replay(generation.id, 1, '2')).text())).toEqual([
      { id: 3, event: 'delta', data: { text: 'Confidential continuation' } },
      { id: 4, event: 'done', data: { message: { content: 'Member-only answer' } } },
    ]);
  });

  it('retains historical replay and client deduplication after both messages of a superseded turn are removed', async () => {
    const started = { ...input(), clientId: 'historical-request' };
    const generation = service.start(started, async (_signal, emit) => {
      emit('done', { message: { content: 'Historical answer' } });
    });
    await settle();
    db.prepare('DELETE FROM messages WHERE id = ?').run(started.assistantMessageId);
    expect(service.findClient('conversation', 'historical-request')).toMatchObject({
      id: generation.id, assistantMessageId: null, status: 'succeeded',
    });
    db.prepare('DELETE FROM messages WHERE id = ?').run(started.userMessageId);
    expect(service.findClient('conversation', 'historical-request')).toMatchObject({
      id: generation.id, userMessageId: null, assistantMessageId: null, status: 'succeeded',
    });
    expect(service.start(started, async () => { throw new Error('Old request must not restart'); }).id).toBe(generation.id);
    expect(events(await (await replay(generation.id, 1, '2')).text())).toEqual([
      { id: 3, event: 'done', data: { message: { content: 'Historical answer' } } },
    ]);
  });
});
