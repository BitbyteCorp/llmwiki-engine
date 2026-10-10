import { Test } from '@nestjs/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino, { type Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../../src/config.js';
import { CONFIG, LOGGER } from '../../src/common/tokens.js';
import { newId } from '../../src/common/ids.js';
import { KnowledgeRepo, type Worktree } from '../../src/knowledge/repo.js';
import { SearchService } from '../../src/rag/search.service.js';
import type { WriteJob } from '../../src/jobs/write-job.types.js';
import { startFakeOpenAI, type FakeResponder, type FakeScript } from '../fake-openai.js';
import { AgentService } from '../../src/agent/agent.service.js';
import type { AgentCheckpoint, AgentTool, ChatMessage, TokenUsage } from '../../src/agent/agent.types.js';
import { AclService } from '../../src/acl/acl.service.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { UsersService } from '../../src/auth/users.service.js';
import { UsersRepository } from '../../src/auth/users.repository.js';
import { openDb, runMigrations } from '../../src/db/index.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function createAgent(
  config: Config,
  repo: KnowledgeRepo,
  search: SearchService,
  log: Logger,
  aclOverride?: AclService,
) {
  const db = openDb(':memory:');
  runMigrations(db);
  cleanup.push(async () => db.close());
  const acl = aclOverride ?? new AclService(db, new UsersService(new UsersRepository(db)), new AuditService(db));
  const module = await Test.createTestingModule({
    providers: [
      AgentService,
      { provide: CONFIG, useValue: config },
      { provide: LOGGER, useValue: log },
      { provide: KnowledgeRepo, useValue: repo },
      { provide: SearchService, useValue: search },
      { provide: AclService, useValue: acl },
    ],
  }).compile();
  await module.init();
  cleanup.push(() => module.close());
  return module.get(AgentService);
}

async function fixture(script: FakeScript | FakeResponder, notes: Record<string, string> = {}, acl?: AclService) {
  const fake = await startFakeOpenAI(script);
  cleanup.push(() => fake.close());
  const config = loadConfig({ NODE_ENV: 'test', OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: fake.url });
  // Keep model and git dependencies controllable while resolving the real Nest service.
  const repo = {
    readFile: async (path: string) => notes[path] ?? null,
    listFiles: async (prefix: string, _ref: string) => Object.keys(notes).filter((path) => path.startsWith(prefix)),
    headSha: async () => 'test-sha',
    log: async () => [],
  } as unknown as KnowledgeRepo;
  const search = { search: async () => [{ path: 'wiki/cache.md', title: '캐시', snippet: '근거', score: 1, heading: '', kind: 'wiki', related: [] }] } as unknown as SearchService;
  const log = pino({ level: 'silent' });
  return { agent: await createAgent(config, repo, search, log, acl), fake, config, repo, search, log };
}

async function aclFixture(notes: Record<string, string>) {
  const db = openDb(':memory:');
  runMigrations(db);
  cleanup.push(async () => db.close());
  const users = new UsersService(new UsersRepository(db));
  const admin = await users.create({ email: 'admin@example.com', role: 'admin' });
  const viewer = await users.create({ email: 'viewer@example.com', role: 'viewer' });
  const acl = new AclService(db, users, new AuditService(db));
  return { ...await fixture([], notes, acl), acl, admin, viewer };
}

function strictUnicodeResponder(script: FakeScript): FakeResponder {
  const check = (value: unknown): void => {
    if (typeof value === 'string') {
      if (!value.isWellFormed()) throw new SyntaxError('invalid_json: lone surrogate in request body');
    } else if (value && typeof value === 'object') {
      for (const item of Object.values(value)) check(item);
    }
  };
  return (request, index) => {
    check(request.body);
    return script[index]!;
  };
}

const lookup: AgentTool = {
  name: 'lookup', description: 'Find a recorded fact',
  parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
  run: async (args) => {
    if (!args || typeof args !== 'object' || !('key' in args) || args.key !== 'capital') throw new Error('Unknown fact');
    return '서울';
  },
};

const job: WriteJob = {
  id: newId(), userId: 1, source: 'mcp', input: '캐시의 정의를 정리한다.', status: 'running', summary: null,
  kind: 'agent', client: null, conflicts: [],
  commits: [], mergeSha: null, error: null, createdAt: '2026-10-07T00:00:00.000Z', startedAt: null, finishedAt: null,
};

