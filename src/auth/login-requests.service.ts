import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { CONFIG, DB } from '../common/tokens.js';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { authBrowser, ensureAuthBrowser, opaquePattern } from './auth-browser.js';
import type { AuthFlow } from './google-oidc.types.js';
import { UserServiceError } from './users.types.js';

type McpFlow = Extract<AuthFlow, { kind: 'mcp' }>;

@Injectable()
export class LoginRequestsService {
  constructor(@Inject(CONFIG) private readonly config: Config, @Inject(DB) private readonly db: Db) {}

  create(req: Request, res: Response, flow: McpFlow): string {
    const id = randomBytes(32).toString('base64url');
    const browser = ensureAuthBrowser(req, res, this.config.publicUrl);
    this.db.prepare('INSERT INTO mcp_login_requests (id_hash, browser_hash, flow, expires_at) VALUES (?, ?, ?, ?)')
      .run(createHash('sha256').update(id).digest('hex'), createHash('sha256').update(browser).digest('hex'),
        JSON.stringify(flow), new Date(Date.now() + 10 * 60 * 1000).toISOString());
    return id;
  }

  get(req: Request, id: string, consume = false): McpFlow {
    const browser = authBrowser(req);
    if (!opaquePattern.test(id) || !browser) {
      throw new UserServiceError(404, 'login_request_not_found', 'Login request has expired or is not bound to this browser');
    }
    // DELETE RETURNING makes completion single-use even when password checks overlap.
    const sql = consume
      ? 'DELETE FROM mcp_login_requests WHERE id_hash = ? AND browser_hash = ? AND expires_at > ? RETURNING flow'
      : 'SELECT flow FROM mcp_login_requests WHERE id_hash = ? AND browser_hash = ? AND expires_at > ?';
    const row = this.db.prepare(sql).get(createHash('sha256').update(id).digest('hex'),
      createHash('sha256').update(browser).digest('hex'), new Date().toISOString()) as { flow: string } | undefined;
    if (!row) throw new UserServiceError(404, 'login_request_not_found', 'Login request has expired or is not bound to this browser');
    return JSON.parse(row.flow) as McpFlow;
  }
}
