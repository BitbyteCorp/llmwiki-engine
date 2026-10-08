import { fromStorageId, newId, toStorageId } from '../common/ids.js';
import { Inject, Injectable } from '@nestjs/common';
import type { Statement } from 'better-sqlite3';
import { DB } from '../common/tokens.js';
import type { Db } from '../db/index.js';
import type { Citation } from '../agent/agent.types.js';
import type { Conversation, Message, MessageContext, Usage } from './conversations.types.js';
import type { AnswerErrorCode } from '../common/openai-errors.js';

type Row = Omit<Message, 'citations' | 'attachments' | 'context' | 'usage'> & { citations: string; attachments: string; context: string | null; usage: string | null };
const columns = `m.id,m.role,m.content,m.citations,m.attachments,m.context,m.status,m.error_code AS errorCode,m.usage,m.model,m.effort,m.created_at AS createdAt,
  g.id AS generationId`;
const decode = (row: Row): Message => ({ ...row, id: fromStorageId(row.id), generationId: row.generationId ? fromStorageId(row.generationId) : null, citations: (JSON.parse(row.citations) as Array<Citation | string>).map(c => typeof c === 'string' ? { path: c } : c), attachments: (JSON.parse(row.attachments) as string[]).map(fromStorageId), context: row.context ? JSON.parse(row.context) : null, usage: row.usage ? JSON.parse(row.usage) : null });

@Injectable()
export class ConversationsRepository {
  private readonly membership: Statement<[string, number], { role: 'owner' | 'editor' | 'viewer' }>;
  private readonly conversations: Statement<[number, string, string, string], Conversation>;
  private readonly searchSnippet: Statement<[string, string], { content: string }>;
  private readonly conversationMessages: Statement<[string, string], Row>;
  private readonly singleMessage: Statement<[string, string, string, string], Row>;

  constructor(@Inject(DB) private readonly db: Db) {
    this.membership = db.prepare('SELECT role FROM conversation_members WHERE conversation_id=? AND user_id=?');
    this.conversations = db.prepare(`SELECT c.id,c.title,c.created_at AS createdAt,c.updated_at AS updatedAt,cm.role
      FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id
      WHERE cm.user_id=? AND (?='' OR instr(lower(c.title),lower(?))>0 OR EXISTS
        (SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND instr(lower(m.content),lower(?))>0))
      ORDER BY c.updated_at DESC,c.rowid DESC`);
    this.searchSnippet = db.prepare('SELECT content FROM messages WHERE conversation_id=? AND instr(lower(content),lower(?))>0 ORDER BY rowid DESC LIMIT 1');
    this.conversationMessages = db.prepare(`WITH latest AS (
      SELECT assistant_message_id,MAX(rowid) AS generation_rowid FROM generations
      WHERE conversation_id=? GROUP BY assistant_message_id
    ) SELECT ${columns} FROM messages m
      LEFT JOIN latest ON latest.assistant_message_id=m.id
      LEFT JOIN generations g ON g.rowid=latest.generation_rowid
      WHERE m.conversation_id=? ORDER BY m.rowid`);
    this.singleMessage = db.prepare(`SELECT ${columns} FROM messages m
      LEFT JOIN generations g ON g.rowid=(
        SELECT MAX(rowid) FROM generations WHERE conversation_id=? AND assistant_message_id=?
      ) WHERE m.conversation_id=? AND m.id=?`);
  }

