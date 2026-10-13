import 'reflect-metadata';
import { Controller, Get, Post, UseGuards, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import type { Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { AuditService } from '../audit/audit.service.js';
import { apiIdToLegacyUuid, toStorageId } from '../common/ids.js';
import { CONFIG, DB } from '../common/tokens.js';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter.js';
import { loadConfig } from '../config.js';
import { ApiTokensController } from './api-tokens.controller.js';
import { ApiTokensRepository } from './api-tokens.repository.js';
import { ApiTokensService } from './api-tokens.service.js';
import { AuthCleanupService } from './auth-cleanup.service.js';
import { registerAuthCommands } from './auth.commands.js';
import { AuthController } from './auth.controller.js';
import { Roles } from './decorators/roles.decorator.js';
import { RolesGuard } from './guards/roles.guard.js';
import { SessionGuard } from './guards/session.guard.js';
import { SessionOnlyGuard } from './guards/session-only.guard.js';
import { GoogleOidcService } from './google-oidc.service.js';
import { OAuthController } from './oauth.controller.js';
import { OAuthRepository } from './oauth.repository.js';
import { LoginRequestsService } from './login-requests.service.js';
import { OAuthService } from './oauth.service.js';
import { SessionsService } from './sessions.service.js';
import { UsersRepository } from './users.repository.js';
import { UsersService } from './users.service.js';
import type { User } from './users.types.js';

// HTTP seam for the policy used by REST read/admin/chat controllers.
@Controller('policy')
@UseGuards(SessionGuard, RolesGuard)
class PolicyController {
  @Get('read') read() { return { access: 'read' }; }
  @Get('admin') @Roles('admin') admin() { return { access: 'admin' }; }
  @Post('admin') @Roles('admin') mutateAdmin() { return { access: 'admin-mutation' }; }
  @Post('chat') chat() { return { access: 'chat' }; }
  @Post('write') @Roles('editor') write() { return { access: 'write' }; }
}

const origin = 'https://wiki.example.com';
let db: Database.Database;
let app: INestApplication;
let users: UsersService;
let tokens: ApiTokensService;
let sessions: SessionsService;
let owner: User;
let admin: User;
let other: User;
let cleanup: AuthCleanupService;

function cookie(user: User): string {
  let value = '';
  sessions.create({ cookie: (name: string, secret: string) => { value = `${name}=${secret}`; } } as Response, user);
  return value;
}

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const name of ['001_core.sql', '002_auth.sql', '011_platform.sql', '013_acl.sql', '027_user_passwords.sql', '028_mcp_login_requests.sql']) {
    db.exec(readFileSync(new URL(`../db/migrations/${name}`, import.meta.url), 'utf8'));
  }
  const module = await Test.createTestingModule({
    controllers: [AuthController, OAuthController, ApiTokensController, PolicyController],
    providers: [UsersRepository, UsersService, SessionsService, ApiTokensRepository, ApiTokensService,
      AuditService, LoginRequestsService, SessionGuard, SessionOnlyGuard, RolesGuard, OAuthRepository, OAuthService,
      { provide: GoogleOidcService, useValue: {} },
      { provide: CONFIG, useValue: loadConfig({ NODE_ENV: 'test', PUBLIC_URL: origin, SESSION_SECRET: 'test-secret', AUTH_CLEANUP_INTERVAL_MS: '1000' }) },
      { provide: DB, useValue: db }],
  }).compile();
  app = module.createNestApplication();
  app.useGlobalFilters(new HttpExceptionFilter({ error: vi.fn() } as never));
  await app.init();
  users = app.get(UsersService);
  tokens = app.get(ApiTokensService);
  sessions = app.get(SessionsService);
  owner = await users.create({ email: 'owner@example.com', role: 'viewer' });
  admin = await users.create({ email: 'admin@example.com', role: 'admin' });
  other = await users.create({ email: 'other@example.com', role: 'editor' });
  cleanup = new AuthCleanupService(loadConfig({ NODE_ENV: 'test', AUTH_CLEANUP_INTERVAL_MS: '1000' }), db);
});

afterEach(async () => {
  cleanup?.onModuleDestroy();
  vi.useRealTimers();
  await app?.close();
  db?.close();
});

async function mint(user: User, scopes: Array<'read' | 'write'>, expiresAt?: string) {
  const response = await request(app.getHttpServer()).post('/api/tokens').set('cookie', cookie(user)).set('origin', origin)
    .send({ name: 'Automation', scopes, ...(expiresAt ? { expiresAt } : {}) }).expect(201);
  return response.body as { id: string; token: string; lastUsedAt: string | null };
}