describe('Dony Responses tool loop', () => {
  it('returns a fact after a function-call round trip', async () => {
    const { agent, fake } = await fixture([{ name: 'lookup', arguments: { key: 'capital' }, call_id: 'fact' }, '수도는 서울이다.']);
    await expect(agent.runAgent({ instructions: 'Answer from facts', input: '수도는?', tools: [lookup] }))
      .resolves.toEqual({ text: '수도는 서울이다.', toolCalls: 1 });
    expect(fake.requests[1]!.body.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function_call_output', call_id: 'fact', output: '서울' }),
    ]));
  });

  it.each([false, true])('keeps only the latest compaction context (streaming=%s)', async (streaming) => {
    const oldCompaction = { type: 'compaction' as const, id: 'cp-old', encrypted_content: 'old-summary' };
    const latestCompaction = { type: 'compaction' as const, id: 'cp-latest', encrypted_content: 'latest-summary' };
    const { agent, fake, config } = await fixture([
      { name: 'lookup', arguments: { key: 'capital' }, call_id: 'before' },
      { output: [oldCompaction, '중간 확인이다.', latestCompaction, { name: 'lookup', arguments: { key: 'capital' }, call_id: 'after' }] },
      '서울이다.',
    ]);
    const checkpoints: AgentCheckpoint[] = [];
    const deltas: string[] = [];
    await expect(agent.runAgent({
      instructions: '', input: '이전 입력이다.', tools: [lookup],
      onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
      ...(streaming ? { onTextDelta: (text: string) => deltas.push(text) } : {}),
    })).resolves.toEqual({ text: '중간 확인이다.서울이다.', toolCalls: 2 });
    expect(fake.requests[2]!.body.input).toEqual([
      latestCompaction,
      expect.objectContaining({ type: 'function_call', call_id: 'after' }),
      { type: 'function_call_output', call_id: 'after', output: '서울' },
    ]);
    for (const request of fake.requests) {
      expect(request.body.context_management).toEqual([{ type: 'compaction', compact_threshold: config.llmCompactThreshold }]);
    }
    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[1]!.input).toEqual(fake.requests[2]!.body.input);
    if (streaming) expect(deltas.join('')).toBe('중간 확인이다.서울이다.');
  });

  it('resumes accumulated state and checkpoints each completed tool turn independently', async () => {
    const resume: AgentCheckpoint = {
      input: [{ type: 'compaction', encrypted_content: 'saved-state' }, { role: 'user', content: '계속한다.' }],
      text: '이전 답변. ', toolCalls: 4,
      usage: { inputTokens: 20, outputTokens: 10, reasoningTokens: 3 },
    };
    const { agent, fake } = await fixture([
      { functionCalls: [{ name: 'lookup', arguments: { key: 'capital' }, call_id: 'resumed' }], text: '확인. ', usage: { inputTokens: 5, outputTokens: 4, reasoningTokens: 2 } },
      { text: '서울이다.', usage: { inputTokens: 6, outputTokens: 3, reasoningTokens: 1 } },
    ]);
    const checkpoints: AgentCheckpoint[] = [];
    let usage: unknown;
    const deltas: TokenUsage[] = [];
    await expect(agent.runAgent({
      instructions: '', input: '무시할 입력', resume, tools: [lookup], maxTurns: 2,
      onUsage: (delta) => deltas.push(delta),
      onCheckpoint: (checkpoint) => {
        checkpoints.push(JSON.parse(JSON.stringify(checkpoint)));
        checkpoint.input.length = 0;
        if (checkpoint.usage) checkpoint.usage.inputTokens = -1;
      },
      onEvent: (event, data) => { if (event === 'usage') usage = data; },
    })).resolves.toEqual({ text: '이전 답변. 확인. 서울이다.', toolCalls: 5 });
    expect(fake.requests[0]!.body.input).toEqual(resume.input);
    expect(resume).toEqual({
      input: [{ type: 'compaction', encrypted_content: 'saved-state' }, { role: 'user', content: '계속한다.' }],
      text: '이전 답변. ', toolCalls: 4,
      usage: { inputTokens: 20, outputTokens: 10, reasoningTokens: 3 },
    });
    expect(checkpoints).toEqual([{
      input: fake.requests[1]!.body.input, text: '이전 답변. 확인. ', toolCalls: 5,
      usage: { inputTokens: 25, cachedInputTokens: 0, outputTokens: 14, reasoningTokens: 5 },
    }]);
    expect(usage).toEqual({ inputTokens: 31, cachedInputTokens: 0, outputTokens: 17, reasoningTokens: 6 });
    expect(deltas).toEqual([
      { inputTokens: 5, cachedInputTokens: 0, outputTokens: 4, reasoningTokens: 2 },
      { inputTokens: 6, cachedInputTokens: 0, outputTokens: 3, reasoningTokens: 1 },
    ]);
  });

  it('preserves checkpoint cached totals without charging resumed usage again', async () => {
    const saved = { inputTokens: 100, cachedInputTokens: 75, outputTokens: 10, reasoningTokens: 4 };
    const delta = { inputTokens: 20, cachedInputTokens: 12, outputTokens: 5, reasoningTokens: 1 };
    const { agent } = await fixture([{ text: '계속된 답변', usage: delta }]);
    const deltas: TokenUsage[] = [];
    let total: unknown;
    await agent.runAgent({
      instructions: '', input: '', tools: [],
      resume: { input: [{ role: 'user', content: '계속' }], text: '', toolCalls: 0, usage: saved },
      onUsage: (usage) => deltas.push(usage),
      onEvent: (event, data) => { if (event === 'usage') total = data; },
    });
    expect(deltas).toEqual([delta]);
    expect(total).toEqual({ inputTokens: 120, cachedInputTokens: 87, outputTokens: 15, reasoningTokens: 5 });
  });

  it.each([false, true])('keeps the cache prefix stable and accounts cached tokens before tools (streaming=%s)', async (streaming) => {
    const first = { inputTokens: 100, cachedInputTokens: 40, outputTokens: 8, reasoningTokens: 3 };
    const second = { inputTokens: 120, cachedInputTokens: 90, outputTokens: 10, reasoningTokens: 4 };
    const { agent, fake } = await fixture([
      { functionCalls: [{ name: 'lookup', arguments: { key: 'capital' } }], usage: first },
      { text: '서울이다.', usage: second },
    ]);
    const deltas: TokenUsage[] = [];
    const checkpoints: AgentCheckpoint[] = [];
    let total: unknown;
    let turn = 0;
    await agent.runAgent({
      lane: 'write', model: 'selected-model', instructions: 'Stable instructions', input: '수도는?',
      tools: [{ ...lookup, run: async (args) => {
        expect(deltas).toEqual([first]);
        return lookup.run(args);
      } }],
      beforeTurn: () => [{ role: 'user', content: `Queued message ${++turn}` }],
      onUsage: (delta) => deltas.push(delta),
      onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
      onEvent: (event, data) => { if (event === 'usage') total = data; },
      ...(streaming ? { onTextDelta: () => {} } : {}),
    });
    expect(deltas).toEqual([first, second]);
    expect(checkpoints[0]!.usage).toEqual(first);
    expect(total).toEqual({ inputTokens: 220, cachedInputTokens: 130, outputTokens: 18, reasoningTokens: 7 });
    for (const request of fake.requests) {
      expect(request.body.prompt_cache_key).toBe('llmwiki:write:selected-model');
      expect(request.body.instructions).toBe('Stable instructions');
      expect(request.body.tools).toEqual(fake.requests[0]!.body.tools);
    }
    expect(fake.requests[1]!.body.input).toEqual(expect.arrayContaining([
      { role: 'user', content: 'Queued message 2' },
    ]));
  });

  it.each([
    [undefined, 'high'], ['chat', 'high'], ['proposal', 'high'],
    ['summarize', 'minimal'], ['write', 'minimal'], ['subagent', 'minimal'], ['conflict', 'minimal'], ['dreaming', 'minimal'],
  ] as const)('selects reasoning effort for lane %s', async (lane, expectedEffort) => {
    const { agent, fake, config } = await fixture(['완료']);
    config.llmReasoningEffort = 'high';
    config.llmBackgroundReasoningEffort = 'minimal';
    await agent.runAgent({ lane, instructions: '', input: '', tools: [] });
    expect(fake.requests[0]!.body.reasoning).toEqual({ effort: expectedEffort });
    expect(fake.requests[0]!.body.prompt_cache_key).toBe(`llmwiki:${lane ?? 'chat'}:${config.llmModel}`);
  });

  it.each(['chat', 'write'] as const)('honors explicit effort on lane %s', async (lane) => {
    const { agent, fake, config } = await fixture(['완료']);
    config.llmReasoningEffort = 'medium';
    config.llmBackgroundReasoningEffort = 'low';
    await agent.runAgent({ lane, effort: 'high', instructions: '', input: '', tools: [] });
    expect(fake.requests[0]!.body.reasoning).toEqual({ effort: 'high' });
  });

  it.each([
    [false, 'failed'], [true, 'failed'], [false, 'incomplete'], [true, 'incomplete'],
  ] as const)('reports usage before rejecting a %s-streamed %s response', async (streaming, status) => {
    const delta = { inputTokens: 80, cachedInputTokens: 60, outputTokens: 5, reasoningTokens: 2 };
    const { agent } = await fixture([{ text: '', status, usage: delta }]);
    const deltas: TokenUsage[] = [];
    let total: unknown;
    await expect(agent.runAgent({
      instructions: '', input: '', tools: [], onUsage: (usage) => deltas.push(usage),
      onEvent: (event, data) => { if (event === 'usage') total = data; },
      ...(streaming ? { onTextDelta: () => {} } : {}),
    })).rejects.toThrow(`Dony response ${status}`);
    expect(deltas).toEqual([delta]);
    expect(total).toBeUndefined();
  });

  it('reports usage before cancellation at a completed tool response', async () => {
    const delta = { inputTokens: 80, cachedInputTokens: 60, outputTokens: 5, reasoningTokens: 2 };
    const { agent } = await fixture([{ functionCalls: [{ name: 'lookup', arguments: { key: 'capital' } }], usage: delta }]);
    const controller = new AbortController();
    const deltas: TokenUsage[] = [];
    let toolRuns = 0;
    await expect(agent.runAgent({
      instructions: '', input: '', signal: controller.signal,
      tools: [{ ...lookup, run: async () => { toolRuns++; return 'not reached'; } }],
      onUsage: (usage) => { deltas.push(usage); controller.abort(new Error('cancel after accounting')); },
    })).rejects.toThrow('cancel after accounting');
    expect(deltas).toEqual([delta]);
    expect(toolRuns).toBe(0);
  });

  it('caps oversized tool results and errors at 16000 characters before the next request', async () => {
    const { agent, fake } = await fixture([
      { functionCalls: [{ name: 'large', arguments: {}, call_id: 'result' }, { name: 'fail', arguments: {}, call_id: 'error' }] },
      '출력을 좁혀 확인한다.',
    ]);
    const tools: AgentTool[] = [
      { name: 'large', description: '', parameters: {}, run: async () => 'x'.repeat(50000) },
      { name: 'fail', description: '', parameters: {}, run: async () => { throw new Error('e'.repeat(50000)); } },
    ];
    await agent.runAgent({ instructions: '', input: '', tools });
    const outputs = (fake.requests[1]!.body.input as Array<{ type: string; output?: string }>).filter((item) => item.type === 'function_call_output');
    expect(outputs).toHaveLength(2);
    for (const item of outputs) {
      expect(item.output!.length).toBe(16000);
    }
    expect(outputs[0]!.output!.startsWith('x'.repeat(15000))).toBe(true);
    expect(outputs[1]!.output!.startsWith('{"error":"' + 'e'.repeat(15000))).toBe(true);
  });

  it.each([false, true])('completes with tool output capped at an emoji boundary (streaming=%s)', async (streaming) => {
    const { agent, fake } = await fixture(strictUnicodeResponder([
      { name: 'large', arguments: {}, call_id: 'emoji-cap' },
      '출력을 확인했다.',
    ]));
    const tool: AgentTool = {
      name: 'large', description: '', parameters: {},
      run: async () => 'x'.repeat(15937) + '😀' + 'tail'.repeat(100),
    };
    await expect(agent.runAgent({
      instructions: '', input: '', tools: [tool],
      ...(streaming ? { onTextDelta: () => {} } : {}),
    })).resolves.toEqual({ text: '출력을 확인했다.', toolCalls: 1 });
    expect(fake.requests[1]!.body.input).toEqual(expect.arrayContaining([
      {
        type: 'function_call_output', call_id: 'emoji-cap',
        output: 'x'.repeat(15937) + '\n[truncated: use paging or narrower queries to retrieve more.]',
      },
    ]));
  });

  it.each([false, true])('repairs poisoned checkpoint strings before replay without changing the checkpoint (streaming=%s)', async (streaming) => {
    const resume: AgentCheckpoint = {
      input: [
        { role: 'user', content: [{ type: 'input_text', text: '질문 \uD83D 😀' }] },
        { type: 'function_call', name: 'lookup', arguments: '{"key":"\uDE00"}', call_id: 'saved-call' },
        { type: 'function_call_output', call_id: 'saved-call', output: '결과 \uD83D' },
        { type: 'function_call_output', call_id: 'saved-parts', output: [{ type: 'input_text', text: '중첩 \uDE00' }] },
        { type: 'message', role: 'assistant', id: 'saved-message', status: 'completed', content: [
          { type: 'output_text', text: '이전 \uD83D 답변', annotations: [] },
        ] },
      ],
      text: '누적 답변. ', toolCalls: 2,
    };
    const original = structuredClone(resume);
    const { agent, fake } = await fixture(strictUnicodeResponder(['재개했다.']));
    await expect(agent.runAgent({
      instructions: '', input: 'ignored', resume, tools: [],
      ...(streaming ? { onTextDelta: () => {} } : {}),
    })).resolves.toEqual({ text: '누적 답변. 재개했다.', toolCalls: 2 });
    expect(fake.requests[0]!.body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: '질문 � 😀' }] },
      { type: 'function_call', name: 'lookup', arguments: '{"key":"�"}', call_id: 'saved-call' },
      { type: 'function_call_output', call_id: 'saved-call', output: '결과 �' },
      { type: 'function_call_output', call_id: 'saved-parts', output: [{ type: 'input_text', text: '중첩 �' }] },
      { type: 'message', role: 'assistant', id: 'saved-message', status: 'completed', content: [
        { type: 'output_text', text: '이전 � 답변', annotations: [] },
      ] },
    ]);
    expect(resume).toEqual(original);
  });

  it('repairs every turn while leaving caller messages and queued content unchanged', async () => {
    const input: ChatMessage[] = [{ role: 'user', content: [{ type: 'input_text', text: '질문 \uD83D 😀' }] }];
    const queued: ChatMessage = { role: 'user', content: [{ type: 'input_text', text: '추가 \uDE00 😀' }] };
    const original = structuredClone({ input, queued });
    const { agent, fake } = await fixture(strictUnicodeResponder([
      { name: 'lookup', arguments: { key: 'capital' }, call_id: 'malformed-tool' },
      '완료했다.',
    ]));
    await expect(agent.runAgent({
      instructions: '', input, tools: [{ ...lookup, run: async () => '도구 \uD83D 😀' }],
      beforeTurn: () => [queued],
    })).resolves.toEqual({ text: '완료했다.', toolCalls: 1 });
    expect(fake.requests[0]!.body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: '질문 � 😀' }] },
      { role: 'user', content: [{ type: 'input_text', text: '추가 � 😀' }] },
    ]);
    expect(fake.requests[1]!.body.input).toEqual(expect.arrayContaining([
      { type: 'function_call_output', call_id: 'malformed-tool', output: '도구 � 😀' },
      { role: 'user', content: [{ type: 'input_text', text: '추가 � 😀' }] },
    ]));
    expect({ input, queued }).toEqual(original);
  });

  it('lets the model recover from tool errors and malformed arguments', async () => {
    const { agent, fake } = await fixture([
      { functionCalls: [{ name: 'lookup', arguments: { key: 'missing' }, call_id: 'bad-key' }, { name: 'lookup', arguments: '{', call_id: 'bad-json' }, { name: 'absent', arguments: {}, call_id: 'unknown' }] },
      '근거를 찾지 못했다.',
    ]);
    await expect(agent.runAgent({ instructions: 'Report failures', input: '찾는다', tools: [lookup] }))
      .resolves.toEqual({ text: '근거를 찾지 못했다.', toolCalls: 3 });
    const input = fake.requests[1]!.body.input as Array<{ type: string; call_id?: string; output?: string }>;
    expect(JSON.parse(input.find((item) => item.call_id === 'bad-key' && item.type === 'function_call_output')!.output!)).toEqual({ error: 'Unknown fact' });
    expect(input.filter((item) => item.type === 'function_call_output').every((item) => typeof JSON.parse(item.output!).error === 'string')).toBe(true);
  });

  it('stops an unfinished tool loop at maxTurns', async () => {
    const delta = { inputTokens: 10, cachedInputTokens: 4, outputTokens: 3, reasoningTokens: 1 };
    const { agent, fake } = await fixture([{ functionCalls: [{ name: 'lookup', arguments: { key: 'capital' } }], usage: delta }, 'not reached']);
    const deltas: TokenUsage[] = [];
    await expect(agent.runAgent({
      instructions: '', input: '계속', tools: [lookup], maxTurns: 1, onUsage: (usage) => deltas.push(usage),
    })).rejects.toThrow('maxTurns (1)');
    expect(deltas).toEqual([delta]);
    expect(fake.requests).toHaveLength(1);
  });

  it('fails clearly for missing credentials and honors a pre-aborted signal', async () => {
    const { agent, config, repo, search, log, fake } = await fixture(['not reached']);
    const withoutKey = await createAgent({ ...config, openaiApiKey: undefined }, repo, search, log);
    await expect(withoutKey.runAgent({ instructions: '', input: '', tools: [] })).rejects.toThrow('OPENAI_API_KEY');
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(agent.runAgent({ instructions: '', input: '', tools: [], signal: controller.signal })).rejects.toThrow('cancelled');
    expect(fake.requests).toHaveLength(0);
  });

  it('reloads main writing rules and memory instead of caching context', async () => {
    const notes = { 'AGENTS.md': '작성 규칙이다.', 'MEMORY.md': '첫 메모리다.' };
    const { agent } = await fixture([], notes);
    expect(await agent.baseInstructions()).toContain('첫 메모리다.');
    notes['MEMORY.md'] = '변경된 메모리다.';
    const updated = await agent.baseInstructions();
    expect(updated).toContain('변경된 메모리다.');
    expect(updated).not.toContain('첫 메모리다.');
  });

  it('derives domain hubs and optional schemas from main paths and refreshes them with the notes', async () => {
    const notes: Record<string, string> = {
      'wiki/software/index.md': '# Software',
      'wiki/software/AGENTS.md': 'Software writing rules.',
      'wiki/software/cache.md': '# Cache',
      'wiki/travel/packing.md': '# Packing',
      'wiki/concepts/index.md': '# Concepts',
      'wiki/concepts/cache.md': '# Shared cache',
      'wiki/entities/index.md': '# Entities',
      'wiki/entities/company.md': '# Company',
      'wiki/unclassified.md': '# Legacy note',
      'raw/not-a-domain/source.md': '# Source',
    };
    const { agent, repo } = await fixture([], notes);
    const listFiles = vi.spyOn(repo, 'listFiles');
    const instructions = await agent.baseInstructions();
    const domainLines = instructions.split('\n').filter((line) => line.startsWith('- '));
    expect(listFiles).toHaveBeenCalledWith('wiki/', 'main');
    expect(domainLines).toHaveLength(2);
    expect(domainLines[0]).toContain('software: wiki/software/index.md');
    expect(domainLines[0]).toContain('wiki/software/AGENTS.md');
    expect(domainLines[1]).toMatch(/^- travel: .+\(wiki\/travel\/index\.md\)$/);
    expect(instructions).not.toContain('wiki/travel/AGENTS.md');
    expect(domainLines.join('\n')).not.toMatch(/concepts:|entities:|unclassified|not-a-domain/);

    delete notes['wiki/software/index.md'];
    delete notes['wiki/software/AGENTS.md'];
    delete notes['wiki/software/cache.md'];
    notes['wiki/travel/index.md'] = '# Travel';
    notes['wiki/research/index.md'] = '# Research';
    notes['wiki/research/AGENTS.md'] = 'Research writing rules.';
    const updated = await agent.baseInstructions();
    const updatedDomainLines = updated.split('\n').filter((line) => line.startsWith('- '));
    expect(listFiles).toHaveBeenCalledTimes(2);
    expect(listFiles).toHaveBeenLastCalledWith('wiki/', 'main');
    expect(updatedDomainLines).toHaveLength(2);
    expect(updatedDomainLines[0]).toContain('research: wiki/research/index.md');
    expect(updatedDomainLines[0]).toContain('wiki/research/AGENTS.md');
    expect(updatedDomainLines[1]).toBe('- travel: wiki/travel/index.md');
    expect(updated).not.toContain('wiki/software/');
  });

  it('lists only ACL-readable domains, hubs, and optional schemas', async () => {
    const { agent, acl, admin, viewer } = await aclFixture({
      'wiki/public/index.md': '# Public',
      'wiki/public/AGENTS.md': 'Public rules.',
      'wiki/private/index.md': '# Private',
      'wiki/private/AGENTS.md': 'Private rules.',
      'wiki/partial/index.md': '# Restricted hub',
      'wiki/partial/AGENTS.md': 'Restricted rules.',
      'wiki/partial/readable.md': '# Readable note',
    });
    acl.create({ prefix: 'wiki/private/', subjectType: 'everyone', access: 'none' }, admin);
    acl.create({ prefix: 'wiki/partial/index.md', subjectType: 'everyone', access: 'none' }, admin);
    acl.create({ prefix: 'wiki/partial/AGENTS.md', subjectType: 'everyone', access: 'none' }, admin);

    const instructions = await agent.baseInstructions(viewer);
    const domainLines = instructions.split('\n').filter((line) => line.startsWith('- '));
    expect(domainLines).toHaveLength(2);
    expect(domainLines[0]).toMatch(/^- partial: .+\(wiki\/partial\/index\.md\)$/);
    expect(instructions).not.toContain('wiki/partial/AGENTS.md');
    expect(domainLines[1]).toContain('public: wiki/public/index.md');
    expect(domainLines[1]).toContain('wiki/public/AGENTS.md');
    expect(instructions).not.toContain('wiki/private/');

    const trustedInstructions = await agent.baseInstructions();
    expect(trustedInstructions).toContain('private: wiki/private/index.md');
    expect(trustedInstructions).toContain('wiki/private/AGENTS.md');
    expect(trustedInstructions).toContain('partial: wiki/partial/index.md');
    expect(trustedInstructions).toContain('wiki/partial/AGENTS.md');
  });
});

