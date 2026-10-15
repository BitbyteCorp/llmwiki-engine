import 'reflect-metadata';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { AclService } from '../../src/acl/acl.service.js';
import { AgentService } from '../../src/agent/agent.service.js';
import type { AgentCheckpoint, AgentTool } from '../../src/agent/agent.types.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { UsersRepository } from '../../src/auth/users.repository.js';
import { UsersService } from '../../src/auth/users.service.js';
import { loadConfig } from '../../src/config.js';
import { openDb, runMigrations } from '../../src/db/index.js';
import type { KnowledgeRepo } from '../../src/knowledge/repo.js';
import type { SearchService } from '../../src/rag/search.service.js';
import { UsageRepository } from '../../src/usage/usage.repository.js';
import { UsageService } from '../../src/usage/usage.service.js';
import { startFakeOpenAI, type FakeScript } from '../fake-openai.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture(script: FakeScript) {
  const fake = await startFakeOpenAI(script);
  cleanup.push(() => fake.close());
  const db = openDb(':memory:');
  runMigrations(db);
  cleanup.push(async () => db.close());
  const usage = new UsageService(new UsageRepository(db));
  const acl = new AclService(db, new UsersService(new UsersRepository(db)), new AuditService(db));
  const config = loadConfig({ NODE_ENV: 'test', OPENAI_API_KEY: 'local-test-key', OPENAI_BASE_URL: fake.url,
    OPENAI_MAX_RETRIES: '0', LLM_MODELS: 'usage-model' });
  const agent = new AgentService(config, pino({ level: 'silent' }), {} as KnowledgeRepo, {} as SearchService, acl, usage);
  return { agent, usage };
}

const lookup: AgentTool = {
  name: 'lookup', description: 'Look up the capital',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  run: async () => '서울',
};
const first = { inputTokens: 100, cachedInputTokens: 40, outputTokens: 8, reasoningTokens: 3 };
const second = { inputTokens: 120, cachedInputTokens: 90, outputTokens: 10, reasoningTokens: 4 };

describe('actual agent response usage ledger', () => {
  it.each([{ lane: 'chat' as const, streaming: false }, { lane: 'chat' as const, streaming: true },
    { lane: 'write' as const, streaming: false }, { lane: 'write' as const, streaming: true }])(
    'records each $lane provider turn once (streaming=$streaming)', async ({ lane, streaming }) => {
      const { agent, usage } = await fixture([
        { functionCalls: [{ name: 'lookup', arguments: {} }], usage: first },
        { text: '서울이다.', usage: second },
      ]);
      const result = await agent.runAgent({ lane, instructions: '', input: '수도는?', tools: [lookup],
        ...(streaming ? { onTextDelta: () => {} } : {}) });
      expect(result).toEqual({ text: '서울이다.', finalText: '서울이다.', toolCalls: 1 });
      expect(usage.aggregate(1)).toEqual({ days: 1, rows: [{
        day: new Date().toISOString().slice(0, 10), lane, model: 'usage-model', calls: 2,
        inputTokens: 220, cachedInputTokens: 130, outputTokens: 18, reasoningTokens: 7,
      }] });
    });

  it.each([false, true])('records usage from a failed terminal provider response (streaming=%s)', async (streaming) => {
    const { agent, usage } = await fixture([{ text: '실패한 응답', status: 'failed', usage: first }]);
    await expect(agent.runAgent({ instructions: '', input: '질문', tools: [],
      ...(streaming ? { onTextDelta: () => {} } : {}) })).rejects.toThrow('Dony response failed');
    expect(usage.aggregate(1).rows).toEqual([{
      day: new Date().toISOString().slice(0, 10), lane: 'chat', model: 'usage-model', calls: 1, ...first,
    }]);
  });

  it('does not create usage for an HTTP failure without a provider response', async () => {
    const { agent, usage } = await fixture([{ error: { status: 503, message: 'Provider unavailable' } }]);
    await expect(agent.runAgent({ instructions: '', input: '질문', tools: [] })).rejects.toThrow('Provider unavailable');
    expect(usage.aggregate(1)).toEqual({ days: 1, rows: [] });
  });

  it('charges only new calls when a failed run resumes from accumulated checkpoint usage', async () => {
    const { agent, usage } = await fixture([
      { functionCalls: [{ name: 'lookup', arguments: {} }], usage: first },
      { text: '서울이다.', usage: second },
    ]);
    let checkpoint: AgentCheckpoint | undefined;
    await expect(agent.runAgent({ lane: 'write', instructions: '', input: '수도는?', tools: [lookup], maxTurns: 1,
      onCheckpoint: (saved) => { checkpoint = saved; } })).rejects.toThrow();
    expect(checkpoint?.usage).toEqual(first);
    const result = await agent.runAgent({ lane: 'write', instructions: '', input: '다시 시작하지 않는다.',
      tools: [lookup], resume: checkpoint! });
    expect(result).toEqual({ text: '서울이다.', finalText: '서울이다.', toolCalls: 1 });
    expect(usage.aggregate(1).rows).toEqual([{
      day: new Date().toISOString().slice(0, 10), lane: 'write', model: 'usage-model', calls: 2,
      inputTokens: 220, cachedInputTokens: 130, outputTokens: 18, reasoningTokens: 7,
    }]);
  });
});
