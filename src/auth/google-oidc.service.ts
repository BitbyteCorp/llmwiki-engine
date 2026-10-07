import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { CONFIG, DB } from '../common/tokens.js';
import { UsersService } from './users.service.js';
import type { User } from './users.types.js';
import type { AuthFlow, GoogleIssuer } from './google-oidc.types.js';

export const GOOGLE_ISSUER = Symbol('GOOGLE_ISSUER');
export const DEFAULT_GOOGLE_ISSUER: GoogleIssuer = {
  issuer: 'https://accounts.google.com',
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
};
const BROWSER_COOKIE = 'llmwiki_oidc';
const BROWSER_TTL = 30 * 24 * 60 * 60 * 1000;
const PENDING_TTL = 10 * 60 * 1000;
const OPAQUE = /^[A-Za-z0-9_-]{43}$/;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');

function authError(status: number, code: string, message: string): Error & { status: number; code: string } {
  return Object.assign(new Error(message), { status, code });
}

function cookie(req: Request, name: string): string | undefined {
  const header = req.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return undefined; }
  }
  return undefined;
}

interface Pending {
  nonce: string;
  verifier: string;
  flow: string;
  expires_at: string;
}

@Injectable()
export class GoogleOidcService {
  private jwks: JWTVerifyGetKey | undefined;

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(DB) private readonly db: Db,
    private readonly users: UsersService,
    @Inject(GOOGLE_ISSUER) private readonly issuer: GoogleIssuer,
  ) {}

  private configuration() {
    const { googleClientId, googleClientSecret } = this.config;
    if (!googleClientId || !googleClientSecret) {
      throw authError(503, 'google_not_configured', 'Google login requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');
    }
    for (const value of [this.issuer.issuer, this.issuer.authorizationEndpoint, this.issuer.tokenEndpoint, this.issuer.jwksUri]) {
      let url: URL;
      try { url = new URL(value); } catch { throw authError(503, 'invalid_google_config', 'Invalid Google issuer URL'); }
      if (url.username || url.password || (url.protocol !== 'https:' && !(this.config.nodeEnv === 'test' && url.protocol === 'http:'))) {
        throw authError(503, 'invalid_google_config', 'Google issuer endpoints must use HTTPS outside tests');
      }
    }
    const redirectUri = new URL('/auth/google/callback', this.config.publicUrl).href;
    return { clientId: googleClientId, clientSecret: googleClientSecret, redirectUri };
  }

  async begin(req: Request, res: Response, flow: AuthFlow): Promise<void> {
    const config = this.configuration();
    const state = random();
    const nonce = random();
    const verifier = random();
    const existingBrowser = cookie(req, BROWSER_COOKIE);
    const browser = existingBrowser && OPAQUE.test(existingBrowser) ? existingBrowser : random();
    const expiresAt = new Date(Date.now() + PENDING_TTL).toISOString();
    this.db.prepare('INSERT INTO auth_pending (state_hash, nonce, verifier, flow, expires_at, browser_hash) VALUES (?, ?, ?, ?, ?, ?)')
      .run(hash(state), nonce, verifier, JSON.stringify(flow), expiresAt, hash(browser));
    if (browser !== existingBrowser) res.cookie(BROWSER_COOKIE, browser, {
      httpOnly: true, sameSite: 'lax', secure: new URL(this.config.publicUrl).protocol === 'https:', path: '/', maxAge: BROWSER_TTL,
    });
    const target = new URL(this.issuer.authorizationEndpoint);
    target.searchParams.set('client_id', config.clientId);
    target.searchParams.set('redirect_uri', config.redirectUri);
    target.searchParams.set('response_type', 'code');
    target.searchParams.set('scope', 'openid email profile');
    target.searchParams.set('state', state);
    target.searchParams.set('nonce', nonce);
    target.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    target.searchParams.set('code_challenge_method', 'S256');
    res.redirect(target.href);
  }

  async callback(req: Request, _res: Response): Promise<{ user: User; flow: AuthFlow }> {
    const config = this.configuration();
    const state = req.query.state;
    const browser = cookie(req, BROWSER_COOKIE);
    if (typeof state !== 'string' || !OPAQUE.test(state) || !browser || !OPAQUE.test(browser)) {
      throw authError(401, 'invalid_google_state', 'Invalid or missing Google login state');
    }
    // Atomically consume only this browser's pending flow, before any asynchronous work.
    const pending = this.db.prepare('DELETE FROM auth_pending WHERE state_hash = ? AND browser_hash = ? RETURNING nonce, verifier, flow, expires_at')
      .get(hash(state), hash(browser)) as Pending | undefined;
    if (!pending || pending.expires_at <= new Date().toISOString()) {
      throw authError(401, 'invalid_google_state', 'Google login state has expired or already been used');
    }
    const flow = JSON.parse(pending.flow) as AuthFlow;
    const code = req.query.code;
    if (req.query.error || typeof code !== 'string' || !code) {
      throw Object.assign(authError(401, 'google_login_denied', 'Google login was denied or returned no code'), { flow });
    }
    let idToken: string;
    try {
      const response = await fetch(this.issuer.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: config.clientId,
          client_secret: config.clientSecret, redirect_uri: config.redirectUri, code_verifier: pending.verifier }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error('Token endpoint rejected the code');
      const tokens: unknown = await response.json();
      if (!tokens || typeof tokens !== 'object' || !('id_token' in tokens) || typeof tokens.id_token !== 'string') {
        throw new Error('Token endpoint returned no ID token');
      }
      idToken = tokens.id_token;
    } catch {
      throw Object.assign(authError(502, 'google_token_exchange_failed', 'Could not exchange the Google authorization code'), { flow });
    }
    let email: string;
    let hd: string | undefined;
    try {
      this.jwks ??= createRemoteJWKSet(new URL(this.issuer.jwksUri));
      const { payload } = await jwtVerify(idToken, this.jwks, {
        issuer: this.issuer.issuer, audience: config.clientId, algorithms: ['RS256'],
        requiredClaims: ['iss', 'aud', 'exp', 'sub', 'nonce', 'email', 'email_verified'],
      });
      if (payload.nonce !== pending.nonce || payload.email_verified !== true || typeof payload.email !== 'string' || !payload.email) {
        throw new Error('Invalid identity claims');
      }
      if (payload.azp !== undefined && payload.azp !== config.clientId) throw new Error('Invalid authorized party');
      if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== config.clientId) {
        throw new Error('Missing authorized party');
      }
      if (payload.hd !== undefined && typeof payload.hd !== 'string') throw new Error('Invalid hosted domain');
      email = payload.email;
      hd = payload.hd as string | undefined;
    } catch {
      throw Object.assign(authError(401, 'invalid_google_token', 'Google identity token is invalid'), { flow });
    }
    const login = this.users.canLogin(email, hd);
    if (!login.ok) throw Object.assign(authError(403, 'login_forbidden', login.reason), { flow });
    return { user: login.user, flow };
  }
}
