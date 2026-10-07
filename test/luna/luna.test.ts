import { Test } from '@nestjs/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino, { type Logger } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../../src/config.js';
import { CONFIG, LOGGER } from '../../src/common/tokens.js';
import { KnowledgeRepo, type Worktree } from '../../src/knowledge/repo.js';
import { SearchService } from '../../src/rag/search.service.js';
import type { WriteJob } from '../../src/jobs/write-job.types.js';
import { startFakeOpenAI, type FakeScript } from '../fake-openai.js';
import { LunaService } from '../../src/luna/luna.service.js';
import type { AgentTool } from '../../src/luna/luna.types.js';
import { AclService } from '../../src/acl/acl.service.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { UsersService } from '../../src/auth/users.service.js';
import { UsersRepository } from '../../src/auth/users.repository.js';
import { openDb, runMigrations } from '../../src/db/index.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function createLuna(
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
      LunaService,
      { provide: CONFIG, useValue: config },
      { provide: LOGGER, useValue: log },
      { provide: KnowledgeRepo, useValue: repo },
      { provide: SearchService, useValue: search },
      { provide: AclService, useValue: acl },
    ],
  }).compile();
  await module.init();
  cleanup.push(() => module.close());
  return module.get(LunaService);
}

async function fixture(script: FakeScript, notes: Record<string, string> = {}) {
  const fake = await startFakeOpenAI(script);
  cleanup.push(() => fake.close());
  const config = loadConfig({ NODE_ENV: 'test', OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: fake.url });
  // Keep model and git dependencies controllable while resolving the real Nest service.
  const repo = { readFile: async (path: string) => notes[path] ?? null, headSha: async () => 'test-sha', log: async () => [] } as unknown as KnowledgeRepo;
  const search = { search: async () => [{ path: 'wiki/cache.md', title: '캐시', snippet: '근거', score: 1, heading: '', kind: 'wiki', related: [] }] } as unknown as SearchService;
  const log = pino({ level: 'silent' });
  return { luna: await createLuna(config, repo, search, log), fake, config, repo, search, log };
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
  id: 'test-write', userId: 1, source: 'mcp', input: '캐시의 정의를 정리한다.', status: 'running', summary: null,
  kind: 'luna', client: null, conflicts: [],
  commits: [], mergeSha: null, error: null, createdAt: '2026-10-07T00:00:00.000Z', startedAt: null, finishedAt: null,
};

describe('Luna Responses tool loop', () => {
  it('returns a fact after a function-call round trip', async () => {
    const { luna, fake } = await fixture([{ name: 'lookup', arguments: { key: 'capital' }, call_id: 'fact' }, '수도는 서울이다.']);
    await expect(luna.runAgent({ instructions: 'Answer from facts', input: '수도는?', tools: [lookup] }))
      .resolves.toEqual({ text: '수도는 서울이다.', toolCalls: 1 });
    expect(fake.requests[1]!.body.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function_call_output', call_id: 'fact', output: '서울' }),
    ]));
  });

  it('lets the model recover from tool errors and malformed arguments', async () => {
    const { luna, fake } = await fixture([
      { functionCalls: [{ name: 'lookup', arguments: { key: 'missing' }, call_id: 'bad-key' }, { name: 'lookup', arguments: '{', call_id: 'bad-json' }, { name: 'absent', arguments: {}, call_id: 'unknown' }] },
      '근거를 찾지 못했다.',
    ]);
    await expect(luna.runAgent({ instructions: 'Report failures', input: '찾는다', tools: [lookup] }))
      .resolves.toEqual({ text: '근거를 찾지 못했다.', toolCalls: 3 });
    const input = fake.requests[1]!.body.input as Array<{ type: string; call_id?: string; output?: string }>;
    expect(JSON.parse(input.find((item) => item.call_id === 'bad-key' && item.type === 'function_call_output')!.output!)).toEqual({ error: 'Unknown fact' });
    expect(input.filter((item) => item.type === 'function_call_output').every((item) => typeof JSON.parse(item.output!).error === 'string')).toBe(true);
  });

  it('stops an unfinished tool loop at maxTurns', async () => {
    const { luna, fake } = await fixture([{ name: 'lookup', arguments: { key: 'capital' } }, 'not reached']);
    await expect(luna.runAgent({ instructions: '', input: '계속', tools: [lookup], maxTurns: 1 })).rejects.toThrow('maxTurns (1)');
    expect(fake.requests).toHaveLength(1);
  });

  it('fails clearly for missing credentials and honors a pre-aborted signal', async () => {
    const { luna, config, repo, search, log, fake } = await fixture(['not reached']);
    const withoutKey = await createLuna({ ...config, openaiApiKey: undefined }, repo, search, log);
    await expect(withoutKey.runAgent({ instructions: '', input: '', tools: [] })).rejects.toThrow('OPENAI_API_KEY');
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(luna.runAgent({ instructions: '', input: '', tools: [], signal: controller.signal })).rejects.toThrow('cancelled');
    expect(fake.requests).toHaveLength(0);
  });

  it('reloads main writing rules and memory instead of caching context', async () => {
    const notes = { 'AGENTS.md': '작성 규칙이다.', 'MEMORY.md': '첫 메모리다.' };
    const { luna } = await fixture([], notes);
    expect(await luna.baseInstructions()).toContain('첫 메모리다.');
    notes['MEMORY.md'] = '변경된 메모리다.';
    const updated = await luna.baseInstructions();
    expect(updated).toContain('변경된 메모리다.');
    expect(updated).not.toContain('첫 메모리다.');
  });
});

