import 'reflect-metadata';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ApiTokensController } from '../auth/api-tokens.controller.js';
import { ApiTokensRepository } from '../auth/api-tokens.repository.js';
import { ApiTokensService } from '../auth/api-tokens.service.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { SessionOnlyGuard } from '../auth/guards/session-only.guard.js';
import { SessionsService } from '../auth/sessions.service.js';
import { UsersRepository } from '../auth/users.repository.js';
import { UsersService } from '../auth/users.service.js';
import type { User } from '../auth/users.types.js';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter.js';
import { configureApp } from '../common/http/configure-app.js';
import { CONFIG, DB, LOGGER } from '../common/tokens.js';
import { loadConfig } from '../config.js';
import { openDb, runMigrations, type Db } from '../db/index.js';
import { AdminController } from './admin.controller.js';
import { MeController } from './me.controller.js';

const origin = 'https://wiki.example.com';
const initialPassword = 'initial-password';
const changedPassword = 'changed-password';
let database: Db;

@Global()
@Module({
  providers: [
    { provide: DB, useFactory: () => database },
    { provide: CONFIG, useValue: loadConfig({ NODE_ENV: 'test', PUBLIC_URL: origin, SESSION_SECRET: 'password-api-test' }) },
    { provide: LOGGER, useValue: { error() {} } },
  ],
  exports: [DB, CONFIG, LOGGER],
})
class PasswordApiInfrastructure {}

@Module({
  controllers: [ApiTokensController],
  providers: [UsersRepository, UsersService, SessionsService, ApiTokensRepository, ApiTokensService,
    SessionGuard, SessionOnlyGuard, RolesGuard],
  exports: [UsersService, SessionsService, ApiTokensService, SessionGuard, SessionOnlyGuard, RolesGuard],
})
class PasswordApiAuth {}

interface AuditEvent {
  actorId: number | null;
  action: string;
  target: string;
  outcome: string;
  summary: string;
}

