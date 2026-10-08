import { toStorageId } from '../common/ids.js';
import type { AclService } from '../acl/acl.service.js';
import type { User } from '../auth/users.types.js';
import type { Db } from '../db/index.js';
import type { Message } from './conversations.types.js';
import { notFound } from './api-error.js';

export function chatUser(db: Db, id: number): Pick<User, 'id' | 'role'> {
  const user = db.prepare('SELECT id,role FROM users WHERE id=?').get(id) as Pick<User, 'id' | 'role'> | undefined;
  if (!user) notFound('User not found');
  return user;
}

/** Legacy answers cannot prove which uncited sources they used. Rules activate conservative redaction. */
export function generationTracked(db: Db, id: string): boolean {
  return db.prepare(`SELECT 1 FROM generation_frames WHERE generation_id=? AND event='generation'
    AND json_extract(data,'$.sourceTracking')=1 LIMIT 1`).get(toStorageId(id)) !== undefined;
}

export function generationSources(db: Db, id: string): string[] {
  const paths = new Set<string>();
  const stored = toStorageId(id);
  const generation = db.prepare(`SELECT m.context FROM generations g JOIN messages m ON m.id=g.user_message_id WHERE g.id=?`).get(stored) as { context: string | null } | undefined;
  if (generation?.context) paths.add(JSON.parse(generation.context).notePath);
  const frames = db.prepare("SELECT event,data FROM generation_frames WHERE generation_id=? AND event IN ('sources','citation','tool','done')").iterate(stored) as Iterable<{event: string; data: string}>;
  for (const frame of frames) {
    const data = JSON.parse(frame.data);
    if (frame.event === 'sources') for (const path of data.paths) paths.add(path);
    if ((frame.event === 'citation' || frame.event === 'tool') && data.path) paths.add(data.path);
    if (frame.event === 'done') for (const citation of data.message?.citations ?? []) paths.add(citation.path);
  }
  return [...paths];
}

export function messageSources(db: Db, message: Message): string[] {
  return [...new Set([
    ...message.citations.map(c => c.path),
    ...(message.context ? [message.context.notePath] : []),
    ...(message.generationId ? generationSources(db, message.generationId) : []),
  ])];
}

/** A turn is indivisible: its user text/context and all dependent assistant output share source restrictions. */
export function readableTurns(db: Db, acl: AclService, user: Pick<User, 'id' | 'role'>, messages: Message[]): Array<{ message: Message; readable: boolean; sources: string[] }> {
  const turns: Message[][] = [];
  const requireProvenance = user.role !== 'admin' && acl.list().length > 0;
  for (const message of messages) {
    if (message.role === 'user' || !turns.length) turns.push([]);
    turns.at(-1)!.push(message);
  }
  return turns.flatMap(turn => {
    const sources = [...new Set(turn.flatMap(message => messageSources(db, message)))];
    const pending = user.role !== 'admin' && turn.some(message => {
      if (message.status !== 'running' || !message.generationId) return false;
      const generation = db.prepare('SELECT user_id AS userId FROM generations WHERE id=?').get(toStorageId(message.generationId)) as {userId: number} | undefined;
      return generation?.userId !== user.id;
    });
    const legacy = requireProvenance && turn.some(message => message.role === 'assistant'
      && (!message.generationId || !generationTracked(db, message.generationId)));
    const readable = !pending && !legacy && sources.every(path => acl.canRead(user, path));
    return turn.map(message => ({ message, readable, sources }));
  });
}

export function redactMessage(acl: AclService, user: Pick<User, 'id' | 'role'>, message: Message): Message {
  return { ...message, content: '', context: null, attachments: [], usage: null,
    citations: message.citations.filter(citation => acl.canRead(user, citation.path)) };
}
