import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import Database from 'better-sqlite3';
import express, { type ErrorRequestHandler } from 'express';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { UserService } from './users.js';
import { clearSession, createGoogle, createSession, sessionUser, type AuthFlow, type GoogleIssuer } from './google.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  return `http://127.0.0.1:${address.port}`;
}

async function setup() {
  const keys = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(keys.publicKey), kid: 'google-test', alg: 'RS256', use: 'sig' };
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const migration of ['001_core.sql', '002_auth.sql']) {
    db.exec(readFileSync(new URL(`../db/migrations/${migration}`, import.meta.url), 'utf8'));
  }
  const users = new UserService(db);
  const user = users.create({ email: 'admin@example.com', role: 'admin', name: 'Admin' });
  users.setSettings({ allowlistEnabled: true, allowedDomains: ['example.com'] });
  const codes = new Map<string, { nonce: string; challenge: string }>();
  const tokenRequests: URLSearchParams[] = [];
  let claims: JWTPayload = {};
  let omittedClaim: string | undefined;
  let signingKey = keys.privateKey;
  let codeCounter = 0;
  const issuerApp = express();
  issuerApp.use(express.urlencoded({ extended: false }));
  const issuerServer = createServer(issuerApp);
  const issuerUrl = await listen(issuerServer);
  const issuer: GoogleIssuer = { issuer: issuerUrl, authorizationEndpoint: `${issuerUrl}/authorize`, tokenEndpoint: `${issuerUrl}/token`, jwksUri: `${issuerUrl}/jwks` };
  issuerApp.get('/jwks', (_req, res) => res.json({ keys: [jwk] }));
  issuerApp.get('/authorize', (req, res) => {
    if (req.query.code_challenge_method !== 'S256' || req.query.response_type !== 'code'
      || req.query.client_id !== 'test-client' || req.query.scope !== 'openid email profile') {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const code = `code-${++codeCounter}`;
    codes.set(code, { nonce: String(req.query.nonce), challenge: String(req.query.code_challenge) });
    const target = new URL(String(req.query.redirect_uri));
    target.searchParams.set('code', code);
    target.searchParams.set('state', String(req.query.state));
    res.redirect(target.href);
  });
  issuerApp.post('/token', async (req, res) => {
    const form = new URLSearchParams(req.body as Record<string, string>);
    tokenRequests.push(form);
    const pending = codes.get(form.get('code') ?? '');
    codes.delete(form.get('code') ?? '');
    if (!pending || form.get('grant_type') !== 'authorization_code' || form.get('client_id') !== 'test-client'
      || form.get('client_secret') !== 'test-secret'
      || createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== pending.challenge) {
      res.status(400).json({ error: 'invalid_grant' });
      return;
    }
    const payload: JWTPayload = {
      iss: issuerUrl, aud: 'test-client', sub: 'google-user', exp: Math.floor(Date.now() / 1000) + 300,
      nonce: pending.nonce, email: 'admin@example.com', email_verified: true, hd: 'example.com', ...claims,
    };
    if (omittedClaim) delete payload[omittedClaim];
    const token = await new SignJWT(payload).setProtectedHeader({ alg: 'RS256', kid: 'google-test' }).sign(signingKey);
    res.json({ id_token: token, access_token: 'not-an-engine-token', token_type: 'Bearer' });
  });

  const config = loadConfig({ NODE_ENV: 'test', GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret', SESSION_SECRET: 'test-session-secret' });
  const ctx = { db, config, users } as AppContext;
  const google = createGoogle(ctx, issuer);
  const app = express();
  let flow: AuthFlow = { kind: 'web', next: '/wiki' };
  app.get('/auth/google/login', (req, res) => google.begin(req, res, flow));
  app.get('/auth/google/callback', async (req, res) => res.json(await google.callback(req, res)));
  app.post('/session', (_req, res) => { createSession(ctx, res, user); res.sendStatus(204); });
  app.get('/me', (req, res) => {
    const current = sessionUser(ctx, req);
    if (!current) { res.sendStatus(401); return; }
    res.json(current);
  });
  app.post('/logout', (req, res) => { clearSession(ctx, req, res); res.sendStatus(204); });
  const errors: ErrorRequestHandler = (error: Error & { status?: number; code?: string; flow?: AuthFlow }, _req, res, _next) => {
    res.status(error.status ?? 500).json({ error: { code: error.code, message: error.message }, flow: error.flow });
  };
  app.use(errors);
  const appServer = createServer(app);
  const url = await listen(appServer);
  config.publicUrl = url;
  cleanups.push(async () => {
    await Promise.all([appServer, issuerServer].map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    })));
    db.close();
  });

  async function begin(browser?: string) {
    const response = await fetch(`${url}/auth/google/login`, { redirect: 'manual', headers: browser ? { cookie: browser } : {} });
    expect(response.status).toBe(302);
    const authorization = new URL(response.headers.get('location')!);
    const binding = response.headers.get('set-cookie')?.split(';')[0] ?? browser!;
    return { authorization, browser: binding, response };
  }
  async function authorize(authorization: URL) {
    const response = await fetch(authorization, { redirect: 'manual' });
    expect(response.status).toBe(302);
    return response.headers.get('location')!;
  }
  return {
    ctx, url, user, issuer, google, tokenRequests, begin, authorize,
    setClaims(value: JWTPayload, omit?: string) { claims = value; omittedClaim = omit; },
    setSigningKey(value: CryptoKey) { signingKey = value; },
    setFlow(value: AuthFlow) { flow = value; },
  };
}

