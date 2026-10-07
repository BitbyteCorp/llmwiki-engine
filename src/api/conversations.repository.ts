import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DB } from '../common/tokens.js';
import type { Db } from '../db/index.js';
import type { Citation } from '../luna/luna.types.js';
import type { Conversation, Message, MessageContext, Usage } from './conversations.types.js';

type Row = Omit<Message, 'citations' | 'attachments' | 'context' | 'usage'> & { citations: string; attachments: string; context: string | null; usage: string | null };
const columns = `m.id,m.role,m.content,m.citations,m.attachments,m.context,m.status,m.usage,m.model,m.effort,m.created_at AS createdAt,
  (SELECT g.id FROM generations g WHERE g.assistant_message_id=m.id AND g.conversation_id=m.conversation_id ORDER BY g.rowid DESC LIMIT 1) AS generationId`;
const decode = (row: Row): Message => ({ ...row, citations: (JSON.parse(row.citations) as Array<Citation | string>).map(c => typeof c === 'string' ? { path: c } : c), attachments: JSON.parse(row.attachments), context: row.context ? JSON.parse(row.context) : null, usage: row.usage ? JSON.parse(row.usage) : null });

@Injectable()
export class ConversationsRepository {
  constructor(@Inject(DB) private readonly db: Db) {}

