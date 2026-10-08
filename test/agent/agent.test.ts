import { Test } from '@nestjs/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino, { type Logger } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../../src/config.js';
import { CONFIG, LOGGER } from '../../src/common/tokens.js';
import { newId } from '../../src/common/ids.js';
import { KnowledgeRepo, type Worktree } from '../../src/knowledge/repo.js';
import { SearchService } from '../../src/rag/search.service.js';
import type { WriteJob } from '../../src/jobs/write-job.types.js';
import { startFakeOpenAI, type FakeScript } from '../fake-openai.js';
import { AgentService } from '../../src/agent/agent.service.js';
import type { AgentCheckpoint, AgentTool } from '../../src/agent/agent.types.js';
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
) {
  const db = openDb(':memory:');
  runMigrations(db);
  cleanup.push(async () => db.close());
  const acl = new AclService(db, new UsersService(new UsersRepository(db)), new AuditService(db));
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

async function fixture(script: FakeScript, notes: Record<string, string> = {}) {
  const fake = await startFakeOpenAI(script);
  cleanup.push(() => fake.close());
  const config = loadConfig({ NODE_ENV: 'test', OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: fake.url });
  // Keep model and git dependencies controllable while resolving the real Nest service.
  const repo = { readFile: async (path: string) => notes[path] ?? null, headSha: async () => 'test-sha', log: async () => [] } as unknown as KnowledgeRepo;
  const search = { search: async () => [{ path: 'wiki/cache.md', title: '캐시', snippet: '근거', score: 1, heading: '', kind: 'wiki', related: [] }] } as unknown as SearchService;
  const log = pino({ level: 'silent' });
  return { agent: await createAgent(config, repo, search, log), fake, config, repo, search, log };
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
    await expect(agent.runAgent({
      instructions: '', input: '무시할 입력', resume, tools: [lookup], maxTurns: 2,
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
      usage: { inputTokens: 25, outputTokens: 14, reasoningTokens: 5 },
    }]);
    expect(usage).toEqual({ inputTokens: 31, outputTokens: 17, reasoningTokens: 6 });
  });

  it('caps oversized tool results and errors with actionable truncation markers', async () => {
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
      expect(item.output!.length).toBeLessThanOrEqual(40000);
      expect(item.output).toMatch(/truncated/i);
      expect(item.output).toMatch(/pag(e|ing)|narrow/i);
    }
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
    const { agent, fake } = await fixture([{ name: 'lookup', arguments: { key: 'capital' } }, 'not reached']);
    await expect(agent.runAgent({ instructions: '', input: '계속', tools: [lookup], maxTurns: 1 })).rejects.toThrow('maxTurns (1)');
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
    const { agent, fake } = await fixture(['해결했다.', '해결했다.'], { 'wiki/conflict.md': 'main 변경이다.' });
    // Conflict resolution only needs these Worktree methods; no other slice is initialized.
    const wt = { branch: 'work/test', baseSha: 'base', read: async () => conflicted, write: async () => {}, list: async () => ['wiki/conflict.md'] } as unknown as Worktree;
    await expect(agent.resolveConflicts(wt, ['wiki/conflict.md'])).rejects.toThrow(/conflict|충돌|marker/i);
    expect(fake.requests).toHaveLength(2);
  });

  it('accepts a marker-free resolution preserving both sides through write_file', async () => {
    let content = '<<<<<<< HEAD\n워크 변경이다.\n=======\nmain 변경이다.\n>>>>>>> main\n';
    const { agent } = await fixture([{ name: 'write_file', arguments: { path: 'wiki/conflict.md', content: '워크 변경과 main 변경을 함께 반영한다.\n' } }, '두 변경을 반영했다.'], { 'wiki/conflict.md': 'main 변경이다.' });
    const wt = { branch: 'work/test', baseSha: 'base', read: async () => content, write: async (_path: string, value: string) => { content = value; }, list: async () => ['wiki/conflict.md'] } as unknown as Worktree;
    await agent.resolveConflicts(wt, ['wiki/conflict.md']);
    expect(content).toBe('워크 변경과 main 변경을 함께 반영한다.\n');
  });
});
