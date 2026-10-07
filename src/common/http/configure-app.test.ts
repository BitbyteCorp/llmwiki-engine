import { Body, Controller, Get, Post, Res, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureApp } from './configure-app.js';
import type { Response } from 'express';

@Controller()
class ParserController {
  @Post(['oauth/echo', 'api/echo'])
  echo(@Body() body: Record<string, unknown>) {
    return body;
  }
  @Get('api/events')
  events(@Res() response: Response) {
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.end(`data: ${'event'.repeat(1024)}\n\n`);
  }
}

describe('HTTP body parser scopes', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [ParserController] }).compile();
    app = module.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => { await app?.close(); });

  it('keeps OAuth form fields flat rather than interpreting bracket notation', async () => {
    await request(app.getHttpServer()).post('/oauth/echo').type('form')
      .send('grant_type=authorization_code&code=auth-code&client%5Bid%5D=client-id')
      .expect(201, {
        grant_type: 'authorization_code', code: 'auth-code', 'client[id]': 'client-id',
      });
  });

  it('preserves extended form parsing for backend routes', async () => {
    await request(app.getHttpServer()).post('/api/echo').type('form')
      .send('client%5Bid%5D=client-id')
      .expect(201, { client: { id: 'client-id' } });
  });

  it('parses backend JSON bodies larger than the OAuth limit', async () => {
    const body = { text: 'x'.repeat(70 * 1024) };
    await request(app.getHttpServer()).post('/api/echo').send(body).expect(201, body);
  });

  it('compresses large JSON without changing the decoded response', async () => {
    const body = { text: 'compressible'.repeat(1024) };
    const result = await request(app.getHttpServer()).post('/api/echo').set('Accept-Encoding', 'gzip').send(body);
    expect(result.headers['content-encoding']).toBe('gzip');
    expect(result.body).toEqual(body);
  });

  it('keeps SSE uncompressed even when the client accepts gzip', async () => {
    const result = await request(app.getHttpServer()).get('/api/events').set('Accept-Encoding', 'gzip');
    expect(result.headers['content-encoding']).toBeUndefined();
    expect(result.text).toBe(`data: ${'event'.repeat(1024)}\n\n`);
  });

  it.each(['json', 'form'])('rejects OAuth %s bodies above 64kb before backend parsers run', async (type) => {
    await request(app.getHttpServer()).post('/oauth/echo').type(type)
      .send({ text: 'x'.repeat(70 * 1024) }).expect(413);
  });

  it('retains the backend default 100kb JSON limit', async () => {
    await request(app.getHttpServer()).post('/api/echo')
      .send({ text: 'x'.repeat(101 * 1024) }).expect(413);
  });
});
