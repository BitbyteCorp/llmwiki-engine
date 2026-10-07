import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Statement } from 'better-sqlite3';
import { DB } from '../common/tokens.js';
import type { Db } from '../db/index.js';
import type { Conversation, Message } from './conversations.types.js';

type MessageRow = Omit<Message, 'citations'> & { citations: string };

@Injectable()
export class ConversationsRepository {
  private readonly listConversations: Statement<[number], Conversation>;
  private readonly createConversation: Statement<[string, number, string, string, string]>;
  private readonly getConversation: Statement<[string, number], Conversation>;
  private readonly getMessages: Statement<[string, number], MessageRow>;
  private readonly deleteConversation: Statement<[string, number]>;
  private readonly appendMessage: (
    id: string,
    userId: number,
    role: Message['role'],
    content: string,
    citations: string[],
  ) => Message | null;

  constructor(@Inject(DB) db: Db) {
    this.listConversations = db.prepare(`
      SELECT id, title, created_at AS createdAt, updated_at AS updatedAt
      FROM conversations WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC
    `);
    this.createConversation = db.prepare(`
      INSERT INTO conversations (id, user_id, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.getConversation = db.prepare(`
      SELECT id, title, created_at AS createdAt, updated_at AS updatedAt
      FROM conversations WHERE id = ? AND user_id = ?
    `);
    this.getMessages = db.prepare(`
      SELECT m.id, m.role, m.content, m.citations, m.created_at AS createdAt
      FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE c.id = ? AND c.user_id = ? ORDER BY m.created_at ASC, m.rowid ASC
    `);
    this.deleteConversation = db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?');
    const insertMessage = db.prepare<[string, Message['role'], string, string, string, string, number]>(`
      INSERT INTO messages (id, role, content, citations, created_at, conversation_id)
      SELECT ?, ?, ?, ?, ?, id FROM conversations WHERE id = ? AND user_id = ?
    `);
    const touchConversation = db.prepare<[string, Message['role'], string, string, string, number]>(`
      UPDATE conversations SET updated_at = ?, title = CASE
        WHEN ? = 'user' AND title = '' AND NOT EXISTS (
          SELECT 1 FROM messages
          WHERE conversation_id = conversations.id AND role = 'user' AND id <> ?
        ) THEN ? ELSE title END
      WHERE id = ? AND user_id = ?
    `);
    this.appendMessage = db.transaction((
      id: string,
      userId: number,
      role: Message['role'],
      content: string,
      citations: string[],
    ): Message | null => {
      const messageId = randomUUID();
      const createdAt = new Date().toISOString();
      const result = insertMessage.run(messageId, role, content, JSON.stringify(citations), createdAt, id, userId);
      if (result.changes === 0) return null;
      let title = '';
      if (role === 'user') {
        const normalized = content.replace(/\s+/gu, ' ').trim();
        let end = 0;
        let count = 0;
        for (const codepoint of normalized) {
          if (count === 80) break;
          end += codepoint.length;
          count++;
        }
        title = normalized.slice(0, end);
      }
      touchConversation.run(createdAt, role, messageId, title, id, userId);
      return { id: messageId, role, content, citations, createdAt };
    });
  }

  list(userId: number): Conversation[] {
    return this.listConversations.all(userId);
  }

  create(userId: number, title = ''): Conversation {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.createConversation.run(id, userId, title, createdAt, createdAt);
    return { id, title, createdAt, updatedAt: createdAt };
  }

  get(id: string, userId: number): Conversation | null {
    return this.getConversation.get(id, userId) ?? null;
  }

  messages(id: string, userId: number): Message[] {
    return this.getMessages.all(id, userId).map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      citations: JSON.parse(row.citations) as string[],
      createdAt: row.createdAt,
    }));
  }

  delete(id: string, userId: number): boolean {
    return this.deleteConversation.run(id, userId).changes !== 0;
  }

  addMessage(
    id: string,
    userId: number,
    role: Message['role'],
    content: string,
    citations: string[] = [],
  ): Message | null {
    return this.appendMessage(id, userId, role, content, citations);
  }
}
