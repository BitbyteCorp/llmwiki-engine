import { Test } from '@nestjs/testing';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import pino from 'pino';
import matter from 'gray-matter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentService } from '../../src/agent/agent.service.js';
import type { AgentCheckpoint, AgentTool, TokenUsage } from '../../src/agent/agent.types.js';
import { SubagentPool, type SubagentSnapshot } from '../../src/agent/subagents.js';
import { AclService } from '../../src/acl/acl.service.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { UsersService } from '../../src/auth/users.service.js';
import { UsersRepository } from '../../src/auth/users.repository.js';
import { CONFIG, LOGGER } from '../../src/common/tokens.js';
import { apiIdToLegacyUuid, newId } from '../../src/common/ids.js';
import { loadConfig } from '../../src/config.js';
import { openDb, runMigrations } from '../../src/db/index.js';
import type { WriteJob } from '../../src/jobs/write-job.types.js';
import { KnowledgeRepo } from '../../src/knowledge/repo.js';
import { SearchService } from '../../src/rag/search.service.js';
import { startFakeOpenAI, type FakeTurn } from '../fake-openai.js';

const cleanup: Array<() => Promise<unknown>> = [];
const releaseGates: Array<() => void> = [];
afterEach(async () => {
  for (const release of releaseGates.splice(0)) release();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.useRealTimers();
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  releaseGates.push(resolve);
  return { promise, resolve };
}

type InputItem = { role?: string; content?: string; type?: string; call_id?: string; output?: string };
type RequestBody = { input: InputItem[]; stream: boolean; tools: Array<{ name: string }> };
type Initial = { id?: string; name?: string; task?: string; files?: string[]; sources?: string[]; jobId?: string };
type Call = { name: string; arguments: Record<string, unknown>; call_id: string };
type Reply = FakeTurn | Call[];
type Route = (initial: Initial, turn: number, body: RequestBody) => Reply | Promise<Reply>;

function call(name: string, args: Record<string, unknown>, callId = name): Call {
  return { name, arguments: args, call_id: callId };
}

function output(body: RequestBody, callId: string): Record<string, unknown> {
  const item = body.input.find((entry) => entry.type === 'function_call_output' && entry.call_id === callId);
  if (!item?.output) throw new Error(`Missing output for ${callId}`);
  return JSON.parse(item.output) as Record<string, unknown>;
}

// Conversations are routed by their initial user input rather than request arrival order:
// independent child loops must genuinely overlap, including while one HTTP response is held.
async function fixture(route: Route, embeddingUrl?: string) {
  const requests: Array<{ initial: Initial; turn: number; body: RequestBody }> = [];
  const turns = new Map<string, number>();
  const fake = await startFakeOpenAI(async (request) => {
    const body = request.body as unknown as RequestBody;
    if (body.stream !== false) throw new Error('Expected nonstream Responses request');
    const initial = JSON.parse(body.input[0]!.content!) as Initial;
    const key = initial.id ?? initial.jobId!;
    const turn = turns.get(key) ?? 0;
    turns.set(key, turn + 1);
    requests.push({ initial, turn, body });
    const reply = await route(initial, turn, body);
    return Array.isArray(reply) ? { functionCalls: reply } : reply;
  });
  cleanup.push(() => fake.close());
  const directory = await mkdtemp(join(tmpdir(), 'subagent-write-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const config = loadConfig({ NODE_ENV: 'test', OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: fake.url });
  const log = pino({ level: 'silent' });
  const repo = await KnowledgeRepo.open({ ...config, dataDir: directory }, log);
  const wt = await repo.createWorktree('subagent-test');
  cleanup.push(() => wt.dispose());
  const db = openDb(':memory:');
  runMigrations(db);
  cleanup.push(async () => db.close());
  const users = new UsersService(new UsersRepository(db));
  const acl = new AclService(db, users, new AuditService(db));
  let search = { search: async () => [] } as unknown as SearchService;
  if (embeddingUrl) {
    db.exec('CREATE VIRTUAL TABLE chunk_vectors USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[2])');
    const meta = db.prepare('INSERT INTO index_meta(key,value) VALUES (?,?)');
    meta.run('embedding_model', config.embeddingModel);
    meta.run('embedding_dimensions', '2');
    search = new SearchService({ ...config, openaiBaseUrl: embeddingUrl, embeddingDimensions: 2 }, db, log, acl);
  }
  const module = await Test.createTestingModule({
    providers: [
      AgentService,
      { provide: CONFIG, useValue: config }, { provide: LOGGER, useValue: log },
      { provide: KnowledgeRepo, useValue: repo }, { provide: SearchService, useValue: search },
      { provide: AclService, useValue: acl },
    ],
  }).compile();
  await module.init();
  cleanup.push(() => module.close());
  const agent = module.get(AgentService);
  const author = { name: 'Tester', email: 'test@example.com' };
  const changes: SubagentSnapshot[] = [];
  const tools = agent.worktreeTools(wt, author);
  function makePool(customTools = tools) {
    const pool = new SubagentPool({
      agent, instructions: 'Write only the delegated notes.', tools: customTools, wt,
      validateSource: async (path) => { if (!await wt.hasFile(path)) throw new Error(`Source file not found: ${path}`); },
      onChange: (snapshot) => changes.push(snapshot),
    });
    cleanup.push(() => pool.close());
    return pool;
  }
  return { agent, repo, wt, author, tools, requests, changes, makePool, acl, users };
}

async function invoke<T = Record<string, unknown>>(tools: AgentTool[], name: string, args: Record<string, unknown>): Promise<T> {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Missing public tool ${name}`);
  return JSON.parse(await tool.run(args)) as T;
}

type Spawned = { id: string; name: string; status: 'running' };
type Waited = { settled: SubagentSnapshot[]; running: SubagentSnapshot[]; timedOut: boolean };
async function spawn(pool: SubagentPool, name: string, files = [`wiki/${name}.md`]) {
  return invoke<Spawned>(pool.tools(), 'spawn_subagent', { name, task: `Write ${name}`, files });
}
function waitFor(pool: SubagentPool, ids?: string[], mode = 'all', timeoutSeconds = 5) {
  return invoke<Waited>(pool.tools(), 'wait_subagents', { ...(ids ? { ids } : {}), mode, timeoutSeconds });
}

const job: WriteJob = {
  id: newId(), userId: 1, source: 'mcp', input: '두 독립 노트를 기록한다.', status: 'running', summary: null,
  kind: 'agent', client: null, conflicts: [], commits: [], mergeSha: null, error: null,
  createdAt: '2026-10-07T00:00:00.000Z', startedAt: null, finishedAt: null,
};

describe('subagent lifecycle failure containment', () => {
  it.each(['completed', 'cancelled'] as const)('keeps %s callback failures inspectable without rejecting background completion', async (outcome) => {
    const finished = gate();
    const errors: unknown[] = [];
    const pool = new SubagentPool({
      agent: { runAgent: async () => { await finished.promise; return { text: 'Child result', toolCalls: 0 }; } } as unknown as AgentService,
      instructions: '', tools: [], wt: { path: tmpdir() },
      log: { error: (error: unknown) => { errors.push(error); } } as unknown as pino.Logger,
      onChange: (snapshot) => { if (snapshot.status !== 'running') throw new Error('SQLite addEvent failed'); },
    });
    cleanup.push(() => pool.close());
    const child = await spawn(pool, 'terminal-failure');
    const cancellation = outcome === 'cancelled' ? invoke(pool.tools(), 'cancel_subagent', { id: child.id }) : undefined;
    const status = outcome === 'cancelled' ? 'cancelled' : 'failed';
    const waiting = waitFor(pool, [child.id]);
    finished.resolve();
    await expect(waiting).resolves.toMatchObject({
      running: [], timedOut: false,
      settled: [{ id: child.id, status, error: expect.stringContaining('SQLite addEvent failed'), finishedAt: expect.any(String) }],
    });
    if (cancellation) await expect(cancellation).resolves.toMatchObject({ status, error: expect.stringContaining('SQLite addEvent failed') });
    await setImmediate();
    await expect(pool.close()).resolves.toBeUndefined();
    expect(await invoke(pool.tools(), 'subagent_status', { id: child.id })).toMatchObject({
      subagents: [{ id: child.id, status, error: expect.stringContaining('SQLite addEvent failed') }],
    });
    expect(errors).toHaveLength(1);
  });

  it.each(['result', 'error', 'callback'] as const)('bounds oversized child %s in persisted events and status responses', async (outcome) => {
    const oversized = 'A grounded finding. '.repeat(1000);
    const changes: SubagentSnapshot[] = [];
    const pool = new SubagentPool({
      agent: {
        runAgent: async () => {
          if (outcome === 'error') throw new Error(oversized);
          return { text: oversized, toolCalls: 0 };
        },
      } as unknown as AgentService,
      instructions: '', tools: [], wt: { path: tmpdir() },
      log: { error: () => {} } as unknown as pino.Logger,
      onChange: (snapshot) => {
        if (outcome === 'callback' && snapshot.status !== 'running') throw new Error(oversized);
        changes.push(snapshot);
      },
    });
    cleanup.push(() => pool.close());
    const child = await spawn(pool, `large-${outcome}`);
    const settled = (await waitFor(pool, [child.id])).settled[0];
    const field = outcome === 'result' ? 'result' : 'error';
    expect(settled[field]?.length).toBe(8000);
    expect(settled[field]).toContain('truncated');
    expect(settled[field]).toContain('paging or narrower queries');
    const status = await invoke<{ subagents: SubagentSnapshot[] }>(pool.tools(), 'subagent_status', { id: child.id });
    expect(status.subagents[0][field]).toBe(settled[field]);
    if (outcome !== 'callback') expect(changes.at(-1)?.[field]).toBe(settled[field]);
  });
});

describe('subagent source assignments', () => {
  it('normalizes and deduplicates read paths without making shared sources exclusive', async () => {
    const entered = [gate(), gate()];
    const release = gate();
    const { wt, requests, makePool } = await fixture(async (initial) => {
      entered[initial.name === 'first' ? 0 : 1].resolve();
      await release.promise;
      return '공유 원문을 검토했다.';
    });
    const nfd = 'raw/한글.md'.normalize('NFD');
    await wt.write(nfd, '공유 원문이다.\n');
    const pool = makePool();
    for (const name of ['first', 'second']) {
      await invoke(pool.tools(), 'spawn_subagent', {
        name, task: 'Read the same source', files: [`wiki/${name}.md`],
        sources: [`./raw//${nfd.slice(4)}`, nfd],
      });
    }
    await Promise.all(entered.map((entry) => entry.promise));
    expect(requests.map(({ initial }) => initial.sources)).toEqual([[nfd], [nfd]]);
    release.resolve();
    expect((await waitFor(pool)).settled.map((child) => child.sources)).toEqual([[nfd], [nfd]]);
  });
});

