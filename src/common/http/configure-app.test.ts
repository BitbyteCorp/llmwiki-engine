import { Body, Controller, Post, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { configureApp } from './configure-app.js';

@Controller()
class ParserController {
  @Post(['oauth/echo', 'api/echo'])
  echo(@Body() body: Record<string, unknown>) {
    return body;
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

  it.each(['json', 'form'])('rejects OAuth %s bodies above 64kb before backend parsers run', async (type) => {
    await request(app.getHttpServer()).post('/oauth/echo').type(type)
      .send({ text: 'x'.repeat(70 * 1024) }).expect(413);
  });

  it('retains the backend default 100kb JSON limit', async () => {
    await request(app.getHttpServer()).post('/api/echo')
      .send({ text: 'x'.repeat(101 * 1024) }).expect(413);
  });
});
