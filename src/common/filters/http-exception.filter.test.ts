import {
  Body, Controller, ForbiddenException, Get, HttpException, Post, Query, Res, type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { LOGGER } from '../tokens.js';
import { HttpExceptionFilter } from './http-exception.filter.js';

@Controller()
class ErrorController {
  @Get('validated')
  validated(@Query(new ZodValidationPipe(z.object({
    count: z.coerce.number({ error: 'Count must be a number' })
      .int({ error: 'Count must be an integer' })
      .positive({ error: 'Count must be positive' }),
  }))) query: { count: number }) {
    return { doubled: query.count * 2 };
  }

  @Post('nested-validation')
  nestedValidation(@Body(new ZodValidationPipe(z.object({
    profile: z.object({
      name: z.string().min(1, 'A profile name is required'),
      emails: z.array(z.string().email('An email address is required')),
    }),
  }))) body: { profile: { name: string; emails: string[] } }) {
    return { name: body.profile.name };
  }

  @Get('root-validation-error')
  rootValidationError(): never {
    throw new z.ZodError([{ code: 'custom', path: [], message: 'A request value is required' }]);
  }

  @Get('domain-error')
  domainError(): never {
    throw Object.assign(new Error('The last administrator cannot be removed'), { status: 409, code: 'last_admin' });
  }

  @Get('payload-too-large')
  payloadTooLarge(): never {
    throw Object.assign(new Error('Request body is too large'), { status: 413 });
  }

  @Get('authentication-error')
  authenticationError(@Res({ passthrough: true }) response: Response): never {
    response.setHeader('WWW-Authenticate', 'Bearer realm="mcp"');
    throw new HttpException({ code: 'invalid_token', message: 'Token expired' }, 401);
  }

  @Get('forbidden')
  forbidden(): never {
    throw new ForbiddenException('An editor role is required');
  }

  @Get('unexpected-error')
  unexpectedError(): never {
    throw new Error('Private upstream credentials');
  }

  @Get('domain-server-error')
  domainServerError(): never {
    throw Object.assign(new Error('Private upstream credentials'), { status: 500, code: 'storage_failure' });
  }

  @Get('sent-response')
  sentResponse(@Res() response: Response): never {
    response.status(202).json({ accepted: true });
    throw new Error('Failure after response was sent');
  }
}

describe('shared HTTP errors and validation', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ErrorController],
      providers: [HttpExceptionFilter, { provide: LOGGER, useValue: pino({ enabled: false }) }],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.useGlobalFilters(module.get(HttpExceptionFilter));
    await app.init();
  });

  afterAll(async () => { await app?.close(); });

  it('passes schema-transformed values to the controller and rejects invalid input as invalid_input', async () => {
    await request(app.getHttpServer()).get('/validated?count=4').expect(200, { doubled: 8 });
    await request(app.getHttpServer()).get('/validated?count=not-a-number').expect(400, {
      error: { code: 'invalid_input', message: 'count: Count must be a number' },
    });
  });

  it('aggregates nested validation issues with dotted object and array paths', async () => {
    await request(app.getHttpServer()).post('/nested-validation')
      .send({ profile: { name: '', emails: ['not-an-email'] } })
      .expect(400, {
        error: {
          code: 'invalid_input',
          message: 'profile.name: A profile name is required; profile.emails.0: An email address is required',
        },
      });
  });

  it('prefixes root validation issue messages with input', async () => {
    await request(app.getHttpServer()).get('/root-validation-error').expect(400, {
      error: { code: 'invalid_input', message: 'input: A request value is required' },
    });
  });

  it('preserves a domain error status, code and public message', async () => {
    await request(app.getHttpServer()).get('/domain-error').expect(409, {
      error: { code: 'last_admin', message: 'The last administrator cannot be removed' },
    });
  });

  it('preserves a numeric error status without a code as bad_request', async () => {
    await request(app.getHttpServer()).get('/payload-too-large').expect(413, {
      error: { code: 'bad_request', message: 'Request body is too large' },
    });
  });

  it('preserves HttpException payloads and authentication challenge headers', async () => {
    await request(app.getHttpServer()).get('/authentication-error')
      .expect('WWW-Authenticate', 'Bearer realm="mcp"')
      .expect(401, { error: { code: 'invalid_token', message: 'Token expired' } });
    await request(app.getHttpServer()).get('/forbidden')
      .expect(403, { error: { code: 'forbidden', message: 'An editor role is required' } });
  });

  it.each([
    ['/unexpected-error', 'internal_error'],
    ['/domain-server-error', 'storage_failure'],
  ])('redacts server error details from %s', async (path, code) => {
    await request(app.getHttpServer()).get(path).expect(500, {
      error: { code, message: 'Internal server error' },
    });
  });

  it('does not overwrite a response that has already been sent', async () => {
    await request(app.getHttpServer()).get('/sent-response').expect(202, { accepted: true });
  });
});