  role(id: string, userId: number): 'owner' | 'editor' | 'viewer' | null {
    const stored = toStorageId(id);
    return stored ? this.membership.get(stored,userId)?.role ?? null : null;
  }
  list(userId: number, q = ''): Conversation[] {
    const rows = this.conversations.all(userId,q,q,q);
    if (!q) return rows.map(row => ({ ...row, id: fromStorageId(row.id) }));
    return rows.map(row => {
      const match = this.searchSnippet.get(row.id,q);
      const source = match?.content ?? row.title;
      const start = Math.max(0, source.toLowerCase().indexOf(q.toLowerCase()) - 60);
      return { ...row, id: fromStorageId(row.id), snippet: source.slice(start,start+240) };
    });
  }
  create(userId: number, title = ''): Conversation {
    const id = newId(), stored = toStorageId(id)!, now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO conversations(id,user_id,title,created_at,updated_at) VALUES(?,?,?,?,?)').run(stored,userId,title,now,now);
      this.db.prepare("INSERT INTO conversation_members VALUES(?,?,'owner')").run(stored,userId);
    })();
    return { id,title,createdAt:now,updatedAt:now,role:'owner' };
  }
  get(id: string, userId: number): Conversation | null {
    const row = this.db.prepare(`SELECT c.id,c.title,c.created_at AS createdAt,c.updated_at AS updatedAt,cm.role FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id WHERE c.id=? AND cm.user_id=?`).get(toStorageId(id),userId) as Conversation | undefined;
    return row ? { ...row, id: fromStorageId(row.id) } : null;
  }
  messages(id: string, userId: number): Message[] {
    if (!this.role(id,userId)) return [];
    const stored = toStorageId(id)!;
    return this.conversationMessages.all(stored,stored).map(decode);
  }
  message(id: string, mid: string, userId: number): Message | null {
    if (!this.role(id,userId)) return null;
    const stored = toStorageId(id)!, messageId = toStorageId(mid);
    if (!messageId) return null;
    const row = this.singleMessage.get(stored,messageId,stored,messageId);
    return row ? decode(row) : null;
  }
  delete(id: string, userId: number): boolean {
    return this.db.transaction(() => {
      const stored = toStorageId(id);
      if (!this.db.prepare('SELECT 1 FROM conversations WHERE id=? AND user_id=?').get(stored,userId)) return false;
      this.deleteCheckpoints(this.db.prepare('SELECT id FROM messages WHERE conversation_id=?').all(stored) as Array<{id:string}>);
      return this.db.prepare('DELETE FROM conversations WHERE id=? AND user_id=?').run(stored,userId).changes > 0;
    })();
  }
  rename(id: string, title: string): void {
    this.db.prepare('UPDATE conversations SET title=?,updated_at=? WHERE id=?').run(title,new Date().toISOString(),toStorageId(id));
  }
  addMessage(id: string, userId: number, role: Message['role'], content: string, citations: Array<Citation | string> = [], extra: {attachments?:string[]; context?:MessageContext; status?:Message['status']; model?:string; effort?:string} = {}): Message | null {
    const membership = this.role(id,userId);
    if (!membership || membership === 'viewer') return null;
    const stored = toStorageId(id)!;
    const attachments = (extra.attachments ?? []).map(toStorageId);
    if (attachments.some(attachment => attachment === null)) return null;
    return this.db.transaction(() => {
      const mid=newId(), now=new Date().toISOString();
      const isFirst = role === 'user' && !this.db.prepare("SELECT 1 FROM messages WHERE conversation_id=? AND role='user'").get(stored);
      this.db.prepare(`INSERT INTO messages(id,conversation_id,role,content,citations,created_at,attachments,context,status,model,effort) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(toStorageId(mid),stored,role,content,JSON.stringify(citations),now,JSON.stringify(attachments),extra.context ? JSON.stringify(extra.context) : null,extra.status ?? 'completed',extra.model ?? null,extra.effort ?? null);
      const title = [...content.replace(/\s+/gu,' ').trim()].slice(0,80).join('');
      this.db.prepare("UPDATE conversations SET updated_at=?,title=CASE WHEN title='' AND ? THEN ? ELSE title END WHERE id=?").run(now,isFirst ? 1 : 0,title,stored);
      return this.message(id,mid,userId)!;
    })();
  }
  finish(mid: string, content: string, status: Message['status'], citations: Citation[] = [], usage?:Usage, errorCode?:AnswerErrorCode): void {
    const stored = toStorageId(mid);
    this.db.prepare('UPDATE messages SET content=?,status=?,citations=?,usage=?,error_code=? WHERE id=?').run(content,status,JSON.stringify(citations),usage ? JSON.stringify(usage) : null,errorCode ?? null,stored);
    this.db.prepare('UPDATE conversations SET updated_at=? WHERE id=(SELECT conversation_id FROM messages WHERE id=?)').run(new Date().toISOString(),stored);
  }
  truncate(id: string, mid: string, include = false): void {
    const stored = toStorageId(id);
    const condition = `conversation_id=? AND rowid ${include ? '>=' : '>'} (SELECT rowid FROM messages WHERE id=? AND conversation_id=?)`;
    this.db.transaction(() => {
      this.deleteCheckpoints(this.db.prepare(`SELECT id FROM messages WHERE ${condition}`).all(stored,toStorageId(mid),stored) as Array<{id:string}>);
      this.db.prepare(`DELETE FROM messages WHERE ${condition}`).run(stored,toStorageId(mid),stored);
    })();
  }
  private deleteCheckpoints(messages: Array<{id:string}>): void {
    const remove = this.db.prepare('DELETE FROM agent_checkpoints WHERE owner=?');
    for (const message of messages) remove.run(`message:${fromStorageId(message.id)}`);
  }
  edit(mid: string, content: string): void {
    this.db.prepare('UPDATE messages SET content=?,learned_at=NULL WHERE id=?').run(content,toStorageId(mid));
  }
  members(id: string): Array<{userId:number;email:string;name:string|null;role:'owner'|'editor'|'viewer'}> {
    return this.db.prepare('SELECT cm.user_id AS userId,u.email,u.name,cm.role FROM conversation_members cm JOIN users u ON u.id=cm.user_id WHERE cm.conversation_id=? ORDER BY cm.role,u.id').all(toStorageId(id)) as Array<{userId:number;email:string;name:string|null;role:'owner'|'editor'|'viewer'}>;
  }
  addMember(id: string, email: string, role: 'editor'|'viewer'): boolean {
    const stored = toStorageId(id);
    if (!stored) return false;
    const user = this.db.prepare('SELECT id FROM users WHERE email=? COLLATE NOCASE').get(email) as {id:number}|undefined;
    if (!user) return false;
    this.db.prepare(`INSERT INTO conversation_members VALUES(?,?,?) ON CONFLICT(conversation_id,user_id) DO UPDATE SET role=excluded.role WHERE conversation_members.role<>'owner'`).run(stored,user.id,role);
    return true;
  }
  removeMember(id: string, userId: number): void {
    this.db.prepare("DELETE FROM conversation_members WHERE conversation_id=? AND user_id=? AND role<>'owner'").run(toStorageId(id),userId);
  }
  attachmentOwner(mid: string, attachment: string): number | null {
    const row = this.db.prepare('SELECT u.user_id AS userId FROM uploads u JOIN messages m ON m.id=? JOIN json_each(m.attachments) a ON a.value=u.id WHERE u.id=?').get(toStorageId(mid),toStorageId(attachment)) as {userId:number}|undefined;
    return row?.userId ?? null;
  }
}