describe('write subagent pool', () => {
  it('runs disjoint children concurrently, rejects overlaps and protects parent mutations until completion', async () => {
    const firstStarted = gate();
    const secondStarted = gate();
    const release = gate();
    const { wt, changes, makePool } = await fixture(async (initial, turn) => {
      if (turn === 0) {
        (initial.name === 'first' ? firstStarted : secondStarted).resolve();
        await release.promise;
        const path = initial.name === 'first' ? 'wiki/first.md' : 'wiki/second/nested.md';
        return [call('write_file', { path, content: `# ${initial.name}\nChild content.\n` })];
      }
      return `${initial.name} finished`;
    });
    const pool = makePool();
    const first = await spawn(pool, 'first');
    await expect(spawn(pool, 'overlap', ['wiki/first.md'])).rejects.toThrow(/overlap/i);
    const second = await spawn(pool, 'second', ['wiki/second/nested.md']);
    await Promise.all([firstStarted.promise, secondStarted.promise]);
    const parent = pool.parentTools();
    await wt.write('wiki/outside.md', 'Original outside.\n');
    for (const [name, args] of [
      ['write_file', { path: 'wiki/first.md', content: 'Parent collision.' }],
      ['delete_file', { path: 'wiki/first.md' }],
      ['move_file', { from: 'wiki/first.md', to: 'wiki/free.md' }],
      ['move_file', { from: 'wiki/outside.md', to: 'wiki/second/nested.md' }],
    ] as const) await expect(invoke(parent, name, args)).rejects.toThrow(/claimed/i);
    await expect(invoke(parent, 'commit', { message: 'Too soon' })).rejects.toThrow(/running|wait/i);
    await invoke(parent, 'write_file', { path: 'wiki/second-sibling.md', content: 'Unclaimed parent note.\n' });
    release.resolve();
    const result = await waitFor(pool, [apiIdToLegacyUuid(first.id)!, second.id]);
    expect(result).toMatchObject({ timedOut: false, running: [] });
    expect(result.settled).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, status: 'completed', result: 'first finished', toolCalls: 1 }),
      expect.objectContaining({ id: second.id, status: 'completed', result: 'second finished', toolCalls: 1 }),
    ]));
    expect(await wt.read('wiki/first.md')).toBe('# first\nChild content.\n');
    expect(await wt.read('wiki/second/nested.md')).toBe('# second\nChild content.\n');
    expect(await wt.read('wiki/outside.md')).toBe('Original outside.\n');
    await invoke(parent, 'write_file', { path: 'wiki/first.md', content: 'Reviewed by parent.\n' });
    const commit = await invoke(parent, 'commit', { message: 'Review independent notes' });
    expect(commit.sha).toEqual(expect.any(String));
    for (const child of [first, second]) {
      const lifecycle = changes.filter((entry) => entry.id === child.id);
      expect(lifecycle[0]).toMatchObject({ status: 'running', toolCalls: 0, startedAt: expect.any(String) });
      expect(lifecycle.at(-1)).toMatchObject({ status: 'completed', finishedAt: expect.any(String), toolCalls: 1 });
      expect(lifecycle[0]!.status).toBe('running');
    }
  });

  it('confines child mutations and never lets a child commit or delegate', async () => {
    const { wt, requests, makePool } = await fixture((_initial, turn) => turn === 0 ? [
      call('commit', { message: 'Forbidden child commit' }, 'commit'),
      call('spawn_subagent', { name: 'grandchild', task: 'Escape', files: ['wiki/escape.md'] }, 'spawn'),
      call('write_file', { path: 'wiki/outside.md', content: 'Escaped' }, 'outside'),
      call('write_file', { path: 'wiki/owned/../outside.md', content: 'Traversal' }, 'traversal'),
      call('write_file', { path: 'index.md', content: 'Changed index' }, 'root'),
      call('delete_file', { path: 'wiki/outside.md' }, 'delete'),
      call('move_file', { from: 'wiki/outside.md', to: 'wiki/owned/stolen.md' }, 'move-in'),
      call('move_file', { from: 'wiki/owned/existing.md', to: 'wiki/outside.md' }, 'move-out'),
      call('write_file', { path: 'wiki/owned/nested/note.md', content: 'Owned content.\n' }, 'owned'),
    ] : 'Owned work finished');
    await wt.write('wiki/outside.md', 'Outside remains.\n');
    await wt.write('wiki/owned/existing.md', 'Owned source remains.\n');
    const index = await wt.read('index.md');
    const pool = makePool();
    const child = await spawn(pool, 'confined', ['wiki/owned/nested/', 'wiki/owned/existing.md', 'wiki/owned/stolen.md']);
    const result = await waitFor(pool, [child.id]);
    expect(result.settled[0]).toMatchObject({ status: 'completed', toolCalls: 9 });
    const followup = requests.find((entry) => entry.turn === 1)!.body;
    expect(output(followup, 'commit')).toMatchObject({ error: expect.stringContaining('Unknown tool') });
    expect(output(followup, 'spawn')).toMatchObject({ error: expect.stringContaining('Unknown tool') });
    for (const id of ['outside', 'traversal', 'root', 'delete', 'move-in', 'move-out']) {
      expect(output(followup, id)).toMatchObject({ error: expect.any(String) });
    }
    expect(await wt.read('wiki/outside.md')).toBe('Outside remains.\n');
    expect(await wt.read('wiki/owned/existing.md')).toBe('Owned source remains.\n');
    expect(await wt.read('wiki/owned/stolen.md')).toBeNull();
    expect(await wt.read('wiki/owned/nested/note.md')).toBe('Owned content.\n');
    expect(await wt.read('index.md')).toBe(index);
  });

  it('rejects internal symlink aliases that bypass child ownership or parent claim guards', async () => {
    const heldStarted = gate();
    const releaseHeld = gate();
    const { wt, requests, makePool } = await fixture(async (initial, turn) => {
      if (initial.name === 'held') {
        heldStarted.resolve();
        await releaseHeld.promise;
        return 'Protected note left untouched';
      }
      return turn === 0 ? [
        call('write_file', { path: 'wiki/owned/alias/note.md', content: 'Child bypass' }, 'alias-write'),
        call('delete_file', { path: 'wiki/owned/alias/note.md' }, 'alias-delete'),
        call('move_file', { from: 'wiki/owned/local.md', to: 'wiki/owned/alias/moved.md' }, 'alias-move'),
      ] : 'Alias mutations rejected';
    });
    await wt.write('wiki/protected/note.md', 'Protected original.\n');
    await wt.write('wiki/owned/local.md', 'Owned original.\n');
    await wt.write('wiki/free.md', 'Parent original.\n');
    await symlink('../protected', join(wt.path, 'wiki/owned/alias'), 'dir');
    await symlink('protected', join(wt.path, 'wiki/parent-alias'), 'dir');
    // These are valid in-repository aliases, so confinement alone cannot enforce ownership.
    expect(await wt.read('wiki/owned/alias/note.md')).toBe('Protected original.\n');
    const pool = makePool();
    const held = await spawn(pool, 'held', ['wiki/protected/note.md']);
    await heldStarted.promise;
    const child = await spawn(pool, 'alias-child', ['wiki/owned/alias/', 'wiki/owned/local.md']);
    expect((await waitFor(pool, [child.id])).settled[0]).toMatchObject({ status: 'completed' });
    const followup = requests.find((entry) => entry.initial.id === child.id && entry.turn === 1)!.body;
    for (const id of ['alias-write', 'alias-delete', 'alias-move']) {
      expect(output(followup, id)).toMatchObject({ error: expect.stringMatching(/symlink/i) });
    }
    for (const [name, args] of [
      ['write_file', { path: 'wiki/parent-alias/note.md', content: 'Parent bypass' }],
      ['delete_file', { path: 'wiki/parent-alias/note.md' }],
      ['move_file', { from: 'wiki/free.md', to: 'wiki/parent-alias/moved.md' }],
      ['move_file', { from: 'wiki/parent-alias/note.md', to: 'wiki/free.md' }],
    ] as const) await expect(invoke(pool.parentTools(), name, args)).rejects.toThrow(/symlink/i);
    expect(await wt.read('wiki/protected/note.md')).toBe('Protected original.\n');
    expect(await wt.read('wiki/protected/moved.md')).toBeNull();
    expect(await wt.read('wiki/owned/local.md')).toBe('Owned original.\n');
    expect(await wt.read('wiki/free.md')).toBe('Parent original.\n');
    releaseHeld.resolve();
    expect((await waitFor(pool, [held.id])).settled[0]).toMatchObject({ status: 'completed' });
  });

  it('rejects reserved and noncanonical claims before starting children', async () => {
    const { requests, makePool } = await fixture(() => 'Unexpected child');
    const pool = makePool();
    for (const files of [['index.md'], ['MEMORY.md'], ['AGENTS.md'], ['raw/'], ['raw/source.md'], ['wiki/../index.md'], ['/wiki/note.md'], ['./wiki/note.md'], []]) {
      await expect(spawn(pool, 'invalid', files)).rejects.toThrow();
    }
    await expect(spawn(pool, '   ')).rejects.toThrow();
    expect(requests).toEqual([]);
    expect(await invoke(pool.tools(), 'subagent_status', {})).toEqual({ subagents: [] });
  });

  it('reserves domain schemas and every overlapping claim before starting children, even without a schema file', async () => {
    const { wt, requests, makePool } = await fixture(() => 'Unexpected child');
    await wt.write('wiki/engineering/AGENTS.md', '# Engineering schema\n');
    const pool = makePool();
    for (const path of [
      'wiki', 'wiki/',
      'wiki/engineering', 'wiki/engineering/',
      'wiki/engineering/AGENTS.md', 'wiki/engineering/AGENTS.md/',
      'wiki/engineering/AGENTS.md/nested.md',
      'wiki/new-domain', 'wiki/new-domain/', 'wiki/new-domain/AGENTS.md',
    ]) {
      await expect(spawn(pool, 'schema-owner', [path])).rejects.toThrow('Parent-only or immutable path cannot be claimed');
    }
    expect(requests).toEqual([]);
    expect(await invoke(pool.tools(), 'subagent_status', {})).toEqual({ subagents: [] });
    expect(await wt.read('wiki/engineering/AGENTS.md')).toBe('# Engineering schema\n');
    expect(await wt.read('wiki/new-domain/AGENTS.md')).toBeNull();
  });

  it('preserves exact legacy wiki-root note claims without treating filenames as domains', async () => {
    const path = 'wiki/root-note.md';
    const { wt, makePool } = await fixture((_initial, turn) => turn === 0
      ? [call('write_file', { path, content: 'Updated legacy note.\n' })]
      : 'Legacy note finished');
    await wt.write(path, 'Existing legacy note.\n');
    const pool = makePool();
    const child = await spawn(pool, 'legacy-note', [path]);
    expect((await waitFor(pool, [child.id])).settled[0]).toMatchObject({ status: 'completed', files: [path], toolCalls: 1 });
    expect(await wt.read(path)).toBe('Updated legacy note.\n');
  });

  it('lets domain note owners read schemas but rejects schema writes, deletes and moves without touching files', async () => {
    const schema = 'wiki/engineering/AGENTS.md';
    const note = 'wiki/engineering/notes/note.md';
    const nestedSchema = 'wiki/engineering/notes/AGENTS.md';
    const { wt, requests, makePool } = await fixture((_initial, turn) => turn === 0 ? [
      call('read_file', { path: schema }, 'read-schema'),
      call('write_file', { path: schema, content: 'Replaced schema' }, 'write-schema'),
      call('delete_file', { path: schema }, 'delete-schema'),
      call('move_file', { from: schema, to: 'wiki/engineering/notes/stolen.md' }, 'move-schema-out'),
      call('move_file', { from: note, to: schema }, 'move-schema-in'),
      call('write_file', { path: note, content: 'Updated domain note.\n' }, 'write-note'),
      call('write_file', { path: nestedSchema, content: 'Ordinary nested note.\n' }, 'write-nested'),
    ] : 'Domain notes finished');
    await wt.write(schema, '# Engineering schema\n');
    await wt.write(note, 'Original domain note.\n');
    const pool = makePool();
    const child = await spawn(pool, 'domain-notes', ['wiki/engineering/notes/']);
    expect((await waitFor(pool, [child.id])).settled[0]).toMatchObject({ status: 'completed', toolCalls: 7 });
    const followup = requests.find((entry) => entry.turn === 1)!.body;
    expect(output(followup, 'read-schema')).toMatchObject({ content: '# Engineering schema\n' });
    for (const id of ['write-schema', 'delete-schema', 'move-schema-out', 'move-schema-in']) {
      expect(output(followup, id)).toMatchObject({ error: expect.stringContaining('outside subagent claims') });
    }
    expect(output(followup, 'write-note')).not.toHaveProperty('error');
    expect(output(followup, 'write-nested')).not.toHaveProperty('error');
    expect(await wt.read(schema)).toBe('# Engineering schema\n');
    expect(await wt.read(note)).toBe('Updated domain note.\n');
    expect(await wt.read(nestedSchema)).toBe('Ordinary nested note.\n');
    expect(await wt.read('wiki/engineering/notes/stolen.md')).toBeNull();
  });

  it('allows domain hubs, shared folders and schema-free descendant folder claims', async () => {
    const { wt, makePool } = await fixture((initial, turn) => turn === 0
      ? [call('write_file', { path: initial.task, content: 'Delegated content.\n' })]
      : 'Delegated note finished');
    const pool = makePool();
    for (const [claim, path] of [
      ['wiki/engineering/index.md', 'wiki/engineering/index.md'],
      ['wiki/engineering/notes/', 'wiki/engineering/notes/topic.md'],
      ['wiki/concepts/', 'wiki/concepts/AGENTS.md'],
      ['wiki/entities/', 'wiki/entities/tool.md'],
    ]) {
      const child = await invoke<Spawned>(pool.tools(), 'spawn_subagent', { name: 'allowed', task: path, files: [claim] });
      expect((await waitFor(pool, [child.id])).settled[0]).toMatchObject({ status: 'completed', toolCalls: 1 });
      expect(await wt.read(path)).toBe('Delegated content.\n');
    }
  });

  it('rejects ill-formed UTF-16 claims and mutations instead of aliasing replacement-character files', async () => {
    const { wt, makePool } = await fixture(() => 'Unexpected child');
    const pool = makePool();
    const invalid = 'wiki/\uD800.md';
    const replacement = 'wiki/\uFFFD.md';
    await wt.write(replacement, 'Original replacement-character file.\n');
    await expect(spawn(pool, 'invalid-unicode', [invalid])).rejects.toThrow(/Invalid repository path/);
    await expect(wt.write(invalid, 'Aliased write')).rejects.toThrow(/Invalid repository path/);
    await expect(invoke(pool.parentTools(), 'write_file', { path: invalid, content: 'Aliased parent write' })).rejects.toThrow(/Invalid repository path/);
    expect(await wt.read(replacement)).toBe('Original replacement-character file.\n');
  });

  it('treats Korean NFC and NFD claim variants as overlapping without renaming filesystem paths', async () => {
    const entered = gate();
    const release = gate();
    const { wt, makePool } = await fixture(async () => { entered.resolve(); await release.promise; return 'Finished'; });
    const nfc = 'wiki/한글.md';
    const nfd = nfc.normalize('NFD');
    await wt.write(nfd, 'Existing decomposed filename.\n');
    const pool = makePool();
    const child = await spawn(pool, 'korean', [nfd]);
    await entered.promise;
    await expect(spawn(pool, 'alias', [nfc])).rejects.toThrow(/overlap/i);
    await expect(invoke(pool.parentTools(), 'write_file', { path: nfc, content: 'Parent alias' })).rejects.toThrow(/claimed/i);
    expect(await wt.read(nfd)).toBe('Existing decomposed filename.\n');
    release.resolve();
    expect((await waitFor(pool, [child.id])).settled[0]).toMatchObject({ status: 'completed', files: [nfd] });
  });

  it.each(['cancel', 'close'] as const)('%s aborts an in-flight search against an embeddings endpoint that never responds', async (operation) => {
    const entered = gate();
    const disconnected = gate();
    const responses: ServerResponse[] = [];
    let embeddingRequests = 0;
    const server = createServer((req, res) => {
      if (req.url !== '/v1/embeddings') throw new Error(`Unexpected embedding route: ${req.url}`);
      embeddingRequests++;
      responses.push(res);
      req.resume();
      res.once('close', () => disconnected.resolve());
      entered.resolve();
      // Deliberately never send headers or a response body.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Embedding endpoint did not bind');
    const { makePool } = await fixture((_initial, turn) => turn === 0 ? [call('search', { query: '지식 검색' })] : 'Unexpected post-cancel turn', `http://127.0.0.1:${address.port}/v1`);
    const pool = makePool();
    const child = await spawn(pool, 'searching');
    let deadline: NodeJS.Timeout | undefined;
    try {
      await entered.promise;
      const cancellation = operation === 'close' ? pool.close() : invoke(pool.tools(), 'cancel_subagent', { id: child.id });
      // This real HTTP integration needs a platform deadline: faking timers also
      // advances the SDK's network timeout/retries and would mask missing signal propagation.
      await Promise.race([
        cancellation,
        new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('Search cancellation remained blocked after 1 second')), 1_000); }),
      ]);
      await disconnected.promise;
      expect(await invoke(pool.tools(), 'subagent_status', { id: child.id })).toMatchObject({
        subagents: [{ id: child.id, status: 'cancelled', finishedAt: expect.any(String) }],
      });
      expect(embeddingRequests).toBe(1);
    } finally {
      clearTimeout(deadline);
      // Release only during teardown so a red test can still settle its child loop.
      for (const res of responses) if (!res.destroyed) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }));
      }
      await pool.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    }
  });

  it('waits for any or all children and supports immediate and bounded timeout snapshots', async () => {
    const started = { first: gate(), second: gate() };
    const released = { first: gate(), second: gate() };
    const { makePool } = await fixture(async (initial) => {
      const name = initial.name as keyof typeof started;
      started[name].resolve();
      await released[name].promise;
      return `${name} done`;
    });
    const pool = makePool();
    const first = await spawn(pool, 'first');
    const second = await spawn(pool, 'second');
    await Promise.all([started.first.promise, started.second.promise]);
    const ids = [first.id, second.id];
    for (const timeout of [0, 1]) {
      const pending = await waitFor(pool, ids, 'all', timeout);
      expect(pending).toMatchObject({ settled: [], timedOut: true });
      expect(pending.running.map((entry) => entry.id)).toEqual(ids);
    }
    const any = waitFor(pool, ids, 'any');
    released.first.resolve();
    expect(await any).toMatchObject({ timedOut: false, settled: [{ id: first.id, status: 'completed' }], running: [{ id: second.id, status: 'running' }] });
    expect(await waitFor(pool, ids, 'all', 0)).toMatchObject({ timedOut: true, running: [{ id: second.id }] });
    const all = waitFor(pool, ids, 'all');
    released.second.resolve();
    expect(await all).toMatchObject({ timedOut: false, running: [], settled: [{ id: first.id, result: 'first done' }, { id: second.id, result: 'second done' }] });
    expect(await waitFor(pool, ids, 'any', 0)).toMatchObject({ timedOut: false, running: [] });
    await expect(waitFor(pool, ids, 'all', 601)).rejects.toThrow();
    await expect(waitFor(pool, ids, 'all', -1)).rejects.toThrow();
  });

  it('delivers queued parent messages on the next child turn exactly once', async () => {
    const started = gate();
    const release = gate();
    const { requests, makePool } = await fixture(async (_initial, turn) => {
      if (turn === 0) { started.resolve(); await release.promise; }
      return turn < 2 ? [call('read_file', { path: 'index.md' }, `read-${turn}`)] : 'Message considered';
    });
    const pool = makePool();
    const child = await spawn(pool, 'receiver');
    await started.promise;
    const message = 'Keep the note narrowly focused on cache invalidation.';
    expect(await invoke(pool.tools(), 'message_subagent', { id: child.id, message })).toEqual({ id: child.id, queued: true });
    release.resolve();
    expect((await waitFor(pool, [child.id])).settled[0]).toMatchObject({ status: 'completed', result: 'Message considered' });
    expect(requests[0]!.body.input.filter((item) => item.content === message)).toEqual([]);
    for (const turn of [1, 2]) {
      expect(requests.find((entry) => entry.turn === turn)!.body.input.filter((item) => item.role === 'user' && item.content === message)).toEqual([{ role: 'user', content: message }]);
    }
    await expect(invoke(pool.tools(), 'message_subagent', { id: child.id, message })).rejects.toThrow(/finished|running/i);
  });

  it('cancel and close retain claims and await in-flight file operations before returning', async () => {
    const entered = [gate(), gate()];
    const release = [gate(), gate()];
    const { wt, tools, makePool, changes } = await fixture((initial) => [call('write_file', { path: initial.files![0], content: 'Child mutation completed.\n' })]);
    let writes = 0;
    const delayed = tools.map((tool): AgentTool => tool.name !== 'write_file' ? tool : {
      ...tool,
      run: async (args) => {
        const index = writes++;
        entered[index]!.resolve();
        await release[index]!.promise;
        return tool.run(args);
      },
    });
    const pool = makePool(delayed);
    const first = await spawn(pool, 'first');
    await entered[0]!.promise;
    let cancelled = false;
    const cancellation = invoke<SubagentSnapshot>(pool.tools(), 'cancel_subagent', { id: first.id }).then((snapshot) => { cancelled = true; return snapshot; });
    await expect(invoke(pool.parentTools(), 'delete_file', { path: 'wiki/first.md' })).rejects.toThrow(/claimed/i);
    await expect(invoke(pool.parentTools(), 'commit', { message: 'Race commit' })).rejects.toThrow(/wait|running/i);
    expect(cancelled).toBe(false);
    release[0]!.resolve();
    expect(await cancellation).toMatchObject({ id: first.id, status: 'cancelled', finishedAt: expect.any(String) });
    expect(await wt.read('wiki/first.md')).toBe('Child mutation completed.\n');
    await invoke(pool.parentTools(), 'delete_file', { path: 'wiki/first.md' });
    expect(await wt.read('wiki/first.md')).toBeNull();
    const second = await spawn(pool, 'second');
    await entered[1]!.promise;
    let closed = false;
    const closing = pool.close().then(() => { closed = true; });
    await expect(invoke(pool.parentTools(), 'delete_file', { path: 'wiki/second.md' })).rejects.toThrow(/claimed/i);
    expect(closed).toBe(false);
    release[1]!.resolve();
    await closing;
    expect(await wt.read('wiki/second.md')).toBe('Child mutation completed.\n');
    expect(await invoke(pool.tools(), 'subagent_status', {})).toMatchObject({ subagents: [{ id: first.id, status: 'cancelled' }, { id: second.id, status: 'cancelled' }] });
    expect(changes.filter((entry) => entry.status === 'cancelled').map((entry) => entry.id)).toEqual([first.id, second.id]);
    await expect(spawn(pool, 'after-close')).rejects.toThrow(/closed/i);
  });

  it('enforces concurrent and per-job limits while releasing cancelled claims', async () => {
    const release = gate();
    const { makePool, requests } = await fixture(async (initial) => {
      if (initial.name!.startsWith('held')) await release.promise;
      return 'Finished';
    });
    const pool = makePool();
    const children = [];
    for (let index = 0; index < 2; index++) children.push(await spawn(pool, `held-${index}`));
    await expect(spawn(pool, 'third')).rejects.toThrow();
    await Promise.all(children.map((child) => invoke(pool.tools(), 'cancel_subagent', { id: child.id })));
    for (let index = 0; index < 2; index++) {
      const child = await spawn(pool, `replacement-${index}`, ['wiki/held-0.md']);
      expect((await waitFor(pool, [child.id])).settled[0]).toMatchObject({ status: 'completed' });
    }
    await expect(spawn(pool, 'fifth')).rejects.toThrow();
    const status = await invoke<{ subagents: SubagentSnapshot[] }>(pool.tools(), 'subagent_status', {});
    expect(status.subagents.map((child) => [child.name, child.status])).toEqual([
      ['held-0', 'cancelled'], ['held-1', 'cancelled'],
      ['replacement-0', 'completed'], ['replacement-1', 'completed'],
    ]);
    expect(requests.some((request) => request.initial.name === 'third' || request.initial.name === 'fifth')).toBe(false);
    release.resolve();
  });

  it('reports child failures when its tool loop exceeds the child turn budget', async () => {
    const { makePool } = await fixture(() => [call('read_file', { path: 'index.md' })]);
    const pool = makePool();
    const child = await spawn(pool, 'looping');
    expect((await waitFor(pool, [child.id])).settled[0]).toMatchObject({ id: child.id, status: 'failed', toolCalls: 32, error: expect.stringContaining('maxTurns (32)') });
    await invoke(pool.parentTools(), 'write_file', { path: 'wiki/looping.md', content: 'Parent recovered.\n' });
  });
});