describe('Google code flow', () => {
  it('round trips PKCE and identity verification, returns the saved flow, and rejects replay', async () => {
    const fixture = await setup();
    const start = await fixture.begin();
    expect(start.response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(start.response.headers.get('set-cookie')).toContain('SameSite=Lax');
    const callback = await fixture.authorize(start.authorization);
    const result = await fetch(callback, { headers: { cookie: start.browser } });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ user: { id: fixture.user.id, email: 'admin@example.com', role: 'admin' }, flow: { kind: 'web', next: '/wiki' } });
    expect(fixture.tokenRequests[0]!.get('redirect_uri')).toBe(`${fixture.url}/auth/google/callback`);
    expect(fixture.tokenRequests[0]!.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const replay = await fetch(callback, { headers: { cookie: start.browser } });
    expect(replay.status).toBe(401);
    expect(fixture.tokenRequests).toHaveLength(1);
  });

  it('requires the initiating browser but leaves its flow usable after a wrong-browser attempt', async () => {
    const fixture = await setup();
    const start = await fixture.begin();
    const other = await fixture.begin();
    const callback = await fixture.authorize(start.authorization);
    for (const cookie of ['', other.browser]) {
      const rejected = await fetch(callback, { headers: { cookie } });
      expect(rejected.status).toBe(401);
      expect((await rejected.json()).flow).toBeUndefined();
    }
    expect(fixture.tokenRequests).toHaveLength(0);
    const accepted = await fetch(callback, { headers: { cookie: start.browser } });
    expect(accepted.status).toBe(200);
  });

  it('keeps simultaneous web and MCP flows bound to the same browser without overwriting either', async () => {
    const fixture = await setup();
    const web = await fixture.begin();
    const mcpFlow: AuthFlow = { kind: 'mcp', clientId: 'mcp-client', redirectUri: 'http://localhost:8765/callback', challenge: 'mcp-challenge', resource: 'https://wiki.example.com/mcp', state: 'client-state' };
    fixture.setFlow(mcpFlow);
    const mcp = await fixture.begin(web.browser);
    expect(mcp.response.headers.get('set-cookie')).toBeNull();
    expect(mcp.authorization.searchParams.get('state')).not.toBe(web.authorization.searchParams.get('state'));
    for (const [start, expected] of [[mcp, mcpFlow], [web, { kind: 'web', next: '/wiki' }]] as const) {
      const callback = await fixture.authorize(start.authorization);
      const response = await fetch(callback, { headers: { cookie: web.browser } });
      expect(response.status).toBe(200);
      expect((await response.json()).flow).toEqual(expected);
    }
  });

  it.each([
    ['nonce', { nonce: 'wrong-nonce' }, undefined],
    ['issuer', { iss: 'https://wrong.example.com' }, undefined],
    ['audience', { aud: 'another-client' }, undefined],
    ['expiration', { exp: 1 }, undefined],
    ['email verification', { email_verified: false }, undefined],
    ['nonboolean verification', { email_verified: 'true' }, undefined],
    ['authorized party', { azp: 'another-client' }, undefined],
    ['multiple audiences without authorized party', { aud: ['test-client', 'another-client'] }, undefined],
    ['required expiry', {}, 'exp'],
    ['required subject', {}, 'sub'],
  ] as Array<[string, JWTPayload, string | undefined]>)('rejects invalid %s claims and consumes the pending state', async (_name, claims, omitted) => {
    const fixture = await setup();
    fixture.setClaims(claims, omitted);
    const start = await fixture.begin();
    const callback = await fixture.authorize(start.authorization);
    const rejected = await fetch(callback, { headers: { cookie: start.browser } });
    expect(rejected.status).toBe(401);
    expect((await rejected.json()).error.code).toBe('invalid_google_token');
    fixture.setClaims({});
    const retry = await fetch(callback, { headers: { cookie: start.browser } });
    expect(retry.status).toBe(401);
    expect(fixture.tokenRequests).toHaveLength(1);
  });

  it('rejects a forged signature even with matching claims and key ID', async () => {
    const fixture = await setup();
    fixture.setSigningKey((await generateKeyPair('RS256')).privateKey);
    const start = await fixture.begin();
    const callback = await fixture.authorize(start.authorization);
    const response = await fetch(callback, { headers: { cookie: start.browser } });
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('invalid_google_token');
  });

  it.each([
    { hd: 'outside.example.com' },
    { email: 'outsider@example.com' },
    { email: 'admin@outside.example.com' },
  ])('enforces domain and allowlist policy for %j', async (claims) => {
    const fixture = await setup();
    fixture.setClaims(claims);
    const start = await fixture.begin();
    const callback = await fixture.authorize(start.authorization);
    const response = await fetch(callback, { headers: { cookie: start.browser } });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('login_forbidden');
  });

  it('expires pending authorization after ten minutes before exchanging its code', async () => {
    const fixture = await setup();
    const start = await fixture.begin();
    // Force the persisted deadline rather than advancing time for local HTTP servers.
    fixture.ctx.db.prepare('UPDATE auth_pending SET expires_at = ?').run(new Date(Date.now() - 1).toISOString());
    const callback = await fixture.authorize(start.authorization);
    const response = await fetch(callback, { headers: { cookie: start.browser } });
    expect(response.status).toBe(401);
    expect(fixture.tokenRequests).toHaveLength(0);
  });

  it('rejects invalid code exchange and cannot retry consumed pending state', async () => {
    const fixture = await setup();
    const start = await fixture.begin();
    const callback = new URL(`${fixture.url}/auth/google/callback`);
    callback.searchParams.set('state', start.authorization.searchParams.get('state')!);
    callback.searchParams.set('code', 'invalid-code');
    const response = await fetch(callback, { headers: { cookie: start.browser } });
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe('google_token_exchange_failed');
    const retry = await fetch(callback, { headers: { cookie: start.browser } });
    expect(retry.status).toBe(401);
    expect(fixture.tokenRequests).toHaveLength(1);
  });

  it('returns the trusted MCP flow on denial but never on expired or replayed state', async () => {
    const fixture = await setup();
    const flow: AuthFlow = { kind: 'mcp', clientId: 'mcp-client', redirectUri: 'http://localhost:8765/callback', challenge: 'challenge', resource: 'https://wiki.example.com/mcp', state: 'client-state' };
    fixture.setFlow(flow);
    const start = await fixture.begin();
    const callback = new URL(`${fixture.url}/auth/google/callback`);
    callback.searchParams.set('state', start.authorization.searchParams.get('state')!);
    callback.searchParams.set('error', 'access_denied');
    const denied = await fetch(callback, { headers: { cookie: start.browser } });
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ error: { code: 'google_login_denied' }, flow });
    const replay = await fetch(callback, { headers: { cookie: start.browser } });
    expect((await replay.json()).flow).toBeUndefined();
    const expired = await fixture.begin(start.browser);
    fixture.ctx.db.prepare('UPDATE auth_pending SET expires_at = ?').run(new Date(Date.now() - 1).toISOString());
    callback.searchParams.set('state', expired.authorization.searchParams.get('state')!);
    const expiration = await fetch(callback, { headers: { cookie: start.browser } });
    expect(expiration.status).toBe(401);
    expect((await expiration.json()).flow).toBeUndefined();
    expect(fixture.tokenRequests).toHaveLength(0);
  });

  it('fails clearly without Google credentials and disallows HTTP issuer endpoints outside tests', async () => {
    const fixture = await setup();
    fixture.ctx.config.googleClientSecret = undefined;
    const missing = await fetch(`${fixture.url}/auth/google/login`, { redirect: 'manual' });
    expect(missing.status).toBe(503);
    expect((await missing.json()).error.code).toBe('google_not_configured');
    fixture.ctx.config.googleClientSecret = 'test-secret';
    fixture.ctx.config.nodeEnv = 'production';
    const unsafe = await fetch(`${fixture.url}/auth/google/login`, { redirect: 'manual' });
    expect(unsafe.status).toBe(503);
    expect((await unsafe.json()).error.code).toBe('invalid_google_config');
  });
});

