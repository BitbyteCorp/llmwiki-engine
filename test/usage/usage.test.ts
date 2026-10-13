import 'reflect-metadata';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../../src/audit/audit.service.js';
import { SessionsService } from '../../src/auth/sessions.service.js';
import { UsersService } from '../../src/auth/users.service.js';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter.js';
import { CONFIG, DB, LOGGER } from '../../src/common/tokens.js';
import { loadConfig } from '../../src/config.js';
import { openDb, runMigrations, type Db } from '../../src/db/index.js';
import { UsageModule } from '../../src/usage/usage.module.js';
import { UsageRepository } from '../../src/usage/usage.repository.js';
import { UsageService } from '../../src/usage/usage.service.js';

@Global()
@Module({})
class UsageTestDependencies {}

const now = new Date('2026-10-08T12:00:00.000Z');
const counts = { inputTokens: 10, cachedInputTokens: 6, outputTokens: 4, reasoningTokens: 2 };

describe('usage ledger admin HTTP boundary', () => {
  let app: INestApplication;
  let db: Db;
  let repository: UsageRepository;

  beforeEach(async () => {
    vi.setSystemTime(now);
    db = openDb(':memory:');
    runMigrations(db);
    const config = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'usage-test-secret' });
    const log = pino({ level: 'silent' });
    const module = await Test.createTestingModule({
      imports: [{ module: UsageTestDependencies,
        providers: [{ provide: DB, useValue: db }, { provide: CONFIG, useValue: config },
          { provide: LOGGER, useValue: log }, AuditService],
        exports: [DB, CONFIG, LOGGER, AuditService] }, UsageModule],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalFilters(new HttpExceptionFilter(log));
    await app.init();
    repository = app.get(UsageRepository);
  });

  afterEach(async () => {
    await app?.close();
    if (db?.open) db.close();
    vi.useRealTimers();
  });

  async function cookie(role: 'admin' | 'viewer'): Promise<string> {
    const user = await app.get(UsersService).create({ email: `${role}@example.com`, role });
    let cookie = '';
    app.get(SessionsService).create({ cookie: (name: string, value: string) => {
      cookie = `${name}=${encodeURIComponent(value)}`;
    } } as Response, user);
    return cookie;
  }

  it('rejects anonymous and viewer requests while allowing administrators without caching', async () => {
    await request(app.getHttpServer()).get('/api/admin/usage').expect(401);
    await request(app.getHttpServer()).get('/api/admin/usage').set('Cookie', await cookie('viewer')).expect(403);
    const response = await request(app.getHttpServer()).get('/api/admin/usage').set('Cookie', await cookie('admin')).expect(200);
    expect(response.body).toEqual({ days: 30, rows: [] });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('groups actual calls by UTC day, lane and model and includes the entire current day', async () => {
    const entries = [
      ['2026-10-06T23:59:59.999Z', 'chat', 'model-a'],
      ['2026-10-07T00:00:00.000Z', 'chat', 'model-a'],
      ['2026-10-07T23:59:59.999Z', 'chat', 'model-a'],
      ['2026-10-08T00:00:00.000Z', 'chat', 'model-a'],
      ['2026-10-08T00:30:00.000Z', 'write', 'model-a'],
      ['2026-10-08T01:00:00.000Z', 'chat', 'model-b'],
    ];
    for (const [at, lane, model] of entries) repository.record({ lane: lane!, model: model!, ...counts,
      owner: 'user:42', ref: 'job:opaque-api-id' }, new Date(at!));
    const admin = await cookie('admin');
    const response = await request(app.getHttpServer()).get('/api/admin/usage?days=2').set('Cookie', admin).expect(200);
    expect(response.body).toEqual({ days: 2, rows: [
      { day: '2026-10-08', lane: 'chat', model: 'model-a', calls: 1, ...counts },
      { day: '2026-10-08', lane: 'chat', model: 'model-b', calls: 1, ...counts },
      { day: '2026-10-08', lane: 'write', model: 'model-a', calls: 1, ...counts },
      { day: '2026-10-07', lane: 'chat', model: 'model-a', calls: 2,
        inputTokens: 20, cachedInputTokens: 12, outputTokens: 8, reasoningTokens: 4 },
    ] });
    const oneDay = await request(app.getHttpServer()).get('/api/admin/usage?days=1').set('Cookie', admin).expect(200);
    expect(oneDay.body.rows).toEqual(response.body.rows.slice(0, 3));
  });

  it('accepts the 90-day bound and rejects invalid window sizes', async () => {
    const admin = await cookie('admin');
    await request(app.getHttpServer()).get('/api/admin/usage?days=90').set('Cookie', admin).expect(200, { days: 90, rows: [] });
    for (const days of ['0', '91', '1.5', 'nope', '']) {
      await request(app.getHttpServer()).get(`/api/admin/usage?days=${days}`).set('Cookie', admin).expect(400);
    }
  });

  it('prunes only records older than 90 days on insert and preserves opaque references', () => {
    repository.record({ lane: 'chat', model: 'old', ...counts }, new Date('2026-07-10T11:59:59.999Z'));
    repository.record({ lane: 'chat', model: 'boundary', ...counts }, new Date('2026-07-10T12:00:00.000Z'));
    app.get(UsageService).record({ lane: 'chat', model: 'current', owner: 'user:42', ref: 'job:opaque-api-id',
      inputTokens: 2, outputTokens: 1, reasoningTokens: 0 });
    // Physical retention is a persistence invariant, not just a reporting filter.
    expect(db.prepare('SELECT model,owner,ref,cached_input FROM llm_usage ORDER BY at').all()).toEqual([
      { model: 'boundary', owner: null, ref: null, cached_input: 6 },
      { model: 'current', owner: 'user:42', ref: 'job:opaque-api-id', cached_input: 0 },
    ]);
  });
});
