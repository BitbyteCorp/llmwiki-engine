import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionsService } from '../auth/sessions.service.js';
import { UsersRepository } from '../auth/users.repository.js';
import { UsersService } from '../auth/users.service.js';
import { HealthController } from '../common/health.controller.js';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter.js';
import { CONFIG, DB } from '../common/tokens.js';
import { newId, toStorageId } from '../common/ids.js';
import { loadConfig, type Config } from '../config.js';
import { openDb, runMigrations, type Db } from '../db/index.js';
import { KnowledgeRepo } from '../knowledge/repo.js';
import { IndexerService } from '../rag/indexer.service.js';
import { MetricsAuthGuard } from './metrics-auth.guard.js';
import { MetricsController } from './metrics.controller.js';
import { MetricsService } from './metrics.service.js';
import { ReadinessService } from './readiness.service.js';
import { requestLogging } from './request-logging.js';

describe('operations HTTP boundary', () => {
  let app: INestApplication;
  let db: Db;
  let config: Config;
  let readiness: ReadinessService;
  let users: UsersService;
  let sessions: SessionsService;
  let logRows: Record<string, unknown>[];
  const repo = { headSha: vi.fn(async () => 'a'.repeat(40)) };
  const index = { indexedSha: 'a'.repeat(40) as string | null, headSha: 'a'.repeat(40), syncing: false, lastSyncAt: '2026-01-01T00:00:00.000Z', lastError: null as string | null, pendingVectors: 0, embedding: { configured: false, model: 'test', dimensions: 3, ready: false } };
  const indexer = { status: vi.fn(async () => ({ ...index })) };

  beforeEach(async () => {
    db = openDb(':memory:');
    runMigrations(db);
    config = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'observability-test-secret', METRICS_TOKEN: 'scrape-secret' });
    repo.headSha.mockReset().mockResolvedValue('a'.repeat(40));
    index.lastError = null;
    index.indexedSha = 'a'.repeat(40);
    index.pendingVectors = 0;
    indexer.status.mockReset().mockImplementation(async () => ({ ...index }));
    logRows = [];
    const module = await Test.createTestingModule({
      controllers: [HealthController, MetricsController],
      providers: [ReadinessService, MetricsService, MetricsAuthGuard, SessionsService, UsersService, UsersRepository,
        { provide: DB, useValue: db }, { provide: CONFIG, useValue: config },
        { provide: KnowledgeRepo, useValue: repo }, { provide: IndexerService, useValue: indexer }],
    }).compile();
    app = module.createNestApplication({ logger: false });
    readiness = app.get(ReadinessService);
    users = app.get(UsersService);
    sessions = app.get(SessionsService);
    const log = pino({ level: 'info' }, { write: (line: string) => { logRows.push(JSON.parse(line) as Record<string, unknown>); } });
    app.use(requestLogging(log, app.get(MetricsService), sessions));
    app.useGlobalFilters(new HttpExceptionFilter(log));
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
    if (db?.open) db.close();
  });

  function sessionCookie(role: 'admin' | 'viewer'): string {
    const user = users.create({ email: `${role}@example.com`, role });
    let cookie = '';
    sessions.create({ cookie: (name: string, value: string) => { cookie = `${name}=${encodeURIComponent(value)}`; } } as Response, user);
    return cookie;
  }

  it('keeps liveness up while initial index is pending or failed, and becomes ready only after completion', async () => {
    await request(app.getHttpServer()).get('/healthz').expect(200, { ok: true });
    const pending = await request(app.getHttpServer()).get('/readyz').expect(503);
    expect(pending.body.error.code).toBe('service_unavailable');
    readiness.markInitialIndexError();
    const failed = await request(app.getHttpServer()).get('/readyz').expect(503);
    expect(failed.body.error.code).toBe('service_unavailable');
    await request(app.getHttpServer()).get('/healthz').expect(200, { ok: true });
    readiness.markInitialIndexReady();
    await request(app.getHttpServer()).get('/readyz').expect(200, { ok: true, initialIndex: 'ready', checks: { database: true, repository: true, index: true } });
  });

  it('accepts intentionally skipped initial indexing without requiring a fresh index', async () => {
    readiness.markInitialIndexSkipped();
    index.indexedSha = null;
    index.pendingVectors = 2;
    await request(app.getHttpServer()).get('/readyz').expect(200, { ok: true, initialIndex: 'skipped', checks: { database: true, repository: true, index: true } });
  });

  it.each(['ready', 'skipped'] as const)('withdraws %s readiness on index errors, unusable HEAD, rejected status, or database loss', async (initialIndex) => {
    if (initialIndex === 'ready') readiness.markInitialIndexReady();
    else readiness.markInitialIndexSkipped();
    index.lastError = 'embedding unavailable';
    const unhealthyIndex = await request(app.getHttpServer()).get('/readyz').expect(503);
    expect(unhealthyIndex.body.error.code).toBe('service_unavailable');
    expect(JSON.stringify(unhealthyIndex.body)).not.toContain('embedding unavailable');
    index.lastError = null;
    repo.headSha.mockResolvedValueOnce('');
    await request(app.getHttpServer()).get('/readyz').expect(503);
    indexer.status.mockRejectedValueOnce(new Error('status failed'));
    await request(app.getHttpServer()).get('/readyz').expect(503);
    db.close();
    await request(app.getHttpServer()).get('/readyz').expect(503);
    await request(app.getHttpServer()).get('/healthz').expect(200, { ok: true });
  });

  it('requires an admin session or dedicated metrics bearer and rejects invalid or disabled bearer even with admin cookies', async () => {
    await request(app.getHttpServer()).get('/metrics').expect(401);
    await request(app.getHttpServer()).get('/metrics').set('Cookie', sessionCookie('viewer')).expect(403);
    const admin = sessionCookie('admin');
    await request(app.getHttpServer()).get('/metrics').set('Cookie', admin).expect(200);
    await request(app.getHttpServer()).get('/metrics').set('Authorization', 'Bearer scrape-secret').expect(200);
    for (const token of ['wrong', 'scrape-secreu', 'lwk_' + 'a'.repeat(43)]) {
      await request(app.getHttpServer()).get('/metrics').set('Cookie', admin).set('Authorization', `Bearer ${token}`).expect(401);
    }
    config.metricsToken = undefined;
    await request(app.getHttpServer()).get('/metrics').set('Authorization', 'Bearer scrape-secret').expect(401);
    await request(app.getHttpServer()).get('/metrics').set('Cookie', admin).expect(200);
  });

  it('exports persisted queue, outcome, dream duration and index metrics without scrape double counting', async () => {
    db.prepare('INSERT INTO write_jobs (id,user_id,source,input,status,created_at) VALUES (?,?,?,?,?,?)').run(toStorageId(newId()), 1, 'web', 'secret raw prompt', 'queued', '2026-01-01');
    db.prepare('INSERT INTO write_jobs (id,user_id,source,input,status,created_at) VALUES (?,?,?,?,?,?)').run(toStorageId(newId()), 1, 'web', 'private note path', 'succeeded', '2026-01-01');
    db.prepare('INSERT INTO dream_runs (id,started_at,finished_at,status) VALUES (?,?,?,?)').run(toStorageId(newId()), '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:12.000Z', 'succeeded');
    index.indexedSha = 'b'.repeat(40);
    index.pendingVectors = 3;
    for (let i = 0; i < 2; i++) {
      const metrics = await request(app.getHttpServer()).get('/metrics').set('Authorization', 'Bearer scrape-secret').expect(200);
      expect(metrics.headers['content-type']).toContain('text/plain');
      expect(metrics.text).toContain('llmwiki_write_queue_depth{status="queued"} 1');
      expect(metrics.text).toContain('llmwiki_write_jobs_total{result="succeeded"} 1');
      expect(metrics.text).toContain('llmwiki_dream_duration_seconds_sum{result="succeeded"} 12');
      expect(metrics.text).toContain('llmwiki_dream_duration_seconds_count{result="succeeded"} 1');
      expect(metrics.text).toContain('llmwiki_index_stale 1');
      expect(metrics.text).toContain('llmwiki_index_pending_vectors 3');
      expect(metrics.text).not.toContain('secret raw prompt');
      expect(metrics.text).not.toContain('private note path');
    }
  });

  it('echoes safe request IDs, replaces unsafe IDs, and groups arbitrary unmatched URLs without logging secrets', async () => {
    const known = await request(app.getHttpServer()).get('/healthz?token=private-token').set('X-Request-ID', 'client:request-1').expect(200);
    expect(known.headers['x-request-id']).toBe('client:request-1');
    const invalid = await request(app.getHttpServer()).get('/api/private-note-one?token=private-token').set('X-Request-ID', 'invalid id').expect(404);
    expect(invalid.headers['x-request-id']).toMatch(/^[0-9A-Za-z]{22}$/);
    await request(app.getHttpServer()).get('/api/private-note-two').expect(404);
    const metrics = await request(app.getHttpServer()).get('/metrics').set('Authorization', 'Bearer scrape-secret').expect(200);
    expect(metrics.text).toContain('llmwiki_http_requests_total{method="GET",route="unmatched_backend",status="404"} 2');
    expect(metrics.text).toContain('llmwiki_http_request_duration_seconds_count{method="GET",route="/healthz",status="200"} 1');
    expect(logRows.find((row) => row.requestId === 'client:request-1')).toMatchObject({ method: 'GET', route: '/healthz', status: 200, userId: null });
    expect(JSON.stringify(logRows)).not.toMatch(/private-token|private-note|scrape-secret/);
    expect(metrics.text).not.toMatch(/private-token|private-note|scrape-secret/);
  });
});
