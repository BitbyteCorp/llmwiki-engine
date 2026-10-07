import 'reflect-metadata';
import { Body, Controller, Delete, Global, Module, Param, Patch, Post, Put, UseGuards, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AuthModule } from '../auth/auth.module.js';
import { ApiTokensService } from '../auth/api-tokens.service.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { SessionsService } from '../auth/sessions.service.js';
import { UsersRepository } from '../auth/users.repository.js';
import { UsersService } from '../auth/users.service.js';
import { configureApp } from '../common/http/configure-app.js';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter.js';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { CONFIG, DB, LOGGER } from '../common/tokens.js';
import { loadConfig } from '../config.js';
import { openDb, runMigrations, type Db } from '../db/index.js';
import { createUserSchema, settingsSchema, updateUserSchema, userIdSchema } from '../api/api.dto.js';
import { AuditModule } from './audit.module.js';
import { AuditService } from './audit.service.js';

let database: Db;

@Global()
@Module({
  providers: [
    { provide: DB, useFactory: () => database },
    { provide: CONFIG, useValue: loadConfig({ NODE_ENV: 'test' }) },
    { provide: LOGGER, useValue: { error() {} } },
  ], exports: [DB, CONFIG, LOGGER],
})
class AuditTestInfrastructure {}

@Module({
  providers: [
    UsersRepository, UsersService, SessionGuard, RolesGuard,
    { provide: SessionsService, inject: [UsersService], useFactory: (users: UsersService) => ({
      sessionUser(req: Request) { return users.getById(Number(req.get('x-user'))); },
      assertSameOrigin() {},
    }) },
    { provide: ApiTokensService, useValue: { authenticate() { throw new Error('Bearer not used by this test'); } } },
  ], exports: [UsersService, SessionsService, ApiTokensService, SessionGuard, RolesGuard],
})
class AuditTestAuth {}

@Controller('api/admin')
@UseGuards(SessionGuard, RolesGuard)
@Roles('admin')
class AuditedMutations {
  constructor(private readonly users: UsersService) {}

  @Post('users')
  create(@Body(new ZodValidationPipe(createUserSchema)) input: z.infer<typeof createUserSchema>) { return this.users.create(input); }

  @Patch('users/:id')
  update(@Param('id', new ZodValidationPipe(userIdSchema)) id: number, @Body(new ZodValidationPipe(updateUserSchema)) input: z.infer<typeof updateUserSchema>) { return this.users.update(id, input); }

  @Delete('users/:id')
  delete(@Param('id', new ZodValidationPipe(userIdSchema)) id: number) { this.users.delete(id); }

  @Put('settings')
  settings(@Body(new ZodValidationPipe(settingsSchema)) input: z.infer<typeof settingsSchema>) { return this.users.setSettings(input); }
}