describe('runWrite subagent integration', () => {
  it('hands exact raw read assignments to a child separately from its output ownership', async () => {
    const sources = ['raw/import/extracted/notion/files/CRM.md', 'raw/import/extracted/notion/files/계약.md'];
    const { agent, wt, author, requests } = await fixture((initial, turn, body) => {
      if (initial.jobId) {
        if (turn === 0) return [call('spawn_subagent', {
          name: 'crm', task: 'Read both assigned sources and combine their knowledge.',
          files: ['wiki/crm.md'], sources,
        })];
        if (turn === 1) return [call('wait_subagents', { ids: [output(body, 'spawn_subagent').id], timeoutSeconds: 5 })];
        return 'CRM 원문 두 개를 통합했다.';
      }
      if (turn === 0) return (initial.sources ?? []).map((path, index) => call('read_file', { path }, `source-${index}`));
      if (turn === 1) return [call('write_file', {
        path: initial.files![0], content: `${output(body, 'source-0').content}${output(body, 'source-1').content}`,
      })];
      return '두 원문을 wiki/crm.md에 통합했다.';
    });
    await wt.write(sources[0], '# CRM\n고객 관계를 유지한다.\n');
    await wt.write(sources[1], '# 계약\n계약 갱신일을 관리한다.\n');
    const phases: Record<string, unknown>[] = [];
    wt.onPhase = (_phase, detail) => { if (detail.subagent) phases.push(detail.subagent as Record<string, unknown>); };
    await expect(agent.runWrite(job, wt, author)).resolves.toEqual({ summary: 'CRM 원문 두 개를 통합했다.' });
    expect(requests.find((entry) => entry.initial.name === 'crm' && entry.turn === 0)?.initial).toMatchObject({
      files: ['wiki/crm.md'], sources,
    });
    expect(await wt.read('wiki/crm.md')).toBe('# CRM\n고객 관계를 유지한다.\n# 계약\n계약 갱신일을 관리한다.\n');
    expect(phases).toEqual([
      expect.objectContaining({ status: 'running', files: ['wiki/crm.md'], sources }),
      expect.objectContaining({ status: 'completed', files: ['wiki/crm.md'], sources }),
    ]);
  });

  it('returns source validation errors to the parent without launching children or granting read access', async () => {
    const invalidSources = [
      ['raw/../private/source.md'], ['/raw/source.md'], ['.git/config'], ['raw/\uD800.md'],
      ['raw/missing.md'], ['raw/'], ['private/source.md'],
      Array.from({ length: 201 }, () => 'raw/allowed.md'),
    ];
    const { agent, wt, author, requests, acl, users } = await fixture((initial, turn, body) => {
      if (!initial.jobId) throw new Error('Invalid source launched a child');
      if (turn === 0) return invalidSources.map((sources, index) => call('spawn_subagent', {
        name: `invalid-${index}`, task: 'Read assigned source', files: [`wiki/invalid-${index}.md`], sources,
      }, `invalid-${index}`));
      for (let index = 0; index < invalidSources.length; index++) {
        expect(output(body, `invalid-${index}`)).toMatchObject({ error: expect.any(String) });
      }
      return '읽을 수 없는 원문 위임을 거절했다.';
    });
    const admin = users.create({ email: 'admin@example.com', role: 'admin' });
    const editor = users.create({ email: 'editor@example.com', role: 'editor' });
    acl.create({ prefix: 'private/', subjectType: 'everyone', access: 'none' }, admin);
    await wt.write('private/source.md', 'Restricted source.\n');
    await wt.write('raw/allowed.md', 'Readable source.\n');
    await expect(agent.runWrite(job, wt, author, editor)).resolves.toEqual({ summary: '읽을 수 없는 원문 위임을 거절했다.' });
    expect(requests.every((entry) => entry.initial.jobId === job.id)).toBe(true);
    await expect(invoke(agent.worktreeTools(wt, author, editor), 'read_file', { path: 'private/source.md' })).rejects.toMatchObject({ status: 404 });
  });

  it('waits for both delegated writes, emits lifecycle phases, and commits their real worktree changes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-10T00:00:00.000Z'));
    const noteContent = (name: string) => `---\ntype: note\naliases: []\ndescription: "${name}의 독립 지식을 기록한다."\nauthor: ["Tester"]\ndate created: 2026-10-10\ndate modified: 2026-10-10\ntags: [knowledge-management]\n---\n# ${name}\n독립 지식을 기록한다.\n`;
    const { agent, wt, repo, author } = await fixture((initial, turn, body) => {
      if (initial.jobId) {
        if (turn === 0) return [
          call('spawn_subagent', { name: 'alpha', task: 'Write alpha note', files: ['wiki/alpha.md'] }, 'spawn-alpha'),
          call('spawn_subagent', { name: 'beta', task: 'Write beta note', files: ['wiki/beta.md'] }, 'spawn-beta'),
        ];
        if (turn === 1) return [call('wait_subagents', { ids: [output(body, 'spawn-alpha').id, output(body, 'spawn-beta').id], mode: 'all', timeoutSeconds: 5 })];
        if (turn === 2) return [call('commit', { message: '독립 노트를 함께 검토하고 기록한다' })];
        return '두 노트를 기록했다.';
      }
      return turn === 0 ? [call('write_file', { path: initial.files![0], content: noteContent(initial.name!) })] : `${initial.name} 완료`;
    });
    const phases: Array<{ phase: string; detail: Record<string, unknown> }> = [];
    wt.onPhase = (phase, detail) => phases.push({ phase, detail });
    await expect(agent.runWrite(job, wt, author)).resolves.toEqual({ summary: '두 노트를 기록했다.' });
    for (const name of ['alpha', 'beta']) {
      const content = (await wt.read(`wiki/${name}.md`))!;
      expect(content).toBe(noteContent(name));
      expect(matter(content).content).toBe(`# ${name}\n독립 지식을 기록한다.\n`);
    }
    const children = phases.map((entry) => entry.detail.subagent).filter((value): value is SubagentSnapshot => !!value && typeof value === 'object' && 'id' in value);
    for (const name of ['alpha', 'beta']) {
      expect(children.filter((child) => child.name === name).map((child) => child.status)).toEqual(['running', 'completed']);
    }
    await repo.withMergeLock(() => wt.fastForwardMain());
    for (const name of ['alpha', 'beta']) {
      expect(await repo.readFile(`wiki/${name}.md`)).toBe(noteContent(name));
    }
    expect((await repo.log({ limit: 1 }))[0]).toMatchObject({ subject: '독립 노트를 함께 검토하고 기록한다', authorName: author.name, authorEmail: author.email });
  });

  it('counts only new parent and child response deltas when resuming checkpoint usage', async () => {
    const { agent, wt, author } = await fixture((initial, turn, body) => {
      const usage = {
        inputTokens: (initial.jobId ? 10 : 20) + turn,
        cachedInputTokens: initial.jobId ? 3 : 7,
        outputTokens: 4,
        reasoningTokens: 2,
      };
      if (initial.jobId) {
        if (turn === 0) return { usage, functionCalls: [call('spawn_subagent', { name: 'resumed-child', task: 'Finish the remaining note', files: ['wiki/resumed.md'] })] };
        if (turn === 1) return { usage, functionCalls: [call('wait_subagents', { ids: [output(body, 'spawn_subagent').id], timeoutSeconds: 5 })] };
        return { usage, text: '남은 노트를 기록했다.' };
      }
      return turn === 0
        ? { usage, functionCalls: [call('write_file', { path: initial.files![0], content: '# 재개\n남은 지식을 기록한다.\n' })] }
        : { usage, text: '남은 노트를 완성했다.' };
    });
    const resume: AgentCheckpoint = {
      input: [{ role: 'user', content: JSON.stringify({ jobId: job.id, request: job.input }) }],
      text: '',
      toolCalls: 3,
      usage: { inputTokens: 999, cachedInputTokens: 600, outputTokens: 111, reasoningTokens: 22 },
    };
    const deltas: TokenUsage[] = [];
    await expect(agent.runWrite(job, wt, author, undefined, {
      resume,
      onUsage: (usage) => deltas.push(usage),
    })).resolves.toEqual({ summary: '남은 노트를 기록했다.' });
    expect(await wt.read('wiki/resumed.md')).toBe('# 재개\n남은 지식을 기록한다.\n');
    expect(deltas.map((usage) => usage.inputTokens).sort((a, b) => a - b)).toEqual([10, 11, 12, 20, 21]);
    expect(deltas.reduce((sum, usage) => ({
      inputTokens: sum.inputTokens + usage.inputTokens,
      cachedInputTokens: sum.cachedInputTokens + (usage.cachedInputTokens ?? 0),
      outputTokens: sum.outputTokens + usage.outputTokens,
      reasoningTokens: sum.reasoningTokens + usage.reasoningTokens,
    }), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 })).toEqual({
      inputTokens: 74, cachedInputTokens: 23, outputTokens: 20, reasoningTokens: 10,
    });
  });

  it.each(['early completion', 'turn-budget failure'] as const)('cancels unfinished children before returning from parent %s', async (outcome) => {
    const childStarted = gate();
    const releaseResponse = gate();
    const childResponseReleased = gate();
    const { agent, wt, author } = await fixture(async (initial, turn) => {
      if (initial.jobId) {
        if (turn === 0) return [call('spawn_subagent', { name: 'unfinished', task: 'Write the unfinished note', files: ['wiki/unfinished.md'] })];
        await childStarted.promise;
        return outcome === 'early completion'
          ? '미완료 위임을 취소하고 작업을 마쳤다.'
          : [call('read_file', { path: 'index.md' })];
      }
      childStarted.resolve();
      await releaseResponse.promise;
      childResponseReleased.resolve();
      return [call('write_file', { path: 'wiki/unfinished.md', content: 'Must not be written after parent exit.\n' })];
    });
    const lifecycle: Array<{ phase: string; subagent: unknown }> = [];
    wt.onPhase = (phase, detail) => {
      if (detail.subagent) lifecycle.push({ phase, subagent: detail.subagent });
    };
    const writing = agent.runWrite(job, wt, author);
    if (outcome === 'early completion') {
      await expect(writing).resolves.toEqual({ summary: '미완료 위임을 취소하고 작업을 마쳤다.' });
    } else {
      await expect(writing).rejects.toThrow('maxTurns (96)');
    }
    expect(lifecycle).toEqual([
      { phase: 'editing', subagent: expect.objectContaining({ name: 'unfinished', status: 'running' }) },
      { phase: 'editing', subagent: expect.objectContaining({ name: 'unfinished', status: 'cancelled' }) },
    ]);
    expect(await wt.read('wiki/unfinished.md')).toBeNull();
    releaseResponse.resolve();
    await childResponseReleased.promise;
    await setImmediate();
    expect(await wt.read('wiki/unfinished.md')).toBeNull();
  });
});
