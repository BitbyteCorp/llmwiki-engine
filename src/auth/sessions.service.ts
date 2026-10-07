import { Inject, Injectable } from '@nestjs/common';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CookieOptions, Request, Response } from 'express';
import { CONFIG, DB } from '../common/tokens.js';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { UsersService } from './users.service.js';
import type { User } from './users.types.js';

const SESSION_COOKIE = 'llmwiki_session';
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const OPAQUE = /^[A-Za-z0-9_-]{43}$/;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

@Injectable()
export class SessionsService {
  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(DB) private readonly db: Db,
    private readonly users: UsersService,
  ) {}

  create(res: Response, user: User): void {
    const id = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO web_sessions (id_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(hash(id), user.id, new Date(Date.now() + SESSION_TTL).toISOString());
    res.cookie(SESSION_COOKIE, `${id}.${this.signature(id)}`, { ...this.cookieOptions(), maxAge: SESSION_TTL });
  }

  sessionUser(req: Request): User | null {
    const id = this.sessionId(req);
    if (!id) return null;
    const session = this.db.prepare('SELECT user_id, expires_at FROM web_sessions WHERE id_hash = ?')
      .get(hash(id)) as { user_id: number; expires_at: string } | undefined;
    if (!session) return null;
    if (session.expires_at <= new Date().toISOString()) {
      this.db.prepare('DELETE FROM web_sessions WHERE id_hash = ?').run(hash(id));
      return null;
    }
    return this.users.getById(session.user_id);
  }

  destroy(req: Request, res: Response): void {
    const id = this.sessionId(req);
    if (id) this.db.prepare('DELETE FROM web_sessions WHERE id_hash = ?').run(hash(id));
    res.clearCookie(SESSION_COOKIE, this.cookieOptions());
  }

  private cookieOptions(): CookieOptions {
    return { httpOnly: true, sameSite: 'lax', secure: new URL(this.config.publicUrl).protocol === 'https:', path: '/' };
  }

  private signature(id: string): string {
    return createHmac('sha256', this.config.sessionSecret).update(`${SESSION_COOKIE}:${id}`).digest('base64url');
  }

  private sessionId(req: Request): string | null {
    const header = req.get('cookie');
    if (!header) return null;
    let value: string | undefined;
    for (const part of header.split(';')) {
      const separator = part.indexOf('=');
      if (separator < 0 || part.slice(0, separator).trim() !== SESSION_COOKIE) continue;
      try { value = decodeURIComponent(part.slice(separator + 1).trim()); } catch { return null; }
      break;
    }
    if (!value) return null;
    const [id, mac, extra] = value.split('.');
    if (!id || !mac || extra !== undefined || !OPAQUE.test(id) || !OPAQUE.test(mac)) return null;
    const actual = Buffer.from(mac);
    const expected = Buffer.from(this.signature(id));
    return actual.length === expected.length && timingSafeEqual(actual, expected) ? id : null;
  }
}
