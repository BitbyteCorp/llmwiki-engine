import { Test } from '@nestjs/testing';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentService } from '../../src/agent/agent.service.js';
import type { AgentTool } from '../../src/agent/agent.types.js';
import { SubagentPool, type SubagentSnapshot } from '../../src/agent/subagents.js';
import { AclService } from '../../src/acl/acl.service.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { UsersService } from '../../src/auth/users.service.js';
import { UsersRepository } from '../../src/auth/users.repository.js';
import { CONFIG, LOGGER } from '../../src/common/tokens.js';
import { loadConfig } from '../../src/config.js';
import { openDb, runMigrations } from '../../src/db/index.js';
import type { WriteJob } from '../../src/jobs/write-job.types.js';
import { KnowledgeRepo } from '../../src/knowledge/repo.js';
import { SearchService } from '../../src/rag/search.service.js';
import { startFakeOpenAI } from '../fake-openai.js';

const cleanup: Array<() => Promise<unknown>> = [];
const releaseGates: Array<() => void> = [];
afterEach(async () => {
  for (const release of releaseGates.splice(0)) release();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  releaseGates.push(resolve);
  return { promise, resolve };
}

type InputItem = { role?: string; content?: string; type?: string; call_id?: string; output?: string };
type RequestBody = { input: InputItem[]; stream: boolean; tools: Array<{ name: string }> };
type Initial = { id?: string; name?: string; task?: string; files?: string[]; jobId?: string };
type Call = { name: string; arguments: Record<string, unknown>; call_id: string };
type Reply = string | Call[];
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
async function fixture(route: Route) {
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
    return typeof reply === 'string' ? reply : { functionCalls: reply };
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
  const acl = new AclService(db, new UsersService(new UsersRepository(db)), new AuditService(db));
  const search = { search: async () => [] } as unknown as SearchService;
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
    const pool = new SubagentPool({ agent, instructions: 'Write only the delegated notes.', tools: customTools, wt, onChange: (snapshot) => changes.push(snapshot) });
    cleanup.push(() => pool.close());
    return pool;
  }
  return { agent, repo, wt, author, tools, requests, changes, makePool };
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
  id: 'parallel-write', userId: 1, source: 'mcp', input: '두 독립 노트를 기록한다.', status: 'running', summary: null,
  kind: 'agent', client: null, conflicts: [], commits: [], mergeSha: null, error: null,
  createdAt: '2026-10-07T00:00:00.000Z', startedAt: null, finishedAt: null,
};

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
    const second = await spawn(pool, 'second', ['wiki/second/']);
    await Promise.all([firstStarted.promise, secondStarted.promise]);
    for (const files of [['wiki/first.md'], ['wiki/'], ['wiki/second/nested.md'], ['wiki/second/']]) {
      await expect(spawn(pool, 'overlap', files)).rejects.toThrow(/overlap/i);
    }
    const parent = pool.parentTools();
    await wt.write('wiki/outside.md', 'Original outside.\n');
    for (const [name, args] of [
      ['write_file', { path: 'wiki/first.md', content: 'Parent collision.' }],
      ['delete_file', { path: 'wiki/first.md' }],
      ['move_file', { from: 'wiki/first.md', to: 'wiki/free.md' }],
      ['move_file', { from: 'wiki/outside.md', to: 'wiki/second/stolen.md' }],
    ] as const) await expect(invoke(parent, name, args)).rejects.toThrow(/claimed/i);
    await expect(invoke(parent, 'commit', { message: 'Too soon' })).rejects.toThrow(/running|wait/i);
    await invoke(parent, 'write_file', { path: 'wiki/second-sibling.md', content: 'Unclaimed parent note.\n' });
    release.resolve();
    const result = await waitFor(pool, [first.id, second.id]);
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
    const child = await spawn(pool, 'confined', ['wiki/owned/']);
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
    const held = await spawn(pool, 'held', ['wiki/protected/']);
    await heldStarted.promise;
    const child = await spawn(pool, 'alias-child', ['wiki/owned/']);
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
    const { makePool } = await fixture(async (initial) => {
      if (initial.name!.startsWith('held')) await release.promise;
      return 'Finished';
    });
    const pool = makePool();
    const children = [];
    for (let index = 0; index < 4; index++) children.push(await spawn(pool, `held-${index}`));
    await expect(spawn(pool, 'fifth')).rejects.toThrow(/4|concurrent/i);
    await Promise.all(children.map((child) => invoke(pool.tools(), 'cancel_subagent', { id: child.id })));
    for (let index = 0; index < 8; index++) {
      const child = await spawn(pool, `replacement-${index}`, ['wiki/held-0.md']);
      expect((await waitFor(pool, [child.id])).settled[0]).toMatchObject({ status: 'completed' });
    }
    await expect(spawn(pool, 'thirteenth')).rejects.toThrow(/12|per job/i);
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
  it('waits for both delegated writes, emits lifecycle phases, and commits their real worktree changes', async () => {
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
      return turn === 0 ? [call('write_file', { path: initial.files![0], content: `# ${initial.name}\n독립 지식을 기록한다.\n` })] : `${initial.name} 완료`;
    });
    const phases: Array<{ phase: string; detail: Record<string, unknown> }> = [];
    wt.onPhase = (phase, detail) => phases.push({ phase, detail });
    await expect(agent.runWrite(job, wt, author)).resolves.toEqual({ summary: '두 노트를 기록했다.' });
    expect(await wt.read('wiki/alpha.md')).toBe('# alpha\n독립 지식을 기록한다.\n');
    expect(await wt.read('wiki/beta.md')).toBe('# beta\n독립 지식을 기록한다.\n');
    const children = phases.map((entry) => entry.detail.subagent).filter((value): value is SubagentSnapshot => !!value && typeof value === 'object' && 'id' in value);
    for (const name of ['alpha', 'beta']) {
      expect(children.filter((child) => child.name === name).map((child) => child.status)).toEqual(['running', 'completed']);
    }
    await repo.withMergeLock(() => wt.fastForwardMain());
    expect(await repo.readFile('wiki/alpha.md')).toBe('# alpha\n독립 지식을 기록한다.\n');
    expect((await repo.log({ limit: 1 }))[0]).toMatchObject({ subject: '독립 노트를 함께 검토하고 기록한다', authorName: author.name, authorEmail: author.email });
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
