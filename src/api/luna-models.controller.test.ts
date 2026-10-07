import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiTokensService } from '../auth/api-tokens.service.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { SessionGuard } from '../auth/guards/session.guard.js';
import { SessionsService } from '../auth/sessions.service.js';
import { CONFIG } from '../common/tokens.js';
import { LunaModelsController } from './luna-models.controller.js';

let app: INestApplication;
let origin: string;

beforeEach(async () => {
  const module = await Test.createTestingModule({
    controllers: [LunaModelsController],
    providers: [
      SessionGuard, RolesGuard,
      { provide: CONFIG, useValue: { lunaModel: 'configured-luna', lunaReasoningEffort: 'xhigh' } },
      { provide: SessionsService, useValue: {
        sessionUser: (req: Request) => req.get('x-user') ? { id: 1, role: 'viewer' } : null,
        assertSameOrigin: () => undefined,
      } },
      { provide: ApiTokensService, useValue: {} },
    ],
  }).compile();
  app = module.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  const address = (app.getHttpServer() as Server).address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await app?.close();
  vi.unstubAllEnvs();
});

describe('Luna model discovery', () => {
  it('discloses only configured request choices to authenticated viewers and retains a broader server default', async () => {
    vi.stubEnv('LUNA_MODELS', ' configured-luna, alternative-luna, , ');
    const response = await fetch(`${origin}/api/luna/models`, { headers: { 'x-user': '1' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      models: ['configured-luna', 'alternative-luna'], defaultModel: 'configured-luna',
      efforts: ['low', 'medium', 'high'], defaultEffort: 'xhigh',
    });
    expect((await fetch(`${origin}/api/luna/models`)).status).toBe(401);
  });

  it('uses the configured default model when there is no override allowlist', async () => {
    vi.stubEnv('LUNA_MODELS', undefined);
    const response = await fetch(`${origin}/api/luna/models`, { headers: { 'x-user': '1' } });
    expect(await response.json()).toMatchObject({ models: ['configured-luna'] });
  });
});
