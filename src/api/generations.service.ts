import { fromStorageId, newId, parseApiId, toStorageId } from '../common/ids.js';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Statement } from 'better-sqlite3';
import type { Response } from 'express';
import { DB } from '../common/tokens.js';
import type { Db } from '../db/index.js';
import { ApiError, notFound } from './api-error.js';
import type { Generation, GenerationEvent, GenerationStatus } from './generations.types.js';
import { AclService } from '../acl/acl.service.js';
import { chatUser, generationSources, generationTracked, redactMessage } from './acl-chat.js';
import type { Message } from './conversations.types.js';
export type { Generation, GenerationEvent } from './generations.types.js';

const columns = `g.id, g.conversation_id AS conversationId, g.user_message_id AS userMessageId,
  g.assistant_message_id AS assistantMessageId, g.user_id AS userId, g.client_id AS clientId,
  g.status, g.model, g.effort, g.created_at AS createdAt, g.finished_at AS finishedAt`;
interface Frame { seq: number; event: GenerationEvent; data: string }
interface Job { controller: AbortController; seq: number; terminal: boolean }
type Listener = (frame: Frame, terminal: boolean) => void;
type StartInput = Pick<Generation, 'conversationId' | 'userId'> & {
  userMessageId: string; assistantMessageId: string; clientId?: string; model?: string; effort?: string;
};

function fromRow(row: Generation): Generation {
  return {
    ...row,
    id: fromStorageId(row.id),
    conversationId: fromStorageId(row.conversationId),
    userMessageId: row.userMessageId === null ? null : fromStorageId(row.userMessageId),
    assistantMessageId: row.assistantMessageId === null ? null : fromStorageId(row.assistantMessageId),
  };
}

@Injectable()
export class GenerationsService implements OnModuleInit, OnModuleDestroy {
  private readonly jobs = new Map<string, Job>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly memberGeneration: Statement<[string, number], Generation>;
  private readonly membership: Statement<[string, number], { role: string }>;
  private readonly clientGeneration: Statement<[string, string], Generation>;
  private readonly activeGeneration: Statement<[string]>;
  private readonly frames: Statement<[string, number], Frame>;
  private readonly persistFrame: (id: string, frame: Frame, status: GenerationStatus | null) => boolean;

  constructor(@Inject(DB) private readonly db: Db, private readonly acl: AclService) {
    this.memberGeneration = db.prepare(`SELECT ${columns} FROM generations g
      JOIN conversation_members m ON m.conversation_id = g.conversation_id WHERE g.id = ? AND m.user_id = ?`);
    this.membership = db.prepare('SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?');
    this.clientGeneration = db.prepare(`SELECT ${columns} FROM generations g WHERE conversation_id = ? AND client_id = ?`);
    this.activeGeneration = db.prepare("SELECT 1 FROM generations WHERE conversation_id = ? AND status = 'running' LIMIT 1");
    this.frames = db.prepare('SELECT seq,event,data FROM generation_frames WHERE generation_id = ? AND seq > ? ORDER BY seq');
    const insertFrame = db.prepare<[number, GenerationEvent, string, string]>(`INSERT INTO generation_frames (generation_id,seq,event,data)
      SELECT id,?,?,? FROM generations WHERE id = ? AND status = 'running'`);
    const finish = db.prepare<[GenerationStatus, string, string]>('UPDATE generations SET status = ?, finished_at = ? WHERE id = ?');
    const failMessage = db.prepare<[GenerationStatus, string]>('UPDATE messages SET status = ? WHERE id = (SELECT assistant_message_id FROM generations WHERE id = ?)');
    this.persistFrame = db.transaction((id: string, frame: Frame, status: GenerationStatus | null) => {
      const storedId = toStorageId(id)!;
      if (insertFrame.run(frame.seq, frame.event, frame.data, storedId).changes === 0) return false;
      if (status !== null) {
        finish.run(status, new Date().toISOString(), storedId);
        if (status === 'cancelled' || status === 'failed') failMessage.run(status, storedId);
      }
      return true;
    });
  }