describe('REST API tokens', () => {
  it('reveals a random secret once, stores only its hash, and records usage', async () => {
    const issued = await mint(owner, ['read']);
    expect(issued.id).toMatch(/^[0-9A-Za-z]{22}$/);
    expect(issued.token).toMatch(/^lwk_[A-Za-z0-9_-]{43}$/);
    expect(issued.lastUsedAt).toBeNull();
    const stored = db.prepare('SELECT token_hash FROM api_tokens WHERE id = ?').get(toStorageId(issued.id)) as { token_hash: string };
    expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.token_hash).not.toBe(issued.token);
    await request(app.getHttpServer()).get('/policy/read').set('authorization', `Bearer ${issued.token}`).expect(200, { access: 'read' });
    const list = await request(app.getHttpServer()).get('/api/tokens').set('cookie', cookie(owner)).expect(200);
    expect(list.body.tokens[0]).toMatchObject({ id: issued.id, scopes: ['read'], userId: owner.id, revokedAt: null });
    expect(list.body.tokens[0].lastUsedAt).toEqual(expect.any(String));
    expect(list.body.tokens[0]).not.toHaveProperty('token');
    expect(list.body.tokens[0]).not.toHaveProperty('token_hash');
  });

  it('enforces independent read/write scopes and current roles, including admin and chat negatives', async () => {
    const read = await mint(owner, ['read']);
    const write = await mint(owner, ['write']);
    const adminRead = await mint(admin, ['read']);
    const editorWrite = await mint(other, ['write']);
    await request(app.getHttpServer()).post('/policy/chat').set('authorization', `Bearer ${read.token}`).expect(403);
    await request(app.getHttpServer()).get('/policy/read').set('authorization', `Bearer ${write.token}`).expect(403);
    await request(app.getHttpServer()).get('/policy/admin').set('authorization', `Bearer ${read.token}`).expect(403);
    await request(app.getHttpServer()).post('/policy/write').set('authorization', `Bearer ${write.token}`).expect(403);
    await request(app.getHttpServer()).get('/policy/admin').set('authorization', `Bearer ${adminRead.token}`).expect(200);
    await request(app.getHttpServer()).post('/policy/chat').set('authorization', `Bearer ${write.token}`).set('origin', 'https://evil.example').expect(201, { access: 'chat' });
    await request(app.getHttpServer()).post('/policy/write').set('authorization', `Bearer ${editorWrite.token}`).expect(201);
    users.update(other.id, { role: 'viewer' });
    await request(app.getHttpServer()).post('/policy/write').set('authorization', `Bearer ${editorWrite.token}`).expect(403);
  });

  it('denies bearer minting even alongside a valid session, and never uses cookies as bearer fallback', async () => {
    const issued = await mint(admin, ['read', 'write']);
    await request(app.getHttpServer()).post('/api/tokens').set('authorization', `Bearer ${issued.token}`).set('cookie', cookie(admin))
      .set('origin', origin).send({ name: 'Escalation', scopes: ['write'] }).expect(403);
    await request(app.getHttpServer()).get('/policy/read').set('authorization', 'Bearer oauth_mcp_token').set('cookie', cookie(admin)).expect(401);
    await request(app.getHttpServer()).post('/api/tokens').send({ name: 'Anonymous', scopes: ['read'] }).expect(401);
    await request(app.getHttpServer()).post('/api/tokens').set('cookie', cookie(admin))
      .set('origin', 'https://evil.example').send({ name: 'Cross-site', scopes: ['write'] }).expect(403);
    expect(tokens.list(admin)).toHaveLength(1);
  });

  it('restricts inventory to owners and admin all-list/revocation, and rejects revoked credentials', async () => {
    const first = await mint(owner, ['read', 'write']);
    const second = await mint(other, ['read']);
    const ownerList = await request(app.getHttpServer()).get('/api/tokens').set('cookie', cookie(owner)).expect(200);
    expect(ownerList.body.tokens.map((item: { id: string }) => item.id)).toEqual([first.id]);
    await request(app.getHttpServer()).get('/api/tokens?all=1').set('cookie', cookie(owner)).expect(403);
    const all = await request(app.getHttpServer()).get('/api/tokens?all=1').set('cookie', cookie(admin)).expect(200);
    expect(all.body.tokens.map((item: { id: string }) => item.id).sort()).toEqual([first.id, second.id].sort());
    await request(app.getHttpServer()).delete(`/api/tokens/${second.id}`).set('cookie', cookie(owner)).set('origin', origin).expect(404);
    await request(app.getHttpServer()).delete(`/api/tokens/${apiIdToLegacyUuid(second.id)}`).set('cookie', cookie(admin)).set('origin', origin).expect(204);
    await request(app.getHttpServer()).get('/policy/read').set('authorization', `Bearer ${second.token}`).expect(401);
    await request(app.getHttpServer()).delete(`/api/tokens/${first.id}`).set('authorization', `Bearer ${first.token}`).expect(204);
    await request(app.getHttpServer()).get('/policy/read').set('authorization', `Bearer ${first.token}`).expect(401);
  });

  it('rejects expired credentials and past mint expiry', async () => {
    const issued = await mint(owner, ['read'], new Date(Date.now() + 60_000).toISOString());
    const future = Date.now() + 120_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(future));
    await request(app.getHttpServer()).get('/policy/read').set('authorization', `Bearer ${issued.token}`).expect(401);
    vi.useRealTimers();
    vi.restoreAllMocks();
    await request(app.getHttpServer()).post('/api/tokens').set('cookie', cookie(owner)).set('origin', origin)
      .send({ name: 'Expired', scopes: ['read'], expiresAt: '2000-01-01T00:00:00.000Z' }).expect(400);
  });
});

