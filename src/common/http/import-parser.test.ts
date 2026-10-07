import 'reflect-metadata';
import { Body, Controller, Post, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureApp } from './configure-app.js';

@Controller()
class ImportParserSurface {
  @Post(['api/imports', 'mcp', 'api/unrelated', 'oauth/token'])
  source(@Body() body: unknown) {
    return body;
  }
}

describe('text import HTTP body boundary', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [ImportParserSurface] }).compile();
    app = module.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => { await app?.close(); });

  it.each(['/api/imports', '/mcp'])('accepts %s JSON sources above the ordinary API body limit', async (route) => {
    const source = { kind: 'text', text: 'Large source\n'.repeat(10_000), instructions: 'Preserve the imported source' };
    const body = route === '/mcp' ? { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ingest_source', arguments: source } } : source;
    await request(app.getHttpServer()).post(route).send(body).expect(201);
  });

  it.each(['/api/imports', '/mcp'])('rejects %s encoded ingestion envelopes exceeding 21 MiB', async (route) => {
    await request(app.getHttpServer()).post(route)
      .send({ kind: 'text', text: 'a'.repeat(21 * 1024 * 1024), instructions: 'envelope overflow' }).expect(413);
  });

  it('does not enlarge OAuth or unrelated backend body limits', async () => {
    const text = 'a'.repeat(110 * 1024);
    for (const route of ['/oauth/token', '/api/unrelated']) {
      await request(app.getHttpServer()).post(route).send({ kind: 'text', text, instructions: '' }).expect(413);
    }
  });
});