describe('read-only answers', () => {
  it('streams Korean text and cites only notes actually read and linked', async () => {
    const text = '캐시는 재사용한다. [캐시](wiki/cache.md) [허구](wiki/unread.md)';
    const { agent } = await fixture([
      { name: 'search', arguments: { query: '캐시' } },
      { functionCalls: [{ name: 'read_note', arguments: { path: 'wiki/cache.md' } }, { name: 'read_note', arguments: { path: 'wiki/unused.md' } }, { name: 'read_note', arguments: { path: 'wiki/missing.md' } }] },
      text,
    ], { 'wiki/cache.md': '# 캐시\n결과를 재사용한다.', 'wiki/unused.md': '# 미사용\n다른 근거다.' });
    const deltas: string[] = [];
    const result = await agent.answer([{ role: 'user', content: '캐시란?' }], (delta) => deltas.push(delta));
    expect(result.text).toBe(text);
    expect(result.citations).toEqual([{ path: 'wiki/cache.md', sha: 'test-sha' }]);
    expect(deltas.join('')).toBe(text);
  });

  it('shows a whole-character write summary when the preview ends inside an emoji', async () => {
    const content = 'x'.repeat(79) + '😀' + 'new fact';
    const { agent } = await fixture([
      { name: 'write_knowledge', arguments: { content } },
      '기록을 요청했다.',
    ]);
    const summaries: unknown[] = [];
    const submitted: string[] = [];
    await agent.answer([{ role: 'user', content }], () => {}, undefined, {
      user: { id: 1, role: 'admin' },
      submitKnowledge: async (value) => {
        submitted.push(value);
        return { jobId: job.id, status: 'queued' };
      },
      onEvent: (event, data) => { if (event === 'tool') summaries.push(data); },
    });
    expect(summaries).toEqual([
      { name: 'write_knowledge', state: 'start', summary: 'x'.repeat(79) },
      { name: 'write_knowledge', state: 'end', summary: 'x'.repeat(79), jobId: job.id },
    ]);
    expect(submitted).toEqual([content]);
  });

  it('aborts an in-progress streamed response before executing its tools', async () => {
    const { agent, fake } = await fixture([
      { text: '잠시 확인한다.', functionCalls: [{ name: 'lookup', arguments: { key: 'capital' } }] },
      'not reached',
    ]);
    const controller = new AbortController();
    let toolRuns = 0;
    const tool: AgentTool = { ...lookup, run: async () => { toolRuns++; return '서울'; } };
    await expect(agent.runAgent({
      instructions: '', input: '질문', tools: [tool], signal: controller.signal,
      onTextDelta: () => controller.abort(new Error('stream cancelled')),
    })).rejects.toThrow('stream cancelled');
    expect(toolRuns).toBe(0);
    expect(fake.requests).toHaveLength(1);
  });
});