describe('signed web sessions', () => {
  it('uses hashed opaque IDs and signed cookies, survives valid access, and revokes on logout', async () => {
    const fixture = await setup();
    fixture.ctx.config.publicUrl = 'https://wiki.example.com';
    const created = await fetch(`${fixture.url}/session`, { method: 'POST' });
    const setCookie = created.headers.get('set-cookie')!;
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('Max-Age=2592000');
    const cookie = setCookie.split(';')[0]!;
    const rawId = cookie.slice('llmwiki_session='.length).split('.')[0]!;
    const stored = fixture.ctx.db.prepare('SELECT id_hash FROM web_sessions').get() as { id_hash: string };
    expect(stored.id_hash).not.toBe(rawId);
    expect(stored.id_hash).toMatch(/^[a-f0-9]{64}$/);
    const current = await fetch(`${fixture.url}/me`, { headers: { cookie } });
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({ id: fixture.user.id, role: 'admin' });
    const forged = `${cookie.slice(0, -1)}${cookie.endsWith('A') ? 'B' : 'A'}`;
    expect((await fetch(`${fixture.url}/me`, { headers: { cookie: forged } })).status).toBe(401);
    const unsigned = `llmwiki_session=${rawId}`;
    expect((await fetch(`${fixture.url}/me`, { headers: { cookie: unsigned } })).status).toBe(401);
    fixture.ctx.config.sessionSecret = 'different-secret';
    expect((await fetch(`${fixture.url}/me`, { headers: { cookie } })).status).toBe(401);
    fixture.ctx.config.sessionSecret = 'test-session-secret';
    const logout = await fetch(`${fixture.url}/logout`, { method: 'POST', headers: { cookie } });
    expect(logout.status).toBe(204);
    expect(logout.headers.get('set-cookie')).toContain('Expires=Thu, 01 Jan 1970');
    expect((await fetch(`${fixture.url}/me`, { headers: { cookie } })).status).toBe(401);
  });

  it('rejects expired sessions and deleted users, and does not revoke valid sessions via tampered logout', async () => {
    const fixture = await setup();
    const created = await fetch(`${fixture.url}/session`, { method: 'POST' });
    const cookie = created.headers.get('set-cookie')!.split(';')[0]!;
    await fetch(`${fixture.url}/logout`, { method: 'POST', headers: { cookie: `${cookie}tampered` } });
    expect((await fetch(`${fixture.url}/me`, { headers: { cookie } })).status).toBe(200);
    fixture.ctx.db.prepare('UPDATE web_sessions SET expires_at = ?').run(new Date(Date.now() - 1).toISOString());
    expect((await fetch(`${fixture.url}/me`, { headers: { cookie } })).status).toBe(401);
    const another = await fetch(`${fixture.url}/session`, { method: 'POST' });
    const anotherCookie = another.headers.get('set-cookie')!.split(';')[0]!;
    // Delete directly because user management correctly protects the last administrator.
    fixture.ctx.db.prepare('DELETE FROM users WHERE id = ?').run(fixture.user.id);
    expect((await fetch(`${fixture.url}/me`, { headers: { cookie: anotherCookie } })).status).toBe(401);
  });
});