describe('read-only answers', () => {
  it('streams Korean text and cites only notes actually read and linked', async () => {
    const text = '캐시는 재사용한다. [캐시](wiki/cache.md) [허구](wiki/unread.md)';
    const { luna } = await fixture([
      { name: 'search', arguments: { query: '캐시' } },
      { functionCalls: [{ name: 'read_note', arguments: { path: 'wiki/cache.md' } }, { name: 'read_note', arguments: { path: 'wiki/unused.md' } }, { name: 'read_note', arguments: { path: 'wiki/missing.md' } }] },
      text,
    ], { 'wiki/cache.md': '# 캐시\n결과를 재사용한다.', 'wiki/unused.md': '# 미사용\n다른 근거다.' });
    const deltas: string[] = [];
    const result = await luna.answer([{ role: 'user', content: '캐시란?' }], (delta) => deltas.push(delta));
    expect(result.text).toBe(text);
    expect(result.citations).toEqual([{ path: 'wiki/cache.md', sha: 'test-sha' }]);
    expect(deltas.join('')).toBe(text);
  });

  it('aborts an in-progress streamed response before executing its tools', async () => {
    const { luna, fake } = await fixture([
      { text: '잠시 확인한다.', functionCalls: [{ name: 'lookup', arguments: { key: 'capital' } }] },
      'not reached',
    ]);
    const controller = new AbortController();
    let toolRuns = 0;
    const tool: AgentTool = { ...lookup, run: async () => { toolRuns++; return '서울'; } };
    await expect(luna.runAgent({
      instructions: '', input: '질문', tools: [tool], signal: controller.signal,
      onTextDelta: () => controller.abort(new Error('stream cancelled')),
    })).rejects.toThrow('stream cancelled');
    expect(toolRuns).toBe(0);
    expect(fake.requests).toHaveLength(1);
  });
});

describe('worktree writing and conflicts', () => {
  it('writes and commits a note in a real temporary git worktree through tools', async () => {
    const content = '---\ntags: [caching]\n---\n# 캐시\n캐시는 계산 결과를 재사용하는 기법이다.\n';
    const { luna: unused, fake, config, search, log } = await fixture([
      { name: 'search', arguments: { query: '캐시' } },
      { name: 'write_file', arguments: { path: 'wiki/cache.md', content } },
      { name: 'write_file', arguments: { path: 'index.md', content: '# 지식 색인\n\n- [[wiki/cache|캐시]]\n' } },
      { name: 'commit', arguments: { message: '캐시 개념과 진입점을 기록한다' } },
      '캐시 노트를 만들고 색인에 연결했다.',
    ]);
    void unused;
    const directory = await mkdtemp(join(tmpdir(), 'luna-write-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const repo = await KnowledgeRepo.open({ ...config, dataDir: directory }, log);
    const wt = await repo.createWorktree('luna-test');
    cleanup.push(() => wt.dispose());
    const luna = await createLuna(config, repo, search, log);
    await expect(luna.runWrite(job, wt, { name: 'Tester', email: 'test@example.com' })).resolves.toEqual({ summary: '캐시 노트를 만들고 색인에 연결했다.' });
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
    const { luna, fake } = await fixture(['해결했다.', '해결했다.'], { 'wiki/conflict.md': 'main 변경이다.' });
    // Conflict resolution only needs these Worktree methods; no other slice is initialized.
    const wt = { branch: 'work/test', baseSha: 'base', read: async () => conflicted, write: async () => {}, list: async () => ['wiki/conflict.md'] } as unknown as Worktree;
    await expect(luna.resolveConflicts(wt, ['wiki/conflict.md'])).rejects.toThrow(/conflict|충돌|marker/i);
    expect(fake.requests).toHaveLength(2);
  });

  it('accepts a marker-free resolution preserving both sides through write_file', async () => {
    let content = '<<<<<<< HEAD\n워크 변경이다.\n=======\nmain 변경이다.\n>>>>>>> main\n';
    const { luna } = await fixture([{ name: 'write_file', arguments: { path: 'wiki/conflict.md', content: '워크 변경과 main 변경을 함께 반영한다.\n' } }, '두 변경을 반영했다.'], { 'wiki/conflict.md': 'main 변경이다.' });
    const wt = { branch: 'work/test', baseSha: 'base', read: async () => content, write: async (_path: string, value: string) => { content = value; }, list: async () => ['wiki/conflict.md'] } as unknown as Worktree;
    await luna.resolveConflicts(wt, ['wiki/conflict.md']);
    expect(content).toBe('워크 변경과 main 변경을 함께 반영한다.\n');
  });
});
