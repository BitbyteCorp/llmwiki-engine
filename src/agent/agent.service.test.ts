import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AclService } from '../acl/acl.service.js';
import { AuditService } from '../audit/audit.service.js';
import { UsersRepository } from '../auth/users.repository.js';
import { UsersService } from '../auth/users.service.js';
import type { Config } from '../config.js';
import { loadConfig } from '../config.js';
import type { CodexCredentialSource } from '../codex/codex.types.js';
import { CodexNotLoggedInError } from '../codex/codex.types.js';
import { openDb, runMigrations } from '../db/index.js';
import { KnowledgeRepo } from '../knowledge/repo.js';
import { WikiCatalog } from '../knowledge/wiki-catalog.js';
import { SearchService } from '../rag/search.service.js';
import { AgentService } from './agent.service.js';

interface FakeProvider {
  url: string;
  requests: Array<{ path: string; body: Record<string, unknown>; headers: Record<string, string | string[] | undefined> }>;
  close(): Promise<void>;
}

type FakeTurn = string | { text: string; functionCalls: Array<{ name: string; arguments: Record<string, unknown> }> };

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function fixture(provider: Config['llmProvider'], unauthorizedOnce = false, loggedIn = true, script: readonly FakeTurn[] = ['Provider response']) {
  // Static import cannot cross the production TypeScript root into test/; keep this test-only module boundary dynamic.
  const { startFakeOpenAI }: {
    startFakeOpenAI(script: readonly FakeTurn[], options?: { codex?: boolean; unauthorizedOnce?: boolean }): Promise<FakeProvider>;
  } = await import(new URL('../../test/fake-openai.ts', import.meta.url).href);
  const fake = await startFakeOpenAI(script, { codex: provider === 'openai-codex', unauthorizedOnce });
  cleanup.push(() => fake.close());
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-provider-'));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    NODE_ENV: 'test', DATA_DIR: dataDir, LLM_PROVIDER: provider,
    OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: fake.url, CODEX_BASE_URL: fake.url, OPENAI_MAX_RETRIES: '0',
    LLM_COMPACT_THRESHOLD: '12345',
  });
  if (provider === 'openai-codex' && loggedIn) config.openaiApiKey = '';
  const codex: CodexCredentialSource = {
    getAccess: vi.fn(async () => {
      if (!loggedIn) throw new CodexNotLoggedInError();
      return { accessToken: 'codex-access', accountId: 'codex-account' };
    }),
    refreshAccess: vi.fn(async () => ({ accessToken: 'codex-refreshed', accountId: 'codex-account' })),
    isLoggedIn: () => loggedIn,
  };
  const log = pino({ level: 'silent' });
  const db = openDb(':memory:');
  runMigrations(db);
  cleanup.push(async () => db.close());
  const acl = new AclService(db, new UsersService(new UsersRepository(db)), new AuditService(db));
  const repo = await KnowledgeRepo.open(config, log);
  const search = new SearchService(config, db, log, acl, repo);
  return { config, fake, codex, repo, agent: new AgentService(config, log, repo, search, acl, new WikiCatalog(repo, acl), undefined, codex) };
}