describe('paged chat note reads', () => {
  it('continues from a 0-based line offset without changing the pinned note revision', async () => {
    const content = '# 첫 제목\n첫째 근거\n# 둘째 제목\n둘째 근거\n';
    const { agent, fake } = await fixture([
      { name: 'read_note', arguments: { path: 'wiki/paged.md', limit: 2 } },
      { name: 'read_note', arguments: { path: 'wiki/paged.md', offset: 2, limit: 2 } },
      '[근거](wiki/paged.md)',
    ], { 'wiki/paged.md': content });
    const result = await agent.answer([{ role: 'user', content: '본문을 확인한다.' }], () => {});
    const outputs = (fake.requests[2]!.body.input as Array<{ type: string; output?: string }>).filter((item) => item.type === 'function_call_output');
    const first = JSON.parse(outputs[0]!.output!);
    const second = JSON.parse(outputs[1]!.output!);
    expect(first).toMatchObject({ path: 'wiki/paged.md', sha: 'test-sha', content: '# 첫 제목\n첫째 근거\n', nextOffset: 2, truncated: true });
    expect(second).toMatchObject({ path: 'wiki/paged.md', sha: 'test-sha', content: '# 둘째 제목\n둘째 근거\n', nextOffset: null, truncated: false });
    expect(first.content + second.content).toBe(content);
    expect(result.citations).toEqual([{ path: 'wiki/paged.md', sha: 'test-sha' }]);
  });

  it('bounds note reads at 300 lines and rejects oversized page requests without losing continuation', async () => {
    const content = 'fact\n'.repeat(301);
    const { agent, fake } = await fixture([
      { name: 'read_note', arguments: { path: 'wiki/boundary.md' }, call_id: 'first' },
      { functionCalls: [
        { name: 'read_note', arguments: { path: 'wiki/boundary.md', limit: 301 }, call_id: 'oversized' },
        { name: 'read_note', arguments: { path: 'wiki/boundary.md', offset: 300, limit: 300 }, call_id: 'tail' },
      ] },
      '[근거](wiki/boundary.md)',
    ], { 'wiki/boundary.md': content });
    const result = await agent.answer([{ role: 'user', content: '모든 근거를 읽는다.' }], () => {});
    const outputs = (fake.requests[2]!.body.input as Array<{ type: string; call_id?: string; output?: string }>)
      .filter((item) => item.type === 'function_call_output');
    const first = JSON.parse(outputs.find((item) => item.call_id === 'first')!.output!);
    const tail = JSON.parse(outputs.find((item) => item.call_id === 'tail')!.output!);
    expect(first).toMatchObject({ content: 'fact\n'.repeat(300), totalLines: 301, nextOffset: 300, truncated: true });
    expect(tail).toMatchObject({ content: 'fact\n', nextOffset: null, truncated: false });
    expect(first.content + tail.content).toBe(content);
    expect(JSON.parse(outputs.find((item) => item.call_id === 'oversized')!.output!)).toMatchObject({ error: expect.any(String) });
    expect(result.citations).toEqual([{ path: 'wiki/boundary.md', sha: 'test-sha' }]);
  });
});

