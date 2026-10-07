import { Router, urlencoded, json, type Request, type Response, type RequestHandler } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AppContext } from '../context.js';
import { createGoogle, createSession, clearSession, type GoogleIssuer, type AuthFlow } from './google.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const expiry = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
const pkce = (value: string) => createHash('sha256').update(value).digest('base64url');
const resourceUrl = (ctx: AppContext) => new URL('/mcp', ctx.config.publicUrl).href;
const issuerUrl = (ctx: AppContext) => ctx.config.publicUrl.replace(/\/$/, '');
class OAuthFailure extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
function field(source: unknown, key: string, optional = false): string {
  const value = source && typeof source === 'object' ? (source as Record<string, unknown>)[key] : undefined;
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || !value) throw new OAuthFailure('invalid_request', `${key} is required`);
  return value;
}
interface ClientMetadata {
  client_id: string; client_name?: string; redirect_uris: string[];
  token_endpoint_auth_method: 'none'; grant_types: string[]; response_types: string[];
  client_id_issued_at?: number;
}
function validRedirect(value: string): boolean {
  try {
    const u = new URL(value);
    return !u.username && !u.password && !u.hash && (u.protocol === 'https:' ||
      (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)));
  } catch { return false; }
}
function metadata(input: unknown, clientId: string): ClientMetadata {
  if (!input || typeof input !== 'object') throw new OAuthFailure('invalid_client_metadata', 'Client metadata must be an object');
  const data = input as Record<string, unknown>;
  if (!Array.isArray(data.redirect_uris) || data.redirect_uris.length === 0 || data.redirect_uris.length > 20 ||
    !data.redirect_uris.every((uri) => typeof uri === 'string' && validRedirect(uri))) {
    throw new OAuthFailure('invalid_redirect_uri', 'Register 1–20 HTTPS or loopback HTTP redirect URIs');
  }
  if (data.token_endpoint_auth_method !== undefined && data.token_endpoint_auth_method !== 'none') {
    throw new OAuthFailure('invalid_client_metadata', 'Only public clients (none) are supported');
  }
  if (data.grant_types !== undefined && (!Array.isArray(data.grant_types) || data.grant_types.some((g) => !['authorization_code', 'refresh_token'].includes(String(g))))) {
    throw new OAuthFailure('invalid_client_metadata', 'Unsupported grant type');
  }
  if (data.response_types !== undefined && (!Array.isArray(data.response_types) || data.response_types.some((r) => r !== 'code'))) {
    throw new OAuthFailure('invalid_client_metadata', 'Only code responses are supported');
  }
  if (data.client_name !== undefined && (typeof data.client_name !== 'string' || data.client_name.length > 200)) {
    throw new OAuthFailure('invalid_client_metadata', 'Invalid client name');
  }
  return { client_id: clientId, ...(typeof data.client_name === 'string' ? { client_name: data.client_name } : {}),
    redirect_uris: [...new Set(data.redirect_uris as string[])], token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
}
function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a !== 169 && !(a === 172 && b >= 16 && b <= 31) &&
      !(a === 192 && (b === 168 || b === 0)) && !(a === 100 && b >= 64 && b <= 127) && a < 224;
  }
  // Public IPv6 global unicast only; excludes local, link-local and IPv4-mapped addresses.
  return /^[23][0-9a-f]{0,3}:/i.test(address);
}
async function fetchDocument(url: URL, test: boolean): Promise<unknown> {
  if (url.username || url.password || url.hash || !(url.protocol === 'https:' || (test && url.protocol === 'http:'))) {
    throw new OAuthFailure('invalid_client', 'CIMD client_id must be an HTTPS URL');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true });
  if (!addresses.length || (!test && addresses.some(({ address }) => !publicAddress(address)))) {
    throw new OAuthFailure('invalid_client', 'CIMD must use public network addresses');
  }
  const address = addresses[0];
  return await new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      headers: { accept: 'application/json' },
      // Pin the checked address so a second DNS resolution cannot rebind to a private host.
      lookup: (_host, options, callback) => {
        if (options.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
    }, (response) => {
      if (response.statusCode !== 200) { response.resume(); reject(new OAuthFailure('invalid_client', 'CIMD fetch must return 200 without redirects')); return; }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 65536) { request.destroy(new OAuthFailure('invalid_client', 'CIMD exceeds 64 KiB')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new OAuthFailure('invalid_client', 'CIMD is not JSON')); }
      });
    });
    const timer = setTimeout(() => request.destroy(new OAuthFailure('invalid_client', 'CIMD fetch timed out')), 5000);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
    request.end();
  });
}
async function getClient(ctx: AppContext, id: string): Promise<ClientMetadata> {
  const row = ctx.db.prepare('SELECT kind, metadata, expires_at FROM oauth_clients WHERE client_id = ?').get(id) as
    { kind: string; metadata: string; expires_at: string | null } | undefined;
  if (row && (row.kind === 'dcr' || (row.expires_at && row.expires_at > new Date().toISOString()))) return JSON.parse(row.metadata) as ClientMetadata;
  let url: URL;
  try { url = new URL(id); } catch { throw new OAuthFailure('invalid_client', 'Unknown client'); }
  try {
    const document = await fetchDocument(url, ctx.config.nodeEnv === 'test');
    if (!document || typeof document !== 'object' || (document as Record<string, unknown>).client_id !== id) {
      throw new OAuthFailure('invalid_client', 'CIMD client_id must equal document URL');
    }
    const client = metadata(document, id);
    ctx.db.prepare(`INSERT INTO oauth_clients(client_id,kind,metadata,expires_at) VALUES (?, 'cimd', ?, ?)
      ON CONFLICT(client_id) DO UPDATE SET metadata=excluded.metadata,expires_at=excluded.expires_at`).run(id, JSON.stringify(client), expiry(3600));
    return client;
  } catch (error) {
    if (error instanceof OAuthFailure) throw error;
    throw new OAuthFailure('invalid_client', 'Unable to retrieve client metadata');
  }
}
interface TokenRow { token_hash: string; client_id: string; user_id: number; family_id: string; resource: string; expires_at: string; revoked: number }
function issueTokens(ctx: AppContext, clientId: string, userId: number, resource: string, familyId = random()) {
  const access = random(); const refresh = random();
  ctx.db.prepare('INSERT INTO oauth_access_tokens(token_hash,client_id,user_id,family_id,resource,expires_at) VALUES (?,?,?,?,?,?)')
    .run(hash(access), clientId, userId, familyId, resource, expiry(3600));
  ctx.db.prepare('INSERT INTO oauth_refresh_tokens(token_hash,client_id,user_id,family_id,resource,expires_at) VALUES (?,?,?,?,?,?)')
    .run(hash(refresh), clientId, userId, familyId, resource, expiry(30 * 86400));
  return { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope: 'mcp' };
}
function finishAuthorization(ctx: AppContext, res: Response, userId: number, flow: Extract<AuthFlow, { kind: 'mcp' }>) {
  const code = random();
  ctx.db.prepare('INSERT INTO oauth_codes(code_hash,client_id,user_id,redirect_uri,challenge,resource,expires_at) VALUES (?,?,?,?,?,?,?)')
    .run(hash(code), flow.clientId, userId, flow.redirectUri, flow.challenge, flow.resource, expiry(300));
  const redirect = new URL(flow.redirectUri);
  redirect.searchParams.set('code', code);
  if (flow.state !== undefined) redirect.searchParams.set('state', flow.state);
  redirect.searchParams.set('iss', issuerUrl(ctx));
  res.redirect(redirect.href);
}
export function createAuthRouter(ctx: AppContext, googleIssuer?: GoogleIssuer): Router {
  const router = Router();
  const google = createGoogle(ctx, googleIssuer);
  router.use('/oauth', urlencoded({ extended: false, limit: '64kb' }), json({ limit: '64kb' }));
  const oauth = (handler: (req: Request, res: Response) => unknown | Promise<unknown>): RequestHandler => async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
    try { await handler(req, res); }
    catch (error) {
      if (error instanceof OAuthFailure) res.status(error.status).json({ error: error.code, error_description: error.message });
      else {
        const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : 500;
        res.status(status).json({ error: status >= 500 ? 'server_error' : 'access_denied', error_description: status >= 500 ? 'Authorization failed' : error instanceof Error ? error.message : 'Authorization failed' });
      }
    }
  };
  const protectedMetadata = { resource: resourceUrl(ctx), authorization_servers: [issuerUrl(ctx)], scopes_supported: ['mcp'], bearer_methods_supported: ['header'], resource_name: 'llmwiki-engine' };
  router.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (_req, res) => res.json(protectedMetadata));
  router.get('/.well-known/oauth-authorization-server', (_req, res) => {
    const endpoint = (path: string) => new URL(path, ctx.config.publicUrl).href;
    res.json({ issuer: issuerUrl(ctx), authorization_endpoint: endpoint('/oauth/authorize'), token_endpoint: endpoint('/oauth/token'),
      registration_endpoint: endpoint('/oauth/register'), revocation_endpoint: endpoint('/oauth/revoke'),
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'], revocation_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'], scopes_supported: ['mcp'], client_id_metadata_document_supported: true });
  });
  router.post('/oauth/register', oauth((req, res) => {
    const id = random(); const client = metadata(req.body, id);
    client.client_id_issued_at = Math.floor(Date.now() / 1000);
    ctx.db.prepare("INSERT INTO oauth_clients(client_id,kind,metadata) VALUES (?, 'dcr', ?)").run(id, JSON.stringify(client));
    res.status(201).json(client);
  }));
  router.get('/oauth/authorize', oauth(async (req, res) => {
    const id = field(req.query, 'client_id'); const client = await getClient(ctx, id);
    const redirect = field(req.query, 'redirect_uri');
    if (!client.redirect_uris.includes(redirect)) throw new OAuthFailure('invalid_request', 'redirect_uri is not registered');
    try {
      if (field(req.query, 'response_type') !== 'code') throw new OAuthFailure('unsupported_response_type', 'Use code');
      if (field(req.query, 'code_challenge_method') !== 'S256') throw new OAuthFailure('invalid_request', 'PKCE S256 is required');
      const challenge = field(req.query, 'code_challenge');
      if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new OAuthFailure('invalid_request', 'Invalid S256 challenge');
      const resource = field(req.query, 'resource');
      if (resource !== resourceUrl(ctx)) throw new OAuthFailure('invalid_target', 'Unknown resource');
      const scope = field(req.query, 'scope', true);
      if (scope && scope.split(' ').some((s) => s !== 'mcp')) throw new OAuthFailure('invalid_scope', 'Only mcp scope is supported');
      const state = field(req.query, 'state', true);
      await google.begin(req, res, { kind: 'mcp', clientId: id, redirectUri: redirect, challenge, resource, ...(state ? { state } : {}) });
    } catch (error) {
      // Once the client and exact redirect URI are trusted, OAuth errors go back to that client.
      const target = new URL(redirect);
      target.searchParams.set('error', error instanceof OAuthFailure ? error.code : 'server_error');
      if (error instanceof OAuthFailure) target.searchParams.set('error_description', error.message);
      if (typeof req.query.state === 'string') target.searchParams.set('state', req.query.state);
      target.searchParams.set('iss', issuerUrl(ctx));
      res.redirect(target.href);
    }
  }));
  router.post('/oauth/token', oauth(async (req, res) => {
    const id = field(req.body, 'client_id'); await getClient(ctx, id);
    const grant = field(req.body, 'grant_type');
    const requestedResource = field(req.body, 'resource', true);
    if (requestedResource && requestedResource !== resourceUrl(ctx)) throw new OAuthFailure('invalid_target', 'Unknown resource');
    if (grant === 'authorization_code') {
      const code = field(req.body, 'code'); const verifier = field(req.body, 'code_verifier'); const redirect = field(req.body, 'redirect_uri');
      const tokens = ctx.db.transaction(() => {
        const row = ctx.db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').get(hash(code)) as
          { client_id: string; user_id: number; redirect_uri: string; challenge: string; resource: string; expires_at: string } | undefined;
        if (!row || row.client_id !== id || row.redirect_uri !== redirect || row.expires_at <= new Date().toISOString() ||
          !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || pkce(verifier) !== row.challenge || !ctx.users.getById(row.user_id)) {
          throw new OAuthFailure('invalid_grant', 'Invalid authorization code or PKCE verifier');
        }
        ctx.db.prepare('DELETE FROM oauth_codes WHERE code_hash = ?').run(hash(code));
        return issueTokens(ctx, id, row.user_id, row.resource);
      })();
      res.json(tokens);
    } else if (grant === 'refresh_token') {
      const token = field(req.body, 'refresh_token');
      const scope = field(req.body, 'scope', true);
      if (scope && scope !== 'mcp') throw new OAuthFailure('invalid_scope', 'Only mcp scope is supported');
      const tokens = ctx.db.transaction(() => {
        const row = ctx.db.prepare('SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?').get(hash(token)) as TokenRow | undefined;
        if (!row || row.client_id !== id || row.revoked || row.expires_at <= new Date().toISOString() || !ctx.users.getById(row.user_id)) {
          throw new OAuthFailure('invalid_grant', 'Invalid refresh token');
        }
        ctx.db.prepare('UPDATE oauth_refresh_tokens SET revoked=1 WHERE token_hash = ?').run(hash(token));
        return issueTokens(ctx, id, row.user_id, row.resource, row.family_id);
      })();
      res.json(tokens);
    } else throw new OAuthFailure('unsupported_grant_type', 'Unsupported grant type');
  }));
  router.post('/oauth/revoke', oauth(async (req, res) => {
    const id = field(req.body, 'client_id'); await getClient(ctx, id);
    const tokenHash = hash(field(req.body, 'token'));
    ctx.db.transaction(() => {
      const refresh = ctx.db.prepare('SELECT family_id FROM oauth_refresh_tokens WHERE token_hash=? AND client_id=?').get(tokenHash, id) as { family_id: string } | undefined;
      if (refresh) {
        ctx.db.prepare('UPDATE oauth_refresh_tokens SET revoked=1 WHERE family_id=?').run(refresh.family_id);
        ctx.db.prepare('UPDATE oauth_access_tokens SET revoked=1 WHERE family_id=?').run(refresh.family_id);
      } else ctx.db.prepare('UPDATE oauth_access_tokens SET revoked=1 WHERE token_hash=? AND client_id=?').run(tokenHash, id);
    })();
    res.status(200).end();
  }));
  router.get('/auth/google/login', async (req, res, next) => {
    try {
      const nextPath = typeof req.query.next === 'string' && /^\/(?!\/)/.test(req.query.next) && !/[\\\r\n]/.test(req.query.next) ? req.query.next : '/';
      await google.begin(req, res, { kind: 'web', next: nextPath });
    } catch (error) { next(error); }
  });
  router.get('/auth/google/callback', async (req, res, next) => {
    try {
      const { user, flow } = await google.callback(req, res);
      createSession(ctx, res, user);
      if (flow.kind === 'web') res.redirect(flow.next);
      else finishAuthorization(ctx, res, user.id, flow);
    } catch (error) {
      const flow = error && typeof error === 'object' && 'flow' in error ? error.flow as AuthFlow : undefined;
      if (flow?.kind === 'mcp') {
        const redirect = new URL(flow.redirectUri);
        redirect.searchParams.set('error', 'access_denied');
        if (flow.state !== undefined) redirect.searchParams.set('state', flow.state);
        redirect.searchParams.set('iss', issuerUrl(ctx));
        res.redirect(redirect.href);
      } else next(error);
    }
  });
  router.post('/auth/logout', (req, res) => { clearSession(ctx, req, res); res.status(204).end(); });
  if (ctx.config.devLoginEmail && ctx.config.nodeEnv !== 'production') {
    router.get('/auth/dev-login', (_req, res) => {
      const user = ctx.users.getByEmail(ctx.config.devLoginEmail!);
      if (!user) { res.status(403).json({ error: { code: 'access_denied', message: 'DEV_LOGIN_EMAIL must be an existing user' } }); return; }
      createSession(ctx, res, user); res.redirect('/');
    });
  }
  return router;
}
export function mcpAuthentication(ctx: AppContext): RequestHandler {
  const middleware = requireBearerAuth({
    resourceMetadataUrl: new URL('/.well-known/oauth-protected-resource/mcp', ctx.config.publicUrl).href,
    expectedResource: new URL(resourceUrl(ctx)),
    verifier: { verifyAccessToken: async (token) => {
      const row = ctx.db.prepare('SELECT * FROM oauth_access_tokens WHERE token_hash=?').get(hash(token)) as TokenRow | undefined;
      if (!row || row.revoked || row.expires_at <= new Date().toISOString()) throw new InvalidTokenError('Invalid or expired engine token');
      const user = ctx.users.getById(row.user_id);
      if (!user) throw new InvalidTokenError('User no longer exists');
      return { token, clientId: row.client_id, scopes: ['mcp'], expiresAt: Date.parse(row.expires_at) / 1000,
        resource: new URL(row.resource), extra: { userId: user.id } };
    } },
  });
  return (req, res, next) => middleware(req, res, (error?: unknown) => {
    if (error) { next(error); return; }
    req.user = ctx.users.getById(Number(req.auth?.extra?.userId)) ?? undefined;
    next();
  });
}