describe('password management REST API', () => {
  let app: INestApplication;
  let users: UsersService;
  let sessions: SessionsService;
  let owner: User;
  let admin: User;
  let other: User;
  let adminCookie: string;

  function cookie(user: User): string {
    let value = '';
    sessions.create({ cookie(name: string, secret: string) { value = `${name}=${secret}`; } } as Response, user);
    return value;
  }

  function change(session: string, body: { currentPassword?: string; newPassword?: string }) {
    return request(app.getHttpServer()).post('/api/me/password').set('cookie', session).set('origin', origin).send(body);
  }

  function setPassword(id: number, password: string) {
    return request(app.getHttpServer()).put(`/api/admin/users/${id}/password`)
      .set('cookie', adminCookie).set('origin', origin).send({ password });
  }

  function clearPassword(id: number) {
    return request(app.getHttpServer()).delete(`/api/admin/users/${id}/password`)
      .set('cookie', adminCookie).set('origin', origin);
  }

  function me(session: string) {
    return request(app.getHttpServer()).get('/api/me').set('cookie', session);
  }

  async function passwordEvents(): Promise<AuditEvent[]> {
    const response = await request(app.getHttpServer()).get('/api/admin/audit').set('cookie', adminCookie).expect(200);
    const events: AuditEvent[] = response.body.events;
    return events.filter((event) => event.action.startsWith('user.password.')).reverse();
  }

  function expectSafeUser(user: User, hasPassword: boolean): void {
    expect(user).toMatchObject({ hasPassword });
    expect(user).not.toHaveProperty('password');
    expect(user).not.toHaveProperty('passwordHash');
    expect(user).not.toHaveProperty('password_hash');
    expect(JSON.stringify(user)).not.toContain('scrypt$');
    expect(JSON.stringify(user)).not.toContain(initialPassword);
    expect(JSON.stringify(user)).not.toContain(changedPassword);
  }

  beforeEach(async () => {
    database = openDb(':memory:');
    runMigrations(database);
    const module = await Test.createTestingModule({
      imports: [PasswordApiInfrastructure, AuditModule, AuthModule],
      controllers: [MeController, AdminController],
    }).overrideModule(AuthModule).useModule(PasswordApiAuth).compile();
    app = module.createNestApplication({ logger: false });
    configureApp(app);
    app.useGlobalFilters(new HttpExceptionFilter({ error() {} } as never));
    await app.init();
    users = app.get(UsersService);
    sessions = app.get(SessionsService);
    owner = await users.create({ email: 'owner@example.com', role: 'viewer' });
    admin = await users.create({ email: 'admin@example.com', role: 'admin' });
    other = await users.create({ email: 'other@example.com', role: 'viewer' });
    adminCookie = cookie(admin);
  });

  afterEach(async () => {
    await app?.close();
    if (database?.open) database.close();
  });

  it('creates users with optional passwords and returns only password presence in user DTOs', async () => {
    for (const [email, password] of [['plain@example.com', undefined], ['password@example.com', initialPassword]] as const) {
      const response = await request(app.getHttpServer()).post('/api/admin/users')
        .set('cookie', adminCookie).set('origin', origin).send({ email, role: 'viewer', password }).expect(201);
      expectSafeUser(response.body.user, password !== undefined);
      const self = await me(cookie(response.body.user)).expect(200);
      expectSafeUser(self.body.user, password !== undefined);
    }
    const listed = await request(app.getHttpServer()).get('/api/admin/users').set('cookie', adminCookie).expect(200);
    for (const user of listed.body.users as User[]) expectSafeUser(user, user.email === 'password@example.com');
    const weak = await request(app.getHttpServer()).post('/api/admin/users').set('cookie', adminCookie).set('origin', origin)
      .send({ email: 'weak@example.com', role: 'viewer', password: 'short' }).expect(400);
    expect(weak.body.error.code).toBe('weak_password');
    const after = await request(app.getHttpServer()).get('/api/admin/users').set('cookie', adminCookie).expect(200);
    expect(after.body.users).not.toContainEqual(expect.objectContaining({ email: 'weak@example.com' }));
  });

  it('sets an initial password without a current password, keeps this session, and revokes other sessions', async () => {
    const current = cookie(owner);
    const secondary = cookie(owner);
    const unrelated = cookie(other);
    await change(current, { newPassword: initialPassword }).expect(204, '');
    const response = await me(current).expect(200);
    expectSafeUser(response.body.user, true);
    await me(secondary).expect(401);
    await me(unrelated).expect(200);
    expect(await passwordEvents()).toEqual([expect.objectContaining({
      actorId: owner.id, action: 'user.password.change', target: `user:${owner.id}`, outcome: 'success',
      summary: 'POST /api/me/password: HTTP 204',
    })]);
  });

  it('requires the current password once set and returns 400 rather than 401 without invalidating sessions on failure', async () => {
    await users.setPassword(owner.id, initialPassword);
    const current = cookie(owner);
    const secondary = cookie(owner);
    for (const body of [{ newPassword: changedPassword }, { currentPassword: 'wrong-password', newPassword: changedPassword }]) {
      const response = await change(current, body).expect(400);
      expect(response.body.error.code).toBe('invalid_current_password');
      await me(current).expect(200);
      await me(secondary).expect(200);
    }
    await change(current, { currentPassword: initialPassword, newPassword: changedPassword }).expect(204, '');
    await me(current).expect(200);
    await me(secondary).expect(401);
    await change(current, { currentPassword: changedPassword, newPassword: initialPassword }).expect(204, '');
    expect((await passwordEvents()).map(({ outcome }) => outcome)).toEqual(['failure', 'failure', 'success', 'success']);
  });

  it('rejects weak self-service passwords without clearing the old password or revoking sessions', async () => {
    await users.setPassword(owner.id, initialPassword);
    const current = cookie(owner);
    const secondary = cookie(owner);
    const response = await change(current, { currentPassword: initialPassword, newPassword: 'short' }).expect(400);
    expect(response.body.error.code).toBe('weak_password');
    await me(secondary).expect(200);
    await change(current, { currentPassword: initialPassword, newPassword: changedPassword }).expect(204);
  });

  it('accepts only one concurrent initial password setting and preserves its current session', async () => {
    const current = cookie(owner);
    const secondary = cookie(owner);
    const candidates = [initialPassword, changedPassword];
    const responses = await Promise.all(candidates.map((newPassword) => change(current, { newPassword })));
    expect(responses.map(({ status }) => status).sort()).toEqual([204, 400]);
    const rejected = responses.find(({ status }) => status === 400);
    expect(rejected?.body.error.code).toBe('invalid_current_password');
    await me(current).expect(200);
    await me(secondary).expect(401);
    const winner = candidates[responses.findIndex(({ status }) => status === 204)];
    await change(current, { currentPassword: winner, newPassword: 'after-concurrent-change' }).expect(204);
  });

  it('allows admins to set and clear passwords and revokes every target session but no other user session', async () => {
    const first = cookie(owner);
    const second = cookie(owner);
    const unrelated = cookie(other);
    await setPassword(owner.id, initialPassword).expect(204, '');
    await me(first).expect(401);
    await me(second).expect(401);
    await me(unrelated).expect(200);
    const listed = await request(app.getHttpServer()).get('/api/admin/users').set('cookie', adminCookie).expect(200);
    expectSafeUser(listed.body.users.find((user: User) => user.id === owner.id), true);
    const afterSet = cookie(owner);
    await change(afterSet, { currentPassword: initialPassword, newPassword: changedPassword }).expect(204);
    const afterChange = cookie(owner);
    await clearPassword(owner.id).expect(204, '');
    await me(afterSet).expect(401);
    await me(afterChange).expect(401);
    await me(unrelated).expect(200);
    const afterClear = cookie(owner);
    expectSafeUser((await me(afterClear).expect(200)).body.user, false);
    await change(afterClear, { newPassword: initialPassword }).expect(204);
    const events = await passwordEvents();
    expect(events.map(({ action }) => action)).toEqual([
      'user.password.set', 'user.password.change', 'user.password.clear', 'user.password.change',
    ]);
    expect(events.filter(({ actorId }) => actorId === admin.id).map(({ target, outcome }) => ({ target, outcome }))).toEqual([
      { target: `user:${owner.id}`, outcome: 'success' }, { target: `user:${owner.id}`, outcome: 'success' },
    ]);
  });

  it('revokes the admin current session too when resetting their own password', async () => {
    const secondary = cookie(admin);
    await setPassword(admin.id, initialPassword).expect(204, '');
    await me(adminCookie).expect(401);
    await me(secondary).expect(401);
  });

  it('returns 404 for unknown targets and 400 for weak admin passwords without session revocation', async () => {
    const current = cookie(owner);
    expect((await setPassword(999999, initialPassword).expect(404)).body.error.code).toBe('not_found');
    expect((await clearPassword(999999).expect(404)).body.error.code).toBe('not_found');
    expect((await setPassword(owner.id, 'short').expect(400)).body.error.code).toBe('weak_password');
    expectSafeUser((await me(current).expect(200)).body.user, false);
    expect((await passwordEvents()).map(({ action, outcome }) => ({ action, outcome }))).toEqual([
      { action: 'user.password.set', outcome: 'failure' },
      { action: 'user.password.clear', outcome: 'failure' },
      { action: 'user.password.set', outcome: 'failure' },
    ]);
  });

  it('requires a cookie session for self-service changes even with a valid write REST token and cookie', async () => {
    const current = cookie(owner);
    const issued = await request(app.getHttpServer()).post('/api/tokens').set('cookie', current).set('origin', origin)
      .send({ name: 'Automation', scopes: ['read', 'write'] }).expect(201);
    for (const session of [undefined, current]) {
      const call = request(app.getHttpServer()).post('/api/me/password')
        .set('authorization', `Bearer ${issued.body.token}`).set('origin', origin);
      if (session) call.set('cookie', session);
      const response = await call.send({ newPassword: initialPassword }).expect(403);
      expect(response.body.error.code).toBe('session_required');
    }
    expectSafeUser((await me(current).expect(200)).body.user, false);
    expect((await passwordEvents()).map(({ outcome }) => outcome)).toEqual(['failure', 'failure']);
  });

  it('audits authentication, authorization, CSRF, and validation failures once without retaining secrets', async () => {
    const secret = 'never-retain-this-password';
    await request(app.getHttpServer()).post('/api/me/password').set('origin', origin).send({ newPassword: secret }).expect(401);
    await request(app.getHttpServer()).put(`/api/admin/users/${owner.id}/password`)
      .set('cookie', cookie(owner)).set('origin', origin).send({ password: secret }).expect(403);
    await request(app.getHttpServer()).post('/api/me/password').set('cookie', cookie(owner))
      .set('origin', 'https://attacker.example').send({ newPassword: secret }).expect(403);
    await change(cookie(owner), { currentPassword: secret }).expect(400);
    await request(app.getHttpServer()).put(`/api/admin/users/${owner.id}/password`)
      .set('cookie', adminCookie).set('origin', origin).send({ password: 42 }).expect(400);
    const events = await passwordEvents();
    expect(events.map(({ outcome, summary }) => ({ outcome, summary }))).toEqual([
      { outcome: 'failure', summary: 'POST /api/me/password: HTTP 401' },
      { outcome: 'failure', summary: `PUT /api/admin/users/${owner.id}/password: HTTP 403` },
      { outcome: 'failure', summary: 'POST /api/me/password: HTTP 403' },
      { outcome: 'failure', summary: 'POST /api/me/password: HTTP 400' },
      { outcome: 'failure', summary: `PUT /api/admin/users/${owner.id}/password: HTTP 400` },
    ]);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain('scrypt$');
  });
});