  onModuleInit(): void {
    const interrupted = this.db.prepare<[], Generation>(`SELECT ${columns} FROM generations g WHERE status = 'running'`).all().map(fromRow);
    for (const generation of interrupted) {
      this.db.transaction(() => {
        const storedId = toStorageId(generation.id)!;
        const seq = this.db.prepare<[string], { seq: number }>('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM generation_frames WHERE generation_id = ?').get(storedId)!.seq;
        this.db.prepare('INSERT INTO generation_frames (generation_id,seq,event,data) VALUES (?,?,?,?)')
          .run(storedId, seq, 'error', JSON.stringify({ code: 'generation_interrupted', message: 'Generation interrupted by server restart' }));
        this.db.prepare("UPDATE generations SET status = 'interrupted', finished_at = ? WHERE id = ?").run(new Date().toISOString(), storedId);
        this.db.prepare("UPDATE messages SET status = 'interrupted' WHERE id = ?")
          .run(generation.assistantMessageId === null ? null : toStorageId(generation.assistantMessageId));
      })();
    }
  }

  onModuleDestroy(): void {
    for (const [id, job] of this.jobs) {
      job.controller.abort();
      this.emit(id, job, 'error', { code: 'generation_cancelled', message: 'Generation cancelled' });
    }
    this.listeners.clear();
  }

  findClient(conversationId: string, clientId: string): Generation | null {
    const storedId = toStorageId(conversationId);
    if (storedId === null) return null;
    const row = this.clientGeneration.get(storedId, clientId);
    return row ? fromRow(row) : null;
  }

  get(id: string, userId: number): Generation {
    const storedId = toStorageId(id);
    if (storedId === null) notFound('Generation not found');
    const generation = this.memberGeneration.get(storedId, userId);
    if (!generation) notFound('Generation not found');
    return fromRow(generation);
  }

  active(conversationId: string): boolean {
    const storedId = toStorageId(conversationId);
    return storedId !== null && this.activeGeneration.get(storedId) !== undefined;
  }