describe('agent provider requests', () => {
  it.each(['openai', 'openrouter', 'openai-codex'] as const)('uses %s request capabilities without changing stateless response settings', async (provider) => {
    const { agent, fake, config } = await fixture(provider);
    if (provider === 'openai-codex') expect(config.openaiApiKey).toBe('');
    expect(await agent.runAgent({ instructions: 'Answer briefly', input: 'Hello', tools: [], maxTurns: 1 }))
      .toEqual({ text: 'Provider response', finalText: 'Provider response', toolCalls: 0 });
    expect(fake.requests).toHaveLength(1);
    const request = fake.requests[0]!;
    const model = provider === 'openrouter' ? 'openai/gpt-6-luna' : 'gpt-6-luna';
    expect(request.path).toBe('/v1/responses');
    expect(request.body).toMatchObject({
      model, instructions: 'Answer briefly', input: [{ role: 'user', content: 'Hello' }],
      store: false, include: ['reasoning.encrypted_content'],
      prompt_cache_key: `llmwiki:chat:${model}`, reasoning: { effort: 'medium' }, tools: [], stream: provider === 'openai-codex',
    });
    if (provider === 'openai') {
      expect(request.body.context_management).toEqual([{ type: 'compaction', compact_threshold: 12345 }]);
    } else {
      expect(request.body).not.toHaveProperty('context_management');
    }
    if (provider === 'openai-codex') {
      expect(request.headers).toMatchObject({
        authorization: 'Bearer codex-access', 'chatgpt-account-id': 'codex-account',
        originator: 'llmwiki', 'openai-beta': 'responses=experimental',
      });
      expect(request.body).not.toHaveProperty('max_output_tokens');
      expect(request.body).not.toHaveProperty('max_completion_tokens');
    }
  });

  it('refreshes expired Codex credentials once and returns a normal agent result from the retried SSE response', async () => {
    const { agent, fake, codex } = await fixture('openai-codex', true);
    expect(await agent.runAgent({ instructions: 'Answer briefly', input: 'Hello', tools: [], maxTurns: 1 }))
      .toEqual({ text: 'Provider response', finalText: 'Provider response', toolCalls: 0 });
    expect(codex.refreshAccess).toHaveBeenCalledOnce();
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests.map((request) => request.headers.authorization)).toEqual(['Bearer codex-access', 'Bearer codex-refreshed']);
    expect(fake.requests[1]!.body).toEqual(fake.requests[0]!.body);
    expect(fake.requests[1]!.body).toMatchObject({ stream: true, store: false });
  });

  it('requires a Codex login even when an OpenAI Platform API key is configured', async () => {
    const { agent, fake, config } = await fixture('openai-codex', false, false);
    expect(config.openaiApiKey).toBe('test-key');
    await expect(agent.runAgent({ instructions: 'Answer briefly', input: 'Hello', tools: [], maxTurns: 1 }))
      .rejects.toBeInstanceOf(CodexNotLoggedInError);
    expect(fake.requests).toHaveLength(0);
  });

  it.each([false, true])('returns only the accepted final turn separately from resumed and preamble text (streaming=%s)', async (streaming) => {
    const { agent } = await fixture('openai', false, true, [
      { text: '먼저 근거를 읽겠다.', functionCalls: [{ name: 'lookup', arguments: {} }] },
      'REJECTED_SCRATCH_TEXT',
      '확인한 최종 결과다.',
    ]);
    let finishes = 0;
    const result = await agent.runAgent({
      instructions: 'Return verified facts', input: 'ignored',
      resume: { input: [{ role: 'user', content: 'Continue' }], text: '이전 실행의 텍스트.', toolCalls: 2 },
      tools: [{ name: 'lookup', description: 'Look up facts', parameters: {}, run: async () => 'Verified fact' }],
      beforeFinish: () => finishes++ === 0 ? 'Check the result again' : undefined,
      ...(streaming ? { onTextDelta: () => {} } : {}),
    });
    expect(result).toEqual({
      text: '이전 실행의 텍스트.먼저 근거를 읽겠다.확인한 최종 결과다.',
      finalText: '확인한 최종 결과다.',
      toolCalls: 3,
    });
    expect(finishes).toBe(2);
  });

  it('uses only final Markdown as proposed content after a tool-call preamble', async () => {
    const original = '# Facts\nOriginal fact.\n';
    const proposed = '# Facts\nOriginal fact.\nVerified addition.\n';
    const { agent, repo } = await fixture('openai', false, true, [
      { text: 'Need source evidence. 먼저 원문을 읽겠다.', functionCalls: [{ name: 'read_note', arguments: { path: 'wiki/facts.md' } }] },
      proposed,
    ]);
    const wt = await repo.createWorktree('proposal-evidence');
    try {
      await wt.write('wiki/facts.md', original);
      await wt.commit('Seed proposal evidence', { name: 'Test', email: 'test@example.test' });
      await repo.withMergeLock(() => wt.fastForwardMain());
    } finally {
      await wt.dispose();
    }
    const savedOriginal = await repo.readFile('wiki/facts.md');
    expect(await agent.proposal('Verified addition.', 'edit', 'wiki/facts.md')).toMatchObject({
      path: 'wiki/facts.md', original: savedOriginal, proposed,
    });
    expect(await repo.readFile('wiki/facts.md')).toBe(savedOriginal);
  });
});