describe('admin audit history', () => {
  let app: INestApplication;
  let audit: AuditService;
  let adminId: number;
  let viewerId: number;

  beforeEach(async () => {
    database = openDb(':memory:');
    runMigrations(database);
    const module = await Test.createTestingModule({ imports: [AuditTestInfrastructure, AuditModule, AuthModule], controllers: [AuditedMutations] })
      .overrideModule(AuthModule).useModule(AuditTestAuth).compile();
    const users = module.get(UsersService);
    adminId = users.create({ email: 'admin@example.com', role: 'admin' }).id;
    viewerId = users.create({ email: 'viewer@example.com', role: 'viewer' }).id;
    audit = module.get(AuditService);
    app = module.createNestApplication({ logger: false });
    configureApp(app);
    app.useGlobalFilters(new HttpExceptionFilter({ error() {} } as never));
    await app.init();
  });

  afterEach(async () => { await app?.close(); if (database?.open) database.close(); });

  it('enforces admin role and validates query bounds', async () => {
    const server = app.getHttpServer();
    await request(server).get('/api/admin/audit').expect(401);
    await request(server).get('/api/admin/audit').set('x-user', String(viewerId)).expect(403);
    for (const query of ['limit=0', 'limit=201', 'before=invalid', 'actor=-1']) {
      await request(server).get(`/api/admin/audit?${query}`).set('x-user', String(adminId)).expect(400);
    }
  });

  it('paginates filtered immutable events by exclusive ID even with concurrent appends', async () => {
    for (const target of ['first', 'second', 'third']) audit.record({ actorId: adminId, action: 'user.role', target, outcome: 'success' });
    audit.record({ actorId: viewerId, action: 'user.role', target: 'other actor', outcome: 'failure' });
    audit.record({ actorId: adminId, action: 'settings.update', target: 'other action', outcome: 'success' });
    const query = `actor=${adminId}&action=user.role&limit=2`;
    const first = await request(app.getHttpServer()).get(`/api/admin/audit?${query}`).set('x-user', String(adminId)).expect(200);
    expect(first.body.events.map((event: { target: string }) => event.target)).toEqual(['third', 'second']);
    expect(first.body.nextCursor).toBe(String(first.body.events[1].id));
    expect(first.body.events[0]).toMatchObject({ actorId: adminId, action: 'user.role', outcome: 'success', summary: null });
    audit.record({ actorId: adminId, action: 'user.role', target: 'appended', outcome: 'success' });
    const second = await request(app.getHttpServer()).get(`/api/admin/audit?${query}&before=${first.body.nextCursor}`).set('x-user', String(adminId)).expect(200);
    expect(second.body.events.map((event: { target: string }) => event.target)).toEqual(['first']);
    expect(second.body.nextCursor).toBeNull();
  });

  it('records actual role/settings/user mutations and failures without duplicating interceptor/finish events', async () => {
    const server = app.getHttpServer();
    await request(server).patch(`/api/admin/users/${viewerId}`).set('x-user', String(adminId)).send({ role: 'editor' }).expect(200);
    await request(server).patch(`/api/admin/users/${adminId}`).set('x-user', String(adminId)).send({ role: 'viewer' }).expect(409);
    await request(server).put('/API/ADMIN/SETTINGS/').set('x-user', String(adminId)).send({ allowlistEnabled: false }).expect(200);
    await request(server).post('/api/admin/users').set('x-user', String(adminId)).send({ email: 'new@example.com', role: 'viewer' }).expect(201);
    await request(server).delete(`/api/admin/users/${viewerId}`).set('x-user', String(adminId)).expect(200);
    const events = audit.list({ limit: 50 }).events.reverse();
    expect(events.map(({ action, outcome, actorId }) => ({ action, outcome, actorId }))).toEqual([
      { action: 'user.role', outcome: 'success', actorId: adminId },
      { action: 'user.role', outcome: 'failure', actorId: adminId },
      { action: 'settings.update', outcome: 'success', actorId: adminId },
      { action: 'user.create', outcome: 'success', actorId: adminId },
      { action: 'user.delete', outcome: 'success', actorId: adminId },
    ]);
    expect(events[1]?.summary).toContain('HTTP 409');
    expect(events[0]?.target).toBe(`user:${viewerId}`);
  });

  it('preserves historical actor identity after the user is removed', async () => {
    audit.record({ actorId: viewerId, action: 'knowledge.export', target: 'main', outcome: 'success' });
    await request(app.getHttpServer()).delete(`/api/admin/users/${viewerId}`).set('x-user', String(adminId)).expect(200);
    const response = await request(app.getHttpServer()).get(`/api/admin/audit?actor=${viewerId}`).set('x-user', String(adminId)).expect(200);
    expect(response.body.events).toEqual([expect.objectContaining({
      actorId: viewerId, action: 'knowledge.export', target: 'main', outcome: 'success',
    })]);
  });

  it('captures rejected guard and validation attempts without retaining secret body data', async () => {
    const server = app.getHttpServer();
    await request(server).put('/api/admin/settings').send({ secret: 'never record me' }).expect(401);
    await request(server).patch(`/api/admin/users/${adminId}`).set('x-user', String(viewerId)).send({ role: 'viewer' }).expect(403);
    await request(server).post('/api/admin/users').set('x-user', String(adminId)).send({ email: 'bad', role: 'unknown', secret: 'never record me' }).expect(400);
    const events = audit.list({ limit: 50 }).events.reverse();
    expect(events.map(({ actorId, outcome, summary }) => ({ actorId, outcome, summary }))).toEqual([
      { actorId: null, outcome: 'failure', summary: 'PUT /api/admin/settings: HTTP 401' },
      { actorId: viewerId, outcome: 'failure', summary: `PATCH /api/admin/users/${adminId}: HTTP 403` },
      { actorId: adminId, outcome: 'failure', summary: 'POST /api/admin/users: HTTP 400' },
    ]);
    expect(JSON.stringify(events)).not.toContain('never record me');
  });
});