  start(input: StartInput, run: (signal: AbortSignal, emit: (event: GenerationEvent, data: unknown) => void) => Promise<void>): Generation {
    const conversationId = parseApiId(input.conversationId);
    const userMessageId = parseApiId(input.userMessageId);
    const assistantMessageId = parseApiId(input.assistantMessageId);
    if (!conversationId || !userMessageId || !assistantMessageId) notFound('Generation not found');
    if (input.clientId !== undefined) {
      const existing = this.findClient(conversationId, input.clientId);
      if (existing) return existing;
    }
    if (this.active(conversationId)) throw new ApiError(409, 'generation_active', 'A generation is already running in this conversation');
    const generation: Generation = {
      ...input, id: newId(), conversationId, userMessageId, assistantMessageId, clientId: input.clientId ?? null,
      model: input.model ?? null, effort: input.effort ?? null,
      status: 'running', createdAt: new Date().toISOString(), finishedAt: null,
    };
    const job: Job = { controller: new AbortController(), seq: 0, terminal: false };
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO generations (id,conversation_id,user_message_id,assistant_message_id,user_id,client_id,status,model,effort,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(toStorageId(generation.id), toStorageId(conversationId), toStorageId(userMessageId), toStorageId(assistantMessageId),
        generation.userId, generation.clientId, generation.status, generation.model, generation.effort, generation.createdAt);
      this.emit(generation.id, job, 'generation', { generationId: generation.id, userMessageId: generation.userMessageId, sourceTracking: true });
      this.emit(generation.id, job, 'status', { phase: 'queued' });
    })();
    this.jobs.set(generation.id, job);
    queueMicrotask(() => {
      if (job.terminal) { this.jobs.delete(generation.id); return; }
      void (async () => {
        try {
          await run(job.controller.signal, (event, data) => { this.emit(generation.id, job, event, data); });
          if (!job.terminal) this.emit(generation.id, job, 'error', { code: 'generation_failed', message: 'Generation did not complete' });
        } catch {
          if (!job.terminal) this.emit(generation.id, job, 'error', {
            code: job.controller.signal.aborted ? 'generation_cancelled' : 'generation_failed',
            message: job.controller.signal.aborted ? 'Generation cancelled' : 'Generation failed',
          });
        } finally {
          this.jobs.delete(generation.id);
        }
      })();
    });
    return generation;
  }

  cancel(id: string, userId: number): void {
    const generation = this.get(id, userId);
    const membership = this.membership.get(toStorageId(generation.conversationId)!, userId)!;
    if (membership.role === 'viewer') throw new ApiError(403, 'forbidden', 'Conversation editor role required');
    if (generation.status !== 'running') return;
    const job = this.jobs.get(generation.id);
    if (!job) return;
    job.controller.abort();
    this.emit(generation.id, job, 'error', { code: 'generation_cancelled', message: 'Generation cancelled' });
  }

  stream(id: string, userId: number, res: Response, lastEventId?: string): void {
    const generation = this.get(id, userId);
    id = generation.id;
    const storedId = toStorageId(id)!;
    const storedConversationId = toStorageId(generation.conversationId)!;
    const actor = chatUser(this.db, userId);
    // Other members must wait until the complete source set is known; early deltas can precede hidden citations.
    let deferred = generation.status === 'running' && generation.userId !== userId && actor.role !== 'admin';
    let sourcePaths = generationSources(this.db, id);
    const tracked = generationTracked(this.db, id);
    let cursor = 0;
    if (lastEventId !== undefined && lastEventId !== '') {
      if (!/^\d+$/u.test(lastEventId) || !Number.isSafeInteger(Number(lastEventId))) {
        throw new ApiError(400, 'invalid_input', 'Last-Event-ID must be a non-negative integer');
      }
      cursor = Number(lastEventId);
    }
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    let timer: NodeJS.Timeout | undefined;
    let live = false;
    const subscribers = this.listeners.get(id) ?? new Set<Listener>();
    const close = () => {
      clearInterval(timer);
      subscribers.delete(send);
      if (subscribers.size === 0) this.listeners.delete(id);
      res.off('close', close);
    };
    const project = (frame: Frame) => {
      if (frame.seq <= cursor) return;
      cursor = frame.seq;
      if (frame.event === 'sources') return;
      const reader = chatUser(this.db, userId);
      const readable = (reader.role === 'admin' || this.acl.list().length === 0 || tracked)
        && sourcePaths.every(path => this.acl.canRead(reader, path));
      if (!readable && ['tool', 'citation', 'delta', 'usage'].includes(frame.event)) return;
      let data = frame.data;
      if (frame.event === 'generation') {
        const payload = JSON.parse(data);
        delete payload.sourceTracking;
        data = JSON.stringify(payload);
      }
      if (frame.event === 'done') {
        const payload = JSON.parse(data) as { message: Message };
        const message = payload.message;
        data = JSON.stringify({ ...payload, message: readable
          ? { ...message, citations: (message.citations ?? []).filter(c => this.acl.canRead(reader, c.path)) }
          : redactMessage(this.acl, reader, { ...message, citations: message.citations ?? [] }) });
      }
      res.write(`id: ${frame.seq}\nevent: ${frame.event}\ndata: ${data}\n\n`);
    };
    const send: Listener = (frame, terminal) => {
      if (res.destroyed || res.writableEnded) { close(); return; }
      if (live && !this.membership.get(storedConversationId, userId)) { close(); res.end(); return; }
      if (deferred) {
        if (!terminal) return;
        deferred = false;
        sourcePaths = generationSources(this.db, id);
        for (const stored of this.frames.iterate(storedId, cursor)) project(stored);
      } else {
        if (live && ['sources', 'tool', 'citation', 'done'].includes(frame.event)) sourcePaths = generationSources(this.db, id);
        project(frame);
      }
      if (terminal) { close(); res.end(); }
    };
    res.on('close', close);
    if (!deferred) for (const frame of this.frames.iterate(storedId, cursor)) send(frame, false);
    if (generation.status !== 'running') { close(); res.end(); return; }
    if (res.destroyed || res.writableEnded) { close(); return; }
    live = true;
    subscribers.add(send);
    this.listeners.set(id, subscribers);
    timer = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': ping\n\n'); }, 25_000);
    timer.unref();
  }

  private emit(id: string, job: Job, event: GenerationEvent, data: unknown): void {
    if (job.terminal) return;
    const terminal = event === 'done' || event === 'error';
    const status: GenerationStatus = job.controller.signal.aborted ? 'cancelled' : event === 'done' ? 'succeeded' : 'failed';
    const frame: Frame = { seq: job.seq + 1, event, data: JSON.stringify(data) };
    const inserted = this.persistFrame(id, frame, terminal ? status : null);
    if (!inserted) { job.terminal = true; return; }
    job.seq = frame.seq;
    job.terminal = terminal;
    for (const listener of this.listeners.get(id) ?? []) listener(frame, terminal);
  }
}
