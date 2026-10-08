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
import { loadConfig } from '../config.js';
import { ModelsController } from './models.controller.js';

describe('Model configuration', () => {
  it('uses the supported model and medium effort when no model configuration is supplied', () => {
    const config = loadConfig({});
    expect(config.llmModels).toEqual(['gpt-6-luna']);
    expect(config.llmModel).toBe('gpt-6-luna');
    expect(config.llmReasoningEffort).toBe('medium');
  });

  it('selects the first nonempty trimmed model as the default', () => {
    const config = loadConfig({
      LLM_MODELS: ' , configured-model, , alternative-model, ',
      LLM_REASONING_EFFORT: 'xhigh',
    });
    expect(config.llmModels).toEqual(['configured-model', 'alternative-model']);
    expect(config.llmModel).toBe('configured-model');
    expect(config.llmReasoningEffort).toBe('xhigh');
  });

  it.each(['', '   ', ', ,\t,'])('rejects an explicitly empty model list %j', (models) => {
    expect(() => loadConfig({ LLM_MODELS: models })).toThrowError(/LLM_MODELS/);
  });

  it('rejects an explicitly empty reasoning effort', () => {
    expect(() => loadConfig({ LLM_REASONING_EFFORT: '' })).toThrowError(/LLM_REASONING_EFFORT/);
  });
});

describe('Model discovery', () => {
  let app: INestApplication;
  let origin: string;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      controllers: [ModelsController],
      providers: [
        SessionGuard, RolesGuard,
        { provide: CONFIG, useValue: loadConfig({
          LLM_MODELS: ' configured-model, alternative-model, , ',
          LLM_REASONING_EFFORT: 'xhigh',
        }) },
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

  it('discloses the loaded model choices and default effort to authenticated viewers', async () => {
    vi.stubEnv('LLM_MODELS', 'different-model');
    vi.stubEnv('LLM_REASONING_EFFORT', 'low');
    const response = await fetch(`${origin}/api/models`, { headers: { 'x-user': '1' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      models: ['configured-model', 'alternative-model'], defaultModel: 'configured-model',
      efforts: ['low', 'medium', 'high'], defaultEffort: 'xhigh',
    });
  });

  it('requires authentication to discover model choices', async () => {
    expect((await fetch(`${origin}/api/models`)).status).toBe(401);
  });
});
