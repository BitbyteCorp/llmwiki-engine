import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import cookieParser from 'cookie-parser';
import express, { type ErrorRequestHandler } from 'express';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { openDb, runMigrations } from '../db/index.js';
import { requireMcpAuth, UserService } from './index.js';
import type { GoogleIssuer } from './google.js';
import { createAuthRouter } from './oauth.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'OAuth fixture cleanup failed');
});

async function listen(server: Server): Promise<string> {
  cleanups.push(async () => {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  return `http://127.0.0.1:${address.port}`;
}

const redirectUri = 'http://127.0.0.1:8765/callback';
const verifier = 'a-valid-client-verifier-with-at-least-43-characters';
const challenge = createHash('sha256').update(verifier).digest('base64url');
const clientMetadata = {
  client_name: 'Protocol test client', redirect_uris: [redirectUri],
  token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
};
interface Tokens { access_token: string; refresh_token: string; token_type: string; scope: string; expires_in: number }

async function setup(options: { denyGoogle?: boolean; allowedDomains?: string[] } = {}) {
  const db = openDb(':memory:');
  cleanups.push(() => { db.close(); });
  runMigrations(db);
  const users = new UserService(db);
  const user = users.create({ email: 'admin@example.com', name: 'Admin', role: 'admin' });
  if (options.allowedDomains) users.setSettings({ allowedDomains: options.allowedDomains });
  const keys = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(keys.publicKey), kid: 'oauth-test', alg: 'RS256', use: 'sig' };
  const pending = new Map<string, { nonce: string; challenge: string; redirectUri: string }>();
  let codeCounter = 0;
  const googleAccessToken = 'google-access-token-not-valid-at-the-engine';
  const googleApp = express();
  googleApp.use(express.urlencoded({ extended: false }));
  const googleUrl = await listen(createServer(googleApp));
  const issuer: GoogleIssuer = {
    issuer: googleUrl, authorizationEndpoint: `${googleUrl}/authorize`, tokenEndpoint: `${googleUrl}/token`, jwksUri: `${googleUrl}/jwks`,
  };
  googleApp.get('/jwks', (_req, res) => res.json({ keys: [jwk] }));
  googleApp.get('/authorize', (req, res) => {
    if (req.query.client_id !== 'test' || req.query.response_type !== 'code' || req.query.code_challenge_method !== 'S256') {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const target = new URL(String(req.query.redirect_uri));
    if (options.denyGoogle) {
      target.searchParams.set('error', 'access_denied');
      target.searchParams.set('state', String(req.query.state));
      res.redirect(target.href);
      return;
    }
    const code = `google-code-${++codeCounter}`;
    pending.set(code, { nonce: String(req.query.nonce), challenge: String(req.query.code_challenge), redirectUri: String(req.query.redirect_uri) });
    target.searchParams.set('code', code);
    target.searchParams.set('state', String(req.query.state));
    res.redirect(target.href);
  });
  googleApp.post('/token', async (req, res) => {
    const code = pending.get(String(req.body.code));
    pending.delete(String(req.body.code));
    if (!code || req.body.grant_type !== 'authorization_code' || req.body.client_id !== 'test' || req.body.client_secret !== 'test'
      || req.body.redirect_uri !== code.redirectUri
      || createHash('sha256').update(String(req.body.code_verifier)).digest('base64url') !== code.challenge) {
      res.status(400).json({ error: 'invalid_grant' });
      return;
    }
    const idToken = await new SignJWT({ nonce: code.nonce, email: user.email, email_verified: true, name: 'Admin' })
      .setProtectedHeader({ alg: 'RS256', kid: 'oauth-test' }).setIssuer(googleUrl).setAudience('test')
      .setSubject('google-admin').setExpirationTime('5m').sign(keys.privateKey);
    res.json({ id_token: idToken, access_token: googleAccessToken, token_type: 'Bearer' });
  });

  const app = express();
  const url = await listen(createServer(app));
  const config = loadConfig({ NODE_ENV: 'test', PUBLIC_URL: url, GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: 'test', SESSION_SECRET: 'oauth-test-secret' });
  const ctx = { db, config, users, log: { error() {}, warn() {}, info() {} } } as unknown as AppContext;
  app.use(cookieParser(config.sessionSecret), express.json());
  app.use(createAuthRouter(ctx, issuer));
  app.get('/mcp', requireMcpAuth(ctx), (req, res) => res.json({ user: req.user }));
  const errors: ErrorRequestHandler = (error: Error & { status?: number; code?: string }, _req, res, _next) => {
    res.status(error.status ?? 500).json({ error: { code: error.code, message: error.message } });
  };
  app.use(errors);

  async function form(path: string, values: Record<string, string>) {
    return fetch(`${url}${path}`, { method: 'POST', body: new URLSearchParams(values), redirect: 'manual' });
  }
  async function register() {
    const response = await fetch(`${url}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(clientMetadata) });
    expect(response.status).toBe(201);
    const client = await response.json();
    expect(client).toMatchObject(clientMetadata);
    expect(client.client_id).toEqual(expect.any(String));
    expect(client.client_id).not.toBe('');
    expect(client).not.toHaveProperty('client_secret');
    return client.client_id as string;
  }
  function authorizationUrl(clientId: string, overrides: Record<string, string | null> = {}) {
    const target = new URL('/oauth/authorize', url);
    target.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256', resource: `${url}/mcp`, scope: 'mcp', state: 'client-state' }).toString();
    for (const [key, value] of Object.entries(overrides)) {
      if (value === null) target.searchParams.delete(key);
      else target.searchParams.set(key, value);
    }
    return target;
  }
  async function authorizationResult(clientId: string) {
    const begin = await fetch(authorizationUrl(clientId), { redirect: 'manual' });
    expect(begin.status).toBe(302);
    const googleLocation = new URL(begin.headers.get('location')!);
    expect(googleLocation.origin).toBe(googleUrl);
    const browser = begin.headers.getSetCookie().find((cookie) => cookie.startsWith('llmwiki_oidc='))?.split(';')[0];
    expect(browser).toBeDefined();
    const googleResponse = await fetch(googleLocation, { redirect: 'manual' });
    expect(googleResponse.status).toBe(302);
    const callback = new URL(googleResponse.headers.get('location')!);
    expect(callback.origin).toBe(url);
    expect(callback.pathname).toBe('/auth/google/callback');
    const completed = await fetch(callback, { redirect: 'manual', headers: { cookie: browser! } });
    expect(completed.status).toBe(302);
    const clientLocation = new URL(completed.headers.get('location')!);
    expect(`${clientLocation.origin}${clientLocation.pathname}`).toBe(redirectUri);
    expect(clientLocation.searchParams.get('state')).toBe('client-state');
    expect(clientLocation.searchParams.get('iss')).toBe(url);
    return clientLocation;
  }
  async function authorize(clientId: string) {
    const result = await authorizationResult(clientId);
    expect(result.searchParams.has('error')).toBe(false);
    const code = result.searchParams.get('code');
    expect(code).toBeTruthy();
    return code!;
  }
  function exchange(clientId: string, code: string, overrides: Record<string, string> = {}) {
    return form('/oauth/token', { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier,
      redirect_uri: redirectUri, resource: `${url}/mcp`, ...overrides });
  }
  async function grant(clientId: string): Promise<Tokens> {
    const response = await exchange(clientId, await authorize(clientId));
    expect(response.status).toBe(200);
    return response.json();
  }
  function refresh(clientId: string, token: string) {
    return form('/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: token, resource: `${url}/mcp` });
  }
  function protectedRequest(token?: string) {
    return fetch(`${url}/mcp`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  }
  async function expectDenied(token?: string) {
    const response = await protectedRequest(token);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toMatch(/^Bearer\b/);
    expect(response.headers.get('www-authenticate')).toContain(`resource_metadata="${url}/.well-known/oauth-protected-resource/mcp"`);
  }
  function expireCredential(kind: 'code' | 'access' | 'refresh', token: string) {
    const tables: Record<typeof kind, string> = {
      code: 'oauth_codes', access: 'oauth_access_tokens', refresh: 'oauth_refresh_tokens',
    };
    const column = kind === 'code' ? 'code_hash' : 'token_hash';
    db.prepare(`UPDATE ${tables[kind]} SET expires_at=? WHERE ${column}=?`)
      .run('2000-01-01T00:00:00.000Z', createHash('sha256').update(token).digest('hex'));
  }
  return { url, user, googleAccessToken, form, register, authorizationUrl, authorizationResult, authorize, exchange, grant, refresh, protectedRequest, expectDenied, expireCredential };
}

describe('MCP OAuth authorization server', () => {
  it('advertises protected resources at both discovery paths and public-client authorization capabilities', async () => {
    const fixture = await setup();
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const response = await fetch(`${fixture.url}${path}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ resource: `${fixture.url}/mcp`, authorization_servers: [fixture.url], scopes_supported: ['mcp'], bearer_methods_supported: ['header'] });
    }
    const response = await fetch(`${fixture.url}/.well-known/oauth-authorization-server`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ issuer: fixture.url, authorization_endpoint: `${fixture.url}/oauth/authorize`,
      token_endpoint: `${fixture.url}/oauth/token`, registration_endpoint: `${fixture.url}/oauth/register`, revocation_endpoint: `${fixture.url}/oauth/revoke`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'], client_id_metadata_document_supported: true });
    await fixture.expectDenied();
  });

  it('registers public loopback clients and refuses unsafe redirects or confidential-client authentication', async () => {
    const fixture = await setup();
    await fixture.register();
    for (const [override, error] of [
      [{ redirect_uris: ['http://outside.example.com/callback'] }, 'invalid_redirect_uri'],
      [{ token_endpoint_auth_method: 'client_secret_basic' }, 'invalid_client_metadata'],
    ] as const) {
      const response = await fetch(`${fixture.url}/oauth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...clientMetadata, ...override }) });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error });
    }
  });

  it.each([
    ['Google consent denial', { denyGoogle: true }],
    ['engine domain-policy denial', { allowedDomains: ['outside.example.com'] }],
  ] as Array<[string, { denyGoogle?: boolean; allowedDomains?: string[] }]>)('returns %s to the registered client with state and issuer rather than issuing a code', async (_name, options) => {
    const fixture = await setup(options);
    const result = await fixture.authorizationResult(await fixture.register());
    expect(result.searchParams.get('error')).toBe('access_denied');
    expect(result.searchParams.has('code')).toBe(false);
  });

  it('exchanges a browser-bound Google login for engine tokens, preserves codes after invalid PKCE, and rejects code replay', async () => {
    const fixture = await setup();
    const clientId = await fixture.register();
    const code = await fixture.authorize(clientId);
    const foreignResource = await fixture.exchange(clientId, code, { resource: 'https://another.example.com/mcp' });
    expect(foreignResource.status).toBe(400);
    expect(await foreignResource.json()).toMatchObject({ error: 'invalid_target' });
    for (const overrides of [
      { code_verifier: 'an-incorrect-verifier-with-at-least-43-characters' },
      { redirect_uri: 'http://127.0.0.1:8765/another-callback' },
      { client_id: await fixture.register() },
    ] as Array<Record<string, string>>) {
      const rejected = await fixture.exchange(clientId, code, overrides);
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ error: 'invalid_grant' });
    }
    const exchanged = await fixture.exchange(clientId, code);
    expect(exchanged.status).toBe(200);
    expect(exchanged.headers.get('cache-control')).toContain('no-store');
    const tokens: Tokens = await exchanged.json();
    expect(tokens).toMatchObject({ token_type: 'Bearer', scope: 'mcp', expires_in: expect.any(Number), access_token: expect.any(String), refresh_token: expect.any(String) });
    expect(tokens.expires_in).toBeGreaterThan(0);
    expect(tokens.access_token).not.toBe(fixture.googleAccessToken);
    expect(tokens.refresh_token).not.toBe(tokens.access_token);
    const protectedResponse = await fixture.protectedRequest(tokens.access_token);
    expect(protectedResponse.status).toBe(200);
    expect(await protectedResponse.json()).toMatchObject({ user: { id: fixture.user.id, email: fixture.user.email, role: 'admin' } });
    await fixture.expectDenied(fixture.googleAccessToken);
    const replay = await fixture.exchange(clientId, code);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('rotates refresh tokens and rejects the old token without invalidating the new refresh token', async () => {
    const fixture = await setup();
    const clientId = await fixture.register();
    const initial = await fixture.grant(clientId);
    const refreshed = await fixture.refresh(clientId, initial.refresh_token);
    expect(refreshed.status).toBe(200);
    const next: Tokens = await refreshed.json();
    expect(next.refresh_token).not.toBe(initial.refresh_token);
    expect(next.access_token).not.toBe(initial.access_token);
    expect((await fixture.protectedRequest(next.access_token)).status).toBe(200);
    const replay = await fixture.refresh(clientId, initial.refresh_token);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: 'invalid_grant' });
    expect((await fixture.refresh(clientId, next.refresh_token)).status).toBe(200);
  });

  it('revokes only the requested access token while its refresh token remains usable', async () => {
    const fixture = await setup();
    const clientId = await fixture.register();
    const tokens = await fixture.grant(clientId);
    expect((await fixture.protectedRequest(tokens.access_token)).status).toBe(200);
    const revoked = await fixture.form('/oauth/revoke', { client_id: clientId, token: tokens.access_token, token_type_hint: 'access_token' });
    expect(revoked.status).toBe(200);
    await fixture.expectDenied(tokens.access_token);
    const refreshed = await fixture.refresh(clientId, tokens.refresh_token);
    expect(refreshed.status).toBe(200);
    expect((await fixture.protectedRequest((await refreshed.json()).access_token)).status).toBe(200);
  });

  it('revokes every access and refresh token in a refresh family, including rotated ancestors, but not a separate grant', async () => {
    const fixture = await setup();
    const clientId = await fixture.register();
    const initial = await fixture.grant(clientId);
    const refreshed = await fixture.refresh(clientId, initial.refresh_token);
    expect(refreshed.status).toBe(200);
    const next: Tokens = await refreshed.json();
    const independent = await fixture.grant(clientId);
    for (const token of [initial.access_token, next.access_token]) expect((await fixture.protectedRequest(token)).status).toBe(200);
    const revoked = await fixture.form('/oauth/revoke', { client_id: clientId, token: initial.refresh_token, token_type_hint: 'refresh_token' });
    expect(revoked.status).toBe(200);
    for (const token of [initial.access_token, next.access_token]) await fixture.expectDenied(token);
    for (const token of [initial.refresh_token, next.refresh_token]) {
      const rejected = await fixture.refresh(clientId, token);
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ error: 'invalid_grant' });
    }
    expect((await fixture.protectedRequest(independent.access_token)).status).toBe(200);
    expect((await fixture.refresh(clientId, independent.refresh_token)).status).toBe(200);
  });

  it('rejects an expired authorization code even with the correct PKCE verifier', async () => {
    const fixture = await setup();
    const clientId = await fixture.register();
    const code = await fixture.authorize(clientId);
    fixture.expireCredential('code', code);
    const rejected = await fixture.exchange(clientId, code);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('rejects an expired access token with resource discovery while a live refresh restores access', async () => {
    const fixture = await setup();
    const clientId = await fixture.register();
    const tokens = await fixture.grant(clientId);
    expect((await fixture.protectedRequest(tokens.access_token)).status).toBe(200);
    fixture.expireCredential('access', tokens.access_token);
    await fixture.expectDenied(tokens.access_token);
    const refreshed = await fixture.refresh(clientId, tokens.refresh_token);
    expect(refreshed.status).toBe(200);
    expect((await fixture.protectedRequest((await refreshed.json()).access_token)).status).toBe(200);
  });

  it('rejects an expired refresh token without invalidating a still-live access token', async () => {
    const fixture = await setup();
    const clientId = await fixture.register();
    const tokens = await fixture.grant(clientId);
    fixture.expireCredential('refresh', tokens.refresh_token);
    const rejected = await fixture.refresh(clientId, tokens.refresh_token);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: 'invalid_grant' });
    expect((await fixture.protectedRequest(tokens.access_token)).status).toBe(200);
  });

  it('rejects an unregistered redirect without sending authorization errors to an untrusted client', async () => {
    const fixture = await setup();
    const response = await fetch(fixture.authorizationUrl(await fixture.register(), { redirect_uri: 'http://127.0.0.1:8765/attacker' }), { redirect: 'manual' });
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });
  });

  it.each([
    ['missing resource', { resource: null }, 'invalid_request'],
    ['foreign resource', { resource: 'https://another.example.com/mcp' }, 'invalid_target'],
    ['plain PKCE', { code_challenge_method: 'plain' }, 'invalid_request'],
    ['missing PKCE method', { code_challenge_method: null }, 'invalid_request'],
    ['malformed S256 challenge', { code_challenge: 'short' }, 'invalid_request'],
  ] as Array<[string, Record<string, string | null>, string]>)('returns %s to the registered client without starting Google login', async (_name, overrides, error) => {
    const fixture = await setup();
    const response = await fetch(fixture.authorizationUrl(await fixture.register(), overrides), { redirect: 'manual' });
    expect(response.status).toBe(302);
    const target = new URL(response.headers.get('location')!);
    expect(`${target.origin}${target.pathname}`).toBe(redirectUri);
    expect(target.searchParams.get('error')).toBe(error);
    expect(target.searchParams.get('state')).toBe('client-state');
    expect(target.searchParams.get('iss')).toBe(fixture.url);
    expect(target.searchParams.has('code')).toBe(false);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('fetches matching CIMD documents and keeps the client usable from cache when the document server goes offline', async () => {
    const fixture = await setup();
    const documentApp = express();
    const documentUrl = `${await listen(createServer(documentApp))}/client.json`;
    let requests = 0;
    let available = true;
    documentApp.get('/client.json', (_req, res) => {
      requests++;
      if (!available) { res.sendStatus(503); return; }
      res.json({ ...clientMetadata, client_id: documentUrl });
    });
    const first = await fixture.grant(documentUrl);
    expect((await fixture.protectedRequest(first.access_token)).status).toBe(200);
    expect(requests).toBe(1);
    available = false;
    const second = await fixture.grant(documentUrl);
    expect((await fixture.protectedRequest(second.access_token)).status).toBe(200);
    expect(requests).toBe(1);
  });

  it('rejects CIMD metadata whose client_id does not identify its own document URL', async () => {
    const fixture = await setup();
    const documentApp = express();
    const documentUrl = `${await listen(createServer(documentApp))}/client.json`;
    documentApp.get('/client.json', (_req, res) => res.json({ ...clientMetadata, client_id: `${documentUrl}?different-client` }));
    const response = await fetch(fixture.authorizationUrl(documentUrl), { redirect: 'manual' });
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
    expect(await response.json()).toMatchObject({ error: 'invalid_client' });
  });
});
