import 'reflect-metadata';
import { Controller, Get, Global, Injectable, Module, Post, Put, Delete, UseGuards, type CanActivate, type ExecutionContext, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../config.js';
import { HttpExceptionFilter } from '../filters/http-exception.filter.js';
import { CONFIG } from '../tokens.js';
import { configureApp } from './configure-app.js';
import { HttpRateLimitModule } from './rate-limit.module.js';

@Global()
@Module({ providers: [{ provide: CONFIG, useValue: { ...loadConfig({ NODE_ENV: 'test' }), rateLimitAuth: 2, rateLimitUser: 2, rateLimitWindowMs: 60_000 } }], exports: [CONFIG] })
class LimitsConfigModule {}

@Injectable()
class ResolveUserGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    req.user = { id: Number(req.get('x-user') ?? 1), role: 'editor', email: 'user@example.com', name: null, createdAt: '', lastLoginAt: null };
    return true;
  }
}

@Controller()
class RateSurface {
  @Post(['oauth/token', 'oauth/register'])
  auth() { return { accepted: true }; }

  @Get('auth/google/login')
  login() { return { accepted: true }; }

  @Get(['api/search', 'api/search/suggest'])
  @UseGuards(ResolveUserGuard)
  search() { return { accepted: true }; }

  @Post(['api/conversations/chat/messages', 'api/conversations/chat/messages/message/retry', 'api/imports', 'api/notes/move', 'api/history/revert', 'api/uploads/upload/save', 'mcp'])
  @UseGuards(ResolveUserGuard)
  mutation() { return { accepted: true }; }

  @Put('api/notes')
  @UseGuards(ResolveUserGuard)
  put() { return { accepted: true }; }

  @Delete('api/notes')
  @UseGuards(ResolveUserGuard)
  delete() { return { accepted: true }; }
}

describe('shared HTTP rate budgets', () => {
  let app: INestApplication;
  let now: number;

  beforeEach(async () => {
    now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const module = await Test.createTestingModule({ imports: [LimitsConfigModule, HttpRateLimitModule], controllers: [RateSurface], providers: [ResolveUserGuard] }).compile();
    app = module.createNestApplication({ logger: false });
    configureApp(app);
    app.useGlobalFilters(new HttpExceptionFilter({ error() {} } as never));
    await app.init();
  });

  afterEach(async () => { await app?.close(); vi.restoreAllMocks(); });

  it('shares auth IP budget across login/DCR/token and ignores spoofed forwarding by default', async () => {
    const server = app.getHttpServer();
    await request(server).get('/auth/google/login').set('X-Forwarded-For', '203.0.113.1').expect(200);
    await request(server).post('/oauth/register').set('X-Forwarded-For', '203.0.113.2').expect(201);
    const denied = await request(server).post('/oauth/token').set('X-Forwarded-For', '203.0.113.3').expect(429);
    expect(denied.headers['retry-after']).toBe('60');
    expect(denied.body).toEqual({ error: { code: 'rate_limited', message: 'Too many requests' } });
    now += 1_000;
    const repeated = await request(server).post('/oauth/token').expect(429);
    expect(repeated.headers['retry-after']).toBe('59');
    now += 59_000;
    await request(server).post('/oauth/token').expect(201);
  });

  it('honors forwarding only when explicitly configured', async () => {
    configureApp(app, { trustProxy: true });
    const server = app.getHttpServer();
    await request(server).post('/oauth/token').set('X-Forwarded-For', '203.0.113.1').expect(201);
    await request(server).post('/oauth/token').set('X-Forwarded-For', '203.0.113.1').expect(201);
    await request(server).post('/oauth/token').set('X-Forwarded-For', '203.0.113.1').expect(429);
    await request(server).post('/oauth/token').set('X-Forwarded-For', '203.0.113.2').expect(201);
  });

  it('uses resolved user identity across search/chat/import rather than the client IP', async () => {
    const server = app.getHttpServer();
    await request(server).get('/api/search').set('x-user', '1').expect(200);
    await request(server).post('/api/conversations/chat/messages').set('x-user', '1').expect(201);
    const denied = await request(server).post('/api/imports').set('x-user', '1').expect(429);
    expect(denied.headers['retry-after']).toBe('60');
    await request(server).post('/api/imports').set('x-user', '2').expect(201);
  });

  it('does not allow case-insensitive Express routes to bypass either budget', async () => {
    const server = app.getHttpServer();
    await request(server).post('/oauth/token').expect(201);
    await request(server).post('/oauth/token').expect(201);
    await request(server).post('/OAUTH/TOKEN/').expect(429);
    await request(server).get('/api/search').expect(200);
    await request(server).get('/api/search').expect(200);
    await request(server).get('/API/SEARCH/').expect(429);
  });

  it.each([
    ['put', '/api/notes'], ['delete', '/api/notes'], ['post', '/api/notes/move'],
    ['post', '/api/history/revert'], ['post', '/api/uploads/upload/save'],
    ['post', '/api/conversations/chat/messages/message/retry'], ['get', '/api/search/suggest'],
  ] as const)('includes %s %s in the shared mutation/search budget', async (method, path) => {
    const server = app.getHttpServer();
    await request(server).get('/api/search').expect(200);
    await request(server).get('/api/search').expect(200);
    await request(server)[method](path).expect(429);
  });

  it('throttles selected MCP calls but not tool listing or note reads', async () => {
    const server = app.getHttpServer();
    await request(server).post('/mcp').send({ method: 'tools/call', params: { name: 'search' } }).expect(201);
    await request(server).post('/mcp').send({ method: 'tools/call', params: { name: 'write' } }).expect(201);
    await request(server).post('/mcp').send({ method: 'tools/list' }).expect(201);
    await request(server).post('/mcp').send({ method: 'tools/call', params: { name: 'read_note' } }).expect(201);
    await request(server).post('/mcp').send({ method: 'tools/call', params: { name: 'ingest_source' } }).expect(429);
  });
});
