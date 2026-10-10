import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { AclService } from '../acl/acl.service.js';
import { AuditService } from '../audit/audit.service.js';
import { UsersRepository } from '../auth/users.repository.js';
import { UsersService } from '../auth/users.service.js';
import type { Config } from '../config.js';
import { loadConfig } from '../config.js';
import { openDb, runMigrations } from '../db/index.js';
import { KnowledgeRepo } from '../knowledge/repo.js';
import { SearchService } from '../rag/search.service.js';
import { AgentService } from './agent.service.js';

interface FakeProvider {
  url: string;
  requests: Array<{ path: string; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function fixture(provider: Config['llmProvider']) {
  // The shared provider lives outside the production TypeScript root.
  const { startFakeOpenAI }: { startFakeOpenAI(script: readonly string[]): Promise<FakeProvider> } = await import(new URL('../../test/fake-openai.ts', import.meta.url).href);
  const fake = await startFakeOpenAI(['Provider response']);
  cleanup.push(() => fake.close());
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-provider-'));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    NODE_ENV: 'test', DATA_DIR: dataDir, LLM_PROVIDER: provider,
    OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: fake.url, OPENAI_MAX_RETRIES: '0',
    LLM_COMPACT_THRESHOLD: '12345',
  });
  const log = pino({ level: 'silent' });
  const db = openDb(':memory:');
  runMigrations(db);
  cleanup.push(async () => db.close());
  const acl = new AclService(db, new UsersService(new UsersRepository(db)), new AuditService(db));
  const repo = await KnowledgeRepo.open(config, log);
  const search = new SearchService(config, db, log, acl, repo);
  return { fake, agent: new AgentService(config, log, repo, search, acl) };
}

describe('agent provider requests', () => {
  it.each(['openai', 'openrouter'] as const)('uses %s request capabilities without changing stateless response settings', async (provider) => {
    const { agent, fake } = await fixture(provider);
    expect(await agent.runAgent({ instructions: 'Answer briefly', input: 'Hello', tools: [], maxTurns: 1 }))
      .toEqual({ text: 'Provider response', toolCalls: 0 });
    expect(fake.requests).toHaveLength(1);
    const request = fake.requests[0]!;
    const model = provider === 'openrouter' ? 'openai/gpt-6-luna' : 'gpt-6-luna';
    expect(request.path).toBe('/v1/responses');
    expect(request.body).toMatchObject({
      model, instructions: 'Answer briefly', input: [{ role: 'user', content: 'Hello' }],
      store: false, include: ['reasoning.encrypted_content'],
      prompt_cache_key: `llmwiki:chat:${model}`, reasoning: { effort: 'medium' }, tools: [], stream: false,
    });
    if (provider === 'openai') {
      expect(request.body.context_management).toEqual([{ type: 'compaction', compact_threshold: 12345 }]);
    } else {
      expect(request.body).not.toHaveProperty('context_management');
    }
  });
});