describe('cookie CSRF and logout', () => {
  it.each([
    { headers: {}, status: 403 },
    { headers: { origin: 'https://evil.example' }, status: 403 },
    { headers: { origin: 'null' }, status: 403 },
    { headers: { 'sec-fetch-site': 'same-site' }, status: 403 },
    { headers: { origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' }, status: 403 },
    { headers: { origin }, status: 201 },
    { headers: { 'sec-fetch-site': 'same-origin' }, status: 201 },
  ])('applies Origin or Fetch Metadata policy %#', async ({ headers, status }) => {
    for (const [path, user] of [['/policy/chat', owner], ['/policy/admin', admin]] as const) {
      const response = await request(app.getHttpServer()).post(path).set('cookie', cookie(user)).set(headers).expect(status);
      if (status === 403) expect(response.body.error.code).toBe('csrf_rejected');
    }
  });

  it('does not let same-origin proof or write scope grant the administrator role', async () => {
    const viewerToken = await mint(owner, ['write']);
    await request(app.getHttpServer()).post('/policy/admin').set('cookie', cookie(owner)).set('origin', origin).expect(403);
    await request(app.getHttpServer()).post('/policy/admin').set('cookie', cookie(owner)).set('sec-fetch-site', 'same-origin').expect(403);
    await request(app.getHttpServer()).post('/policy/admin').set('authorization', `Bearer ${viewerToken.token}`).expect(403);
    const adminToken = await mint(admin, ['read']);
    const rejected = await request(app.getHttpServer()).post('/policy/admin').set('authorization', `Bearer ${adminToken.token}`).expect(403);
    expect(rejected.body.error.code).toBe('insufficient_scope');
  });

  it('does not permit bearer headers to bypass cookie logout CSRF and keeps denied sessions intact', async () => {
    const session = cookie(owner);
    const issued = await mint(owner, ['write']);
    await request(app.getHttpServer()).post('/auth/logout').set('cookie', session).set('authorization', `Bearer ${issued.token}`)
      .set('origin', 'https://evil.example').expect(403);
    await request(app.getHttpServer()).get('/policy/read').set('cookie', session).expect(200);
    await request(app.getHttpServer()).post('/auth/logout').set('cookie', session).set('origin', origin).expect(204);
    await request(app.getHttpServer()).get('/policy/read').set('cookie', session).expect(401);
    await request(app.getHttpServer()).get('/policy/read').set('cookie', cookie(owner)).set('origin', 'https://evil.example').expect(200);
  });
  it('leaves OAuth registration and revocation exempt from cookie CSRF policy', async () => {
    const registration = await request(app.getHttpServer()).post('/oauth/register').set('cookie', cookie(owner))
      .set('origin', 'https://external-client.example').send({ redirect_uris: ['https://client.example/cb'] }).expect(201);
    await request(app.getHttpServer()).post('/oauth/revoke').set('cookie', cookie(owner))
      .send({ client_id: registration.body.client_id, token: 'unknown' }).expect(200);
  });

});

describe('auth lifecycle cleanup', () => {
  it('sweeps expired/revoked artifacts periodically and stops the timer on destruction', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T12:00:00.000Z'));
    const expired = '2026-10-07T11:00:00.000Z';
    const future = '2026-10-07T13:00:00.000Z';
    const clientId = app.get(OAuthService).register({ redirect_uris: ['https://client.example/cb'], client_name: 'Client' }).client_id;
    for (const [key, expires] of [['expired', expired], ['live', future]]) {
      db.prepare('INSERT INTO web_sessions VALUES (?,?,?)').run(key, owner.id, expires);
      db.prepare('INSERT INTO auth_pending VALUES (?,?,?,?,?,?)').run(key, 'nonce', 'verifier', '{}', expires, 'browser');
      db.prepare('INSERT INTO oauth_codes VALUES (?,?,?,?,?,?,?)').run(key, clientId, owner.id, 'https://client.example/cb', 'challenge', `${origin}/mcp`, expires);
    }
    for (const table of ['oauth_access_tokens', 'oauth_refresh_tokens']) {
      for (const [key, expires, revoked] of [['expired', expired, 0], ['revoked', future, 1], ['live', future, 0]] as const) {
        db.prepare(`INSERT INTO ${table} VALUES (?,?,?,?,?,?,?)`).run(key, clientId, owner.id, key, `${origin}/mcp`, expires, revoked);
      }
    }
    const dead = tokens.create(owner, { name: 'Dead', scopes: ['read'] });
    tokens.revoke(owner, dead.id);
    const expiring = tokens.create(owner, { name: 'Expiring', scopes: ['read'], expiresAt: '2026-10-07T12:00:00.500Z' });
    const live = tokens.create(owner, { name: 'Live', scopes: ['read'] });
    cleanup.onModuleInit();
    for (const table of ['web_sessions', 'auth_pending', 'oauth_codes', 'oauth_access_tokens', 'oauth_refresh_tokens']) {
      const keyColumn = table === 'web_sessions' ? 'id_hash' : table === 'auth_pending' ? 'state_hash' : table === 'oauth_codes' ? 'code_hash' : 'token_hash';
      expect(db.prepare(`SELECT ${keyColumn} AS key FROM ${table}`).all()).toEqual([{ key: 'live' }]);
    }
    expect(tokens.list(owner).map((item) => item.id).sort()).toEqual([expiring.id, live.id].sort());
    vi.advanceTimersByTime(1000);
    expect(tokens.list(owner).map((item) => item.id)).toEqual([live.id]);
    cleanup.onModuleDestroy();
    db.prepare('INSERT INTO web_sessions VALUES (?,?,?)').run('after-stop', owner.id, expired);
    vi.advanceTimersByTime(1000);
    expect(db.prepare('SELECT id_hash FROM web_sessions WHERE id_hash = ?').get('after-stop')).toEqual({ id_hash: 'after-stop' });
  });

  it('retains rotated refresh revocation handles while a family lives and preserves client metadata', async () => {
    const oauth = app.get(OAuthService);
    const repository = app.get(OAuthRepository);
    const clientId = oauth.register({ redirect_uris: ['https://client.example/cb'], client_name: 'Desktop' }).client_id;
    const expiry = new Date(Date.now() + 60_000).toISOString();
    // Fixed SHA-256 of "hello" is independent of the token implementation.
    const helloHash = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
    repository.insertTokens({ token_hash: helloHash, client_id: clientId, user_id: owner.id, family_id: 'family', resource: `${origin}/mcp`, expires_at: expiry },
      { token_hash: helloHash, client_id: clientId, user_id: owner.id, family_id: 'family', resource: `${origin}/mcp`, expires_at: expiry });
    const next = await oauth.token({ grant_type: 'refresh_token', client_id: clientId, refresh_token: 'hello' });
    cleanup.cleanup();
    expect((await oauth.verifyAccessToken(next.access_token)).extra).toMatchObject({ userId: owner.id, clientName: 'Desktop' });
    await request(app.getHttpServer()).get('/policy/read').set('authorization', `Bearer ${next.access_token}`)
      .set('cookie', cookie(admin)).expect(401);
    await oauth.revoke({ client_id: clientId, token: 'hello' });
    await expect(oauth.verifyAccessToken(next.access_token)).rejects.toThrow();
    cleanup.cleanup();
    expect(db.prepare('SELECT token_hash FROM oauth_refresh_tokens').all()).toEqual([]);
  });
});

it('audits CLI user creation and role success/failure without losing the original error', async () => {
  const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const program = new Command().exitOverride();
  registerAuthCommands(program, async () => app);
  await program.parseAsync(['node', 'test', 'user', 'add', 'cli@example.com', '--role', 'editor']);
  await program.parseAsync(['node', 'test', 'user', 'role', 'cli@example.com', 'viewer']);
  await expect(program.parseAsync(['node', 'test', 'user', 'role', 'missing@example.com', 'viewer'])).rejects.toMatchObject({ code: 'not_found' });
  const events = app.get(AuditService).list({ limit: 100 }).events;
  expect(events.map(({ actorId, action, target, outcome }) => ({ actorId, action, target, outcome }))).toEqual([
    { actorId: null, action: 'user.role', target: 'missing@example.com', outcome: 'error' },
    { actorId: null, action: 'user.role', target: 'cli@example.com', outcome: 'success' },
    { actorId: null, action: 'user.create', target: 'cli@example.com', outcome: 'success' },
  ]);
  consoleSpy.mockRestore();
});
