import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId, toStorageId } from '../common/ids.js';
import { openDb, type Db } from '../db/index.js';
import { ConversationsRepository } from './conversations.repository.js';

const schemas = ['001_core.sql', '004_chat.sql', '010_chat.sql', '019_agent_checkpoints.sql'].map((name) =>
  readFileSync(new URL(`../db/migrations/${name}`, import.meta.url), 'utf8'),
);
let dir: string;
let db: Db;
let store: ConversationsRepository;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime('2026-10-07T01:00:00.000Z');
  dir = mkdtempSync(join(tmpdir(), 'chat-storage-'));
  db = openDb(join(dir, 'chat.sqlite'));
  for (const schema of schemas) db.exec(schema);
  db.prepare('INSERT INTO users (id, email, role, created_at) VALUES (?, ?, ?, ?)')
    .run(1, 'one@example.test', 'viewer', '2026-10-07T00:00:00.000Z');
  db.prepare('INSERT INTO users (id, email, role, created_at) VALUES (?, ?, ?, ?)')
    .run(2, 'two@example.test', 'admin', '2026-10-07T00:00:00.000Z');
  store = new ConversationsRepository(db);
});

afterEach(() => {
  db?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('ConversationsRepository', () => {
  it('exposes the running assistant generation to members after reopening without attaching unrelated turns', () => {
    const conversation = store.create(1);
    const question = store.addMessage(conversation.id, 1, 'user', 'Question')!;
    const assistant = store.addMessage(conversation.id, 1, 'assistant', 'Partial', [], { status: 'running' })!;
    const other = store.addMessage(conversation.id, 1, 'assistant', 'Legacy answer')!;
    const generationId = newId();
    db.prepare(`INSERT INTO generations(id,conversation_id,user_message_id,assistant_message_id,user_id,status,created_at)
      VALUES(?,?,?,?,?,'running',?)`).run(toStorageId(generationId), toStorageId(conversation.id), toStorageId(question.id), toStorageId(assistant.id), 1, '2026-10-07T01:00:00.000Z');
    db.close();
    db = openDb(join(dir, 'chat.sqlite'));
    store = new ConversationsRepository(db);

    expect(store.messages(conversation.id, 1)).toEqual([
      { ...question, generationId: null },
      { ...assistant, generationId },
      { ...other, generationId: null },
    ]);
    expect(store.message(conversation.id, assistant.id, 1)?.generationId).toBe(generationId);
    expect(store.messages(conversation.id, 2)).toEqual([]);
    expect(store.message(conversation.id, assistant.id, 2)).toBeNull();
  });

  it('selects the last inserted generation per message only within its conversation', () => {
    const conversation = store.create(1);
    const otherConversation = store.create(1);
    const question = store.addMessage(conversation.id, 1, 'user', 'Question')!;
    const assistant = store.addMessage(conversation.id, 1, 'assistant', 'Answer')!;
    const ungenerated = store.addMessage(conversation.id, 1, 'assistant', 'Unrelated answer')!;
    const latestGenerationId = newId();
    const insert = db.prepare(`INSERT INTO generations(id,conversation_id,user_message_id,assistant_message_id,user_id,status,created_at)
      VALUES(?,?,?,?,?,?,?)`);
    insert.run(toStorageId(newId()), toStorageId(conversation.id), toStorageId(question.id), toStorageId(assistant.id), 1, 'running', '2026-10-08T00:00:00.000Z');
    insert.run(toStorageId(latestGenerationId), toStorageId(conversation.id), toStorageId(question.id), toStorageId(assistant.id), 1, 'failed', '2026-10-06T00:00:00.000Z');
    insert.run(toStorageId(newId()), toStorageId(otherConversation.id), toStorageId(question.id), toStorageId(assistant.id), 1, 'running', '2026-10-09T00:00:00.000Z');
    insert.run(toStorageId(newId()), toStorageId(conversation.id), toStorageId(question.id), null, 1, 'completed', '2026-10-10T00:00:00.000Z');

    expect(store.messages(conversation.id, 1)).toEqual([
      { ...question, generationId: null },
      { ...assistant, generationId: latestGenerationId },
      { ...ungenerated, generationId: null },
    ]);
    expect(store.message(conversation.id, assistant.id, 1)?.generationId).toBe(latestGenerationId);
    expect(store.message(otherConversation.id, assistant.id, 1)).toBeNull();
    expect(store.messages(conversation.id, 2)).toEqual([]);
    expect(store.message(conversation.id, assistant.id, 2)).toBeNull();
  });

  it('stores attachment references in base64url and restores ordered API IDs after reopening', () => {
    const conversation = store.create(1);
    const attachments = ['007pSo2b8iXeAjheKEVRdv', '0000000000000000000001'];
    const question = store.addMessage(conversation.id, 1, 'user', 'Read these files', [], {
      attachments: [attachments[0], '00000000-0000-0000-0000-000000000001'],
    })!;
    expect(question.attachments).toEqual(attachments);
    const persisted = db.prepare('SELECT attachments FROM messages WHERE id = ?').get(toStorageId(question.id)) as { attachments: string };
    expect(JSON.parse(persisted.attachments)).toEqual(['ABEiM0RVRneImaq7zN3u_w', 'AAAAAAAAAAAAAAAAAAAAAQ']);
    db.close();
    db = openDb(join(dir, 'chat.sqlite'));
    store = new ConversationsRepository(db);

    expect(store.message(conversation.id, question.id, 1)?.attachments).toEqual(attachments);
    expect(store.messages(conversation.id, 1)).toEqual([{ ...question, attachments }]);
    expect(store.messages(conversation.id, 2)).toEqual([]);
  });

  it('persists citation objects across reopening, preserving insertion order for equal timestamps', () => {
    const conversation = store.create(1);
    const first = store.addMessage(conversation.id, 1, 'user', 'Question\nwith Unicode 🐈');
    const second = store.addMessage(conversation.id, 1, 'assistant', 'First answer', [{ path: 'wiki/한글.md', heading: '근거', anchor: '근거', sha: 'a'.repeat(40) }, { path: 'wiki/"quoted".md' }]);
    const third = store.addMessage(conversation.id, 1, 'user', 'Follow-up');
    vi.setSystemTime('2026-10-07T01:00:01.000Z');
    const fourth = store.addMessage(conversation.id, 1, 'assistant', 'Final answer', [{ path: 'wiki/final.md' }]);
    db.close();
    db = openDb(join(dir, 'chat.sqlite'));
    store = new ConversationsRepository(db);

    expect(store.messages(conversation.id, 1)).toEqual([first, second, third, fourth]);
    expect(store.messages(conversation.id, 1).map(({ content, citations }) => ({ content, citations }))).toEqual([
      { content: 'Question\nwith Unicode 🐈', citations: [] },
      { content: 'First answer', citations: [{ path: 'wiki/한글.md', heading: '근거', anchor: '근거', sha: 'a'.repeat(40) }, { path: 'wiki/"quoted".md' }] },
      { content: 'Follow-up', citations: [] },
      { content: 'Final answer', citations: [{ path: 'wiki/final.md' }] },
    ]);
    expect(store.get(conversation.id, 1)).toMatchObject({
      title: 'Question with Unicode 🐈',
      createdAt: '2026-10-07T01:00:00.000Z',
      updatedAt: '2026-10-07T01:00:01.000Z',
    });
  });

  it('isolates every read and mutation from nonmembers, including an administrator', () => {
    const own = store.create(1, 'Private conversation');
    const other = store.create(2, 'Another conversation');
    const message = store.addMessage(own.id, 1, 'user', 'Private facts');
    vi.setSystemTime('2026-10-07T02:00:00.000Z');

    expect(store.list(2)).toEqual([other]);
    expect(store.get(own.id, 2)).toBeNull();
    expect(store.messages(own.id, 2)).toEqual([]);
    expect(store.addMessage(own.id, 2, 'user', 'Intrusion')).toBeNull();
    expect(store.addMessage(own.id, 2, 'assistant', 'Intrusion')).toBeNull();
    expect(store.delete(own.id, 2)).toBe(false);
    expect(store.get(own.id, 1)).toEqual(own);
    expect(store.messages(own.id, 1)).toEqual([message]);
    expect(store.get('missing', 1)).toBeNull();
    expect(store.messages('missing', 1)).toEqual([]);
    expect(store.addMessage('missing', 1, 'user', 'No conversation')).toBeNull();
    expect(store.delete('missing', 1)).toBe(false);
  });

  it('normalizes and truncates the first user title by Unicode codepoints without retitling', () => {
    const conversation = store.create(1);
    store.addMessage(conversation.id, 1, 'assistant', 'An assistant cannot name the conversation');
    store.addMessage(conversation.id, 1, 'user', ` \tHello\n\r world   ${'🐈'.repeat(75)} ending`);
    expect(store.get(conversation.id, 1)?.title).toBe(`Hello world ${'🐈'.repeat(68)}`);
    store.addMessage(conversation.id, 1, 'user', 'A new topic');
    expect(store.get(conversation.id, 1)?.title).toBe(`Hello world ${'🐈'.repeat(68)}`);

    const named = store.create(1, 'Chosen title');
    store.addMessage(named.id, 1, 'user', 'Do not replace my title');
    expect(store.get(named.id, 1)?.title).toBe('Chosen title');
  });


  it('lists recently active conversations first without changing their creation times', () => {
    const first = store.create(1, 'First');
    vi.setSystemTime('2026-10-07T01:00:01.000Z');
    const second = store.create(1, 'Second');
    expect(store.list(1).map(({ id }) => id)).toEqual([second.id, first.id]);
    vi.setSystemTime('2026-10-07T01:00:02.000Z');
    store.addMessage(first.id, 1, 'assistant', 'Activity');
    expect(store.list(1)).toEqual([
      { ...first, updatedAt: '2026-10-07T01:00:02.000Z' },
      second,
    ]);
  });

  it('cascades conversation deletion to persisted messages and leaves other records intact', () => {
    const removed = store.create(1, 'Delete this');
    const kept = store.create(1, 'Keep this');
    store.addMessage(removed.id, 1, 'user', 'Delete this message');
    store.addMessage(removed.id, 1, 'assistant', 'Delete these citations', [{ path: 'wiki/remove.md' }]);
    const keptMessage = store.addMessage(kept.id, 1, 'user', 'Keep this message');

    expect(store.delete(removed.id, 1)).toBe(true);
    expect(store.get(removed.id, 1)).toBeNull();
    expect(store.messages(removed.id, 1)).toEqual([]);
    // Query the migration boundary too: ownership filtering alone would hide orphan rows.
    expect(db.prepare('SELECT id FROM messages WHERE conversation_id = ?').all(toStorageId(removed.id))).toEqual([]);
    expect(store.messages(kept.id, 1)).toEqual([keptMessage]);
    expect(store.list(1)).toEqual([kept]);
    expect(store.delete(removed.id, 1)).toBe(false);
  });
});