  role(id: string, userId: number): 'owner' | 'editor' | 'viewer' | null {
    return (this.db.prepare('SELECT role FROM conversation_members WHERE conversation_id=? AND user_id=?').get(id, userId) as {role: 'owner' | 'editor' | 'viewer'} | undefined)?.role ?? null;
  }
  list(userId: number, q = ''): Conversation[] {
    const rows = this.db.prepare(`SELECT c.id,c.title,c.created_at AS createdAt,c.updated_at AS updatedAt,cm.role
      FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id
      WHERE cm.user_id=? AND (?='' OR instr(lower(c.title),lower(?))>0 OR EXISTS
        (SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND instr(lower(m.content),lower(?))>0))
      ORDER BY c.updated_at DESC,c.rowid DESC`).all(userId,q,q,q) as Conversation[];
    if (!q) return rows;
    return rows.map(row => {
      const match = this.db.prepare('SELECT content FROM messages WHERE conversation_id=? AND instr(lower(content),lower(?))>0 ORDER BY rowid DESC LIMIT 1').get(row.id,q) as {content:string} | undefined;
      const source = match?.content ?? row.title;
      const start = Math.max(0, source.toLowerCase().indexOf(q.toLowerCase()) - 60);
      return { ...row, snippet: source.slice(start,start+240) };
    });
  }
  create(userId: number, title = ''): Conversation {
    const id = randomUUID(), now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO conversations(id,user_id,title,created_at,updated_at) VALUES(?,?,?,?,?)').run(id,userId,title,now,now);
      this.db.prepare("INSERT INTO conversation_members VALUES(?,?,'owner')").run(id,userId);
    })();
    return { id,title,createdAt:now,updatedAt:now,role:'owner' };
  }
  get(id: string, userId: number): Conversation | null {
    return this.db.prepare(`SELECT c.id,c.title,c.created_at AS createdAt,c.updated_at AS updatedAt,cm.role FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id WHERE c.id=? AND cm.user_id=?`).get(id,userId) as Conversation | undefined ?? null;
  }
  messages(id: string, userId: number): Message[] {
    if (!this.role(id,userId)) return [];
    return (this.db.prepare(`SELECT ${columns} FROM messages m WHERE m.conversation_id=? ORDER BY m.rowid`).all(id) as Row[]).map(decode);
  }
  message(id: string, mid: string, userId: number): Message | null {
    if (!this.role(id,userId)) return null;
    const row = this.db.prepare(`SELECT ${columns} FROM messages m WHERE m.conversation_id=? AND m.id=?`).get(id,mid) as Row | undefined;
    return row ? decode(row) : null;
  }
  delete(id: string, userId: number): boolean {
    return this.db.prepare('DELETE FROM conversations WHERE id=? AND user_id=?').run(id,userId).changes > 0;
  }
  rename(id: string, title: string): void {
    this.db.prepare('UPDATE conversations SET title=?,updated_at=? WHERE id=?').run(title,new Date().toISOString(),id);
  }
  addMessage(id: string, userId: number, role: Message['role'], content: string, citations: Array<Citation | string> = [], extra: {attachments?:string[]; context?:MessageContext; status?:Message['status']; model?:string; effort?:string} = {}): Message | null {
    const membership = this.role(id,userId);
    if (!membership || membership === 'viewer') return null;
    return this.db.transaction(() => {
      const mid=randomUUID(), now=new Date().toISOString();
      const isFirst = role === 'user' && !this.db.prepare("SELECT 1 FROM messages WHERE conversation_id=? AND role='user'").get(id);
      this.db.prepare(`INSERT INTO messages(id,conversation_id,role,content,citations,created_at,attachments,context,status,model,effort) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(mid,id,role,content,JSON.stringify(citations),now,JSON.stringify(extra.attachments ?? []),extra.context ? JSON.stringify(extra.context) : null,extra.status ?? 'completed',extra.model ?? null,extra.effort ?? null);
      const title = [...content.replace(/\s+/gu,' ').trim()].slice(0,80).join('');
      this.db.prepare("UPDATE conversations SET updated_at=?,title=CASE WHEN title='' AND ? THEN ? ELSE title END WHERE id=?").run(now,isFirst ? 1 : 0,title,id);
      return this.message(id,mid,userId)!;
    })();
  }
  finish(mid: string, content: string, status: Message['status'], citations: Citation[] = [], usage?:Usage): void {
    this.db.prepare('UPDATE messages SET content=?,status=?,citations=?,usage=? WHERE id=?').run(content,status,JSON.stringify(citations),usage ? JSON.stringify(usage) : null,mid);
    this.db.prepare('UPDATE conversations SET updated_at=? WHERE id=(SELECT conversation_id FROM messages WHERE id=?)').run(new Date().toISOString(),mid);
  }
  truncate(id: string, mid: string, include = false): void {
    this.db.prepare(`DELETE FROM messages WHERE conversation_id=? AND rowid ${include ? '>=' : '>'} (SELECT rowid FROM messages WHERE id=? AND conversation_id=?)`).run(id,mid,id);
  }
  edit(mid: string, content: string): void {
    this.db.prepare('UPDATE messages SET content=?,learned_at=NULL WHERE id=?').run(content,mid);
  }
  members(id: string): Array<{userId:number;email:string;name:string|null;role:'owner'|'editor'|'viewer'}> {
    return this.db.prepare('SELECT cm.user_id AS userId,u.email,u.name,cm.role FROM conversation_members cm JOIN users u ON u.id=cm.user_id WHERE cm.conversation_id=? ORDER BY cm.role,u.id').all(id) as Array<{userId:number;email:string;name:string|null;role:'owner'|'editor'|'viewer'}>;
  }
  addMember(id: string, email: string, role: 'editor'|'viewer'): boolean {
    const user = this.db.prepare('SELECT id FROM users WHERE email=? COLLATE NOCASE').get(email) as {id:number}|undefined;
    if (!user) return false;
    this.db.prepare(`INSERT INTO conversation_members VALUES(?,?,?) ON CONFLICT(conversation_id,user_id) DO UPDATE SET role=excluded.role WHERE conversation_members.role<>'owner'`).run(id,user.id,role);
    return true;
  }
  removeMember(id: string, userId: number): void {
    this.db.prepare("DELETE FROM conversation_members WHERE conversation_id=? AND user_id=? AND role<>'owner'").run(id,userId);
  }
  attachmentOwner(mid: string, attachment: string): number | null {
    const row = this.db.prepare('SELECT u.user_id AS userId FROM uploads u JOIN messages m ON m.id=? JOIN json_each(m.attachments) a ON a.value=u.id WHERE u.id=?').get(mid,attachment) as {userId:number}|undefined;
    return row?.userId ?? null;
  }
}