describe('worktree writing and conflicts', () => {
  it('writes and commits a note in a real temporary git worktree through tools', async () => {
    const content = '---\ntags: [caching]\n---\n# 캐시\n캐시는 계산 결과를 재사용하는 기법이다.\n';
    const { agent: unused, fake, config, search, log } = await fixture([
      { name: 'search', arguments: { query: '캐시' } },
      { name: 'write_file', arguments: { path: 'wiki/cache.md', content } },
      { name: 'write_file', arguments: { path: 'index.md', content: '# 지식 색인\n\n- [[wiki/cache|캐시]]\n' } },
      { name: 'commit', arguments: { message: '캐시 개념과 진입점을 기록한다' } },
      '캐시 노트를 만들고 색인에 연결했다.',
    ]);
    void unused;
    const directory = await mkdtemp(join(tmpdir(), 'agent-write-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const repo = await KnowledgeRepo.open({ ...config, dataDir: directory }, log);
    const wt = await repo.createWorktree('agent-test');
    cleanup.push(() => wt.dispose());
    const agent = await createAgent(config, repo, search, log);
    await expect(agent.runWrite(job, wt, { name: 'Tester', email: 'test@example.com' })).resolves.toEqual({ summary: '캐시 노트를 만들고 색인에 연결했다.' });
    expect(await wt.read('wiki/cache.md')).toBe(content);
    await repo.withMergeLock(() => wt.fastForwardMain());
    expect(await repo.readFile('wiki/cache.md')).toBe(content);
    const commits = await repo.log({ limit: 1 });
    expect(commits[0]).toMatchObject({ authorName: 'Tester', authorEmail: 'test@example.com', subject: '캐시 개념과 진입점을 기록한다' });
    const nextInput = fake.requests[4]!.body.input as Array<{ type: string; output?: string }>;
    expect(nextInput.filter((item) => item.type === 'function_call_output').some((item) => item.output?.includes('error'))).toBe(false);
  });

  it('retries once and rejects unresolved conflict markers', async () => {
    const conflicted = '<<<<<<< HEAD\n워크 변경이다.\n=======\nmain 변경이다.\n>>>>>>> main\n';
    const first: TokenUsage = { inputTokens: 40, cachedInputTokens: 20, outputTokens: 7, reasoningTokens: 3 };
    const second: TokenUsage = { inputTokens: 60, cachedInputTokens: 30, outputTokens: 9, reasoningTokens: 4 };
    const { agent, fake } = await fixture([
      { text: '해결했다.', usage: first },
      { text: '해결했다.', usage: second },
    ], { 'wiki/conflict.md': 'main 변경이다.' });
    // Conflict resolution only needs these Worktree methods; no other slice is initialized.
    const wt = { branch: 'work/test', baseSha: 'base', read: async () => conflicted, write: async () => {}, list: async () => ['wiki/conflict.md'] } as unknown as Worktree;
    const deltas: TokenUsage[] = [];
    await expect(agent.resolveConflicts(wt, ['wiki/conflict.md'], undefined, { onUsage: (usage) => deltas.push(usage) })).rejects.toThrow(/conflict|충돌|marker/i);
    expect(deltas).toEqual([first, second]);
    expect(fake.requests).toHaveLength(2);
  });

  it('accepts a marker-free resolution preserving both sides through write_file', async () => {
    let content = '<<<<<<< HEAD\n워크 변경이다.\n=======\nmain 변경이다.\n>>>>>>> main\n';
    const { agent } = await fixture([{ name: 'write_file', arguments: { path: 'wiki/conflict.md', content: '워크 변경과 main 변경을 함께 반영한다.\n' } }, '두 변경을 반영했다.'], { 'wiki/conflict.md': 'main 변경이다.' });
    const wt = { branch: 'work/test', baseSha: 'base', read: async () => content, write: async (_path: string, value: string) => { content = value; }, list: async () => ['wiki/conflict.md'] } as unknown as Worktree;
    await agent.resolveConflicts(wt, ['wiki/conflict.md']);
    expect(content).toBe('워크 변경과 main 변경을 함께 반영한다.\n');
  });

  it('rejects reads and writes outside the current conflict files at runtime', async () => {
    let content = '<<<<<<< HEAD\nwork\n=======\nmain\n>>>>>>> main\n';
    const accesses: string[] = [];
    const { agent, fake } = await fixture([
      { name: 'read_file', arguments: { path: 'wiki/private.md' } },
      { name: 'write_file', arguments: { path: 'wiki/private.md', content: 'unauthorized' } },
      { name: 'write_file', arguments: { path: 'wiki/conflict.md', content: 'work and main\n' } },
      '두 변경을 반영했다.',
    ], { 'wiki/conflict.md': 'main' });
    const wt = {
      branch: 'work/test', baseSha: 'base',
      read: async (path: string) => { accesses.push(path); return content; },
      write: async (path: string, value: string) => { accesses.push(path); content = value; },
    } as unknown as Worktree;
    await agent.resolveConflicts(wt, ['wiki/conflict.md']);
    expect(accesses.every((path) => path === 'wiki/conflict.md')).toBe(true);
    expect(content).toBe('work and main\n');
    const input = fake.requests[2]!.body.input as Array<{ type?: string; output?: string }>;
    const errors = input.filter((item) => item.type === 'function_call_output').map((item) => JSON.parse(item.output!));
    expect(errors).toEqual([
      { error: expect.stringContaining('Only the listed conflict files may be accessed') },
      { error: expect.stringContaining('Only the listed conflict files may be accessed') },
    ]);
  });

  it('keeps revision snapshots across retries and resolves tail knowledge through the local model tool loop', async () => {
    const path = 'wiki/conflict.md';
    const prefix = 'kept fact\n'.repeat(300);
    const revisions: Record<string, string> = {
      base: prefix + 'base tail knowledge\n',
      'work/test': prefix + 'base tail knowledge\nwork tail knowledge\n',
      main: prefix + 'base tail knowledge\nmain tail knowledge\n',
    };
    let content = prefix + '<<<<<<< HEAD\nwork tail knowledge\n=======\nmain tail knowledge\n>>>>>>> main\n';
    const reads: string[] = [];
    const { agent, repo, fake } = await fixture((request, index) => {
      const input = request.body.input as Array<{ content?: string; type?: string; output?: string }>;
      if (index < 2) {
        const file = JSON.parse(input[0]!.content!).files[0];
        for (const version of ['base', 'workBranch', 'main', 'conflicted']) {
          expect(file[version]).toMatchObject({ content: prefix, nextOffset: 300, truncated: true });
        }
        if (index === 0) {
          for (const ref of Object.keys(revisions)) revisions[ref] = 'changed after snapshot\n';
          return '아직 충돌을 해결하지 못했다.';
        }
        return { functionCalls: [
          ...['base', 'workBranch', 'main'].map((version) => ({ name: 'read_conflict_version', arguments: { path, version, offset: 300 }, call_id: version })),
          { name: 'read_file', arguments: { path, offset: 300 }, call_id: 'conflicted' },
        ] };
      }
      if (index === 2) {
        const outputs = new Map(input.filter((item) => item.type === 'function_call_output')
          .map((item) => {
            const page = JSON.parse(item.output!);
            return [page.version ?? 'conflicted', page.content] as const;
          }));
        expect(outputs.get('base')).toBe('base tail knowledge\n');
        expect(outputs.get('workBranch')).toBe('base tail knowledge\nwork tail knowledge\n');
        expect(outputs.get('main')).toBe('base tail knowledge\nmain tail knowledge\n');
        expect(outputs.get('conflicted')).toContain('<<<<<<< HEAD');
        return { name: 'write_file', arguments: {
          path, content: prefix + outputs.get('workBranch') + (outputs.get('main') as string).replace('base tail knowledge\n', ''),
        } };
      }
      return '양쪽의 꼬리 지식을 보존했다.';
    });
    repo.readFile = async (readPath, ref = 'main') => {
      if (readPath !== path) return null;
      reads.push(ref);
      return revisions[ref] ?? null;
    };
    const wt = {
      branch: 'work/test', baseSha: 'base', read: async () => content,
      write: async (_path: string, value: string) => { content = value; },
    } as unknown as Worktree;
    await agent.resolveConflicts(wt, [path]);
    expect(reads.sort()).toEqual(['base', 'main', 'work/test']);
    expect(fake.requests).toHaveLength(4);
    expect(content).toBe(prefix + 'base tail knowledge\nwork tail knowledge\nmain tail knowledge\n');
  });
});
