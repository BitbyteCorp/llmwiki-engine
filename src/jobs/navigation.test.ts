import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import matter from 'gray-matter';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AclService } from '../acl/acl.service.js';
import { AgentService } from '../agent/agent.service.js';
import { AuditService } from '../audit/audit.service.js';
import { UsersRepository } from '../auth/users.repository.js';
import { UsersService } from '../auth/users.service.js';
import { loadConfig } from '../config.js';
import { openDb, runMigrations } from '../db/index.js';
import { EventsService } from '../events/events.service.js';
import { KnowledgeRepo } from '../knowledge/repo.js';
import { WikiCatalog } from '../knowledge/wiki-catalog.js';
import { IndexerService } from '../rag/indexer.service.js';
import { SearchService } from '../rag/search.service.js';
import { WriteJobsRepository } from './write-jobs.repository.js';
import { WriteJobsService } from './write-jobs.service.js';

interface FakeRequest { path: string; body: Record<string, unknown> }
interface FakeCall { name: string; arguments: Record<string, unknown>; call_id?: string }
type FakeTurn = string | FakeCall | { functionCalls: FakeCall[]; text?: string }
  | { error: { status: number; message: string; code?: string; type?: string } };
type FakeResponder = (request: FakeRequest, index: number) => FakeTurn | Promise<FakeTurn>;
interface FakeProvider { url: string; requests: FakeRequest[]; close(): Promise<void> }
interface InputItem { type?: string; role?: string; content?: unknown; call_id?: string; output?: string }

const author = { name: 'Navigation Requester', email: 'navigation@example.test' };
const navigationRepairTitle = '## 탐색 가능성 검증 후 한 번의 보완';
const alpha = 'wiki/concepts/alpha.md';
const beta = 'wiki/concepts/beta.md';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

function concept(body: string): string {
  return `---\ntype: concept\naliases: []\ndescription: A reusable concept with related knowledge.\ntags: [knowledge]\n---\n${body}`;
}

async function fixture(responder: FakeResponder) {
  // Keep the shared fake HTTP provider outside the production TypeScript root.
  const { startFakeOpenAI }: { startFakeOpenAI(script: FakeResponder): Promise<FakeProvider> } = await import(new URL('../../test/fake-openai.ts', import.meta.url).href);
  const dir = await mkdtemp(join(tmpdir(), 'llmwiki-navigation-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const fake = await startFakeOpenAI(responder);
  cleanup.push(() => fake.close());
  const config = loadConfig({
    NODE_ENV: 'test', DATA_DIR: dir, LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key',
    OPENAI_BASE_URL: fake.url, OPENAI_MAX_RETRIES: '0', EMBEDDING_DIMENSIONS: '2',
  });
  const log = pino({ level: 'silent' });
  const db = openDb(':memory:');
  runMigrations(db);
  cleanup.push(async () => db.close());
  db.prepare('INSERT INTO users(id,email,name,role,created_at) VALUES (1,?,?,?,?)').run(author.email, author.name, 'editor', new Date().toISOString());
  const users = new UsersService(new UsersRepository(db));
  const acl = new AclService(db, users, new AuditService(db));
  const events = new EventsService();
  const repo = await KnowledgeRepo.open(config, log);
  const search = new SearchService(config, db, log, acl, repo);
  const agent = new AgentService(config, log, repo, search, acl, new WikiCatalog(repo, acl));
  const indexer = new IndexerService(config, db, log, repo, events);
  const jobs = new WriteJobsService(new WriteJobsRepository(db), agent, indexer, repo, users, log, events, acl);
  cleanup.push(() => jobs.stop());
  return { fake, repo, jobs, users, acl };
}

async function settled(jobs: WriteJobsService, id: string) {
  await vi.waitFor(() => expect(['succeeded', 'failed']).toContain(jobs.get(id)?.status), { timeout: 15000, interval: 10 });
  await jobs.stop();
  return jobs.get(id)!;
}

function toolOutput(request: FakeRequest, callId: string): Record<string, unknown> {
  const item = (request.body.input as InputItem[]).find(item => item.type === 'function_call_output' && item.call_id === callId);
  expect(item, `tool result for ${callId}`).toBeDefined();
  return JSON.parse(item!.output!);
}

function repairInput(request: FakeRequest): { issues: Array<{ path: string; kind: string }> } {
  const messages = request.body.input as InputItem[];
  const message = messages.find(item => item.role === 'user');
  return JSON.parse(String(message!.content));
}

function repairRequests(fake: FakeProvider) {
  return fake.requests.filter(request => request.path.endsWith('/responses')
    && String(request.body.instructions).includes(navigationRepairTitle));
}

async function seedSource(repo: KnowledgeRepo, path: string, content: string) {
  const wt = await repo.createWorktree('navigation-source');
  try {
    await wt.write(path, content);
    await wt.commit('Preserve navigation test source', author);
    await repo.withMergeLock(() => wt.fastForwardMain());
  } finally {
    await wt.dispose();
  }
}

describe('write job navigation gate with real Dony and git', () => {
  it('repairs an orphan through worktree tools before publishing the notes', async () => {
    let writeTurn = 0;
    let repairTurn = 0;
    const betaBody = '# Beta\nBeta provides a related reusable concept.\n';
    const backlink = '\nRead [[wiki/concepts/alpha]] for the corresponding Alpha concept.\n';
    const f = await fixture((request) => {
      if (String(request.body.instructions).includes(navigationRepairTitle)) {
        const turn = repairTurn++;
        if (turn === 0) {
          expect(repairInput(request)).toEqual({ issues: [expect.objectContaining({ path: alpha, kind: 'orphan' })] });
          return { name: 'read_file', arguments: { path: beta }, call_id: 'repair-review' };
        }
        if (turn === 1) {
          const reviewed = toolOutput(request, 'repair-review');
          expect(reviewed).toMatchObject({ content: expect.stringContaining(betaBody), truncated: false });
          return { name: 'write_file', arguments: { path: beta, content: `${reviewed.content}${backlink}` }, call_id: 'repair-backlink' };
        }
        expect(turn).toBe(2);
        expect(toolOutput(request, 'repair-backlink')).toEqual({ path: beta, written: true });
        return '베타에서 알파로 가는 조회 경로를 보완했다.';
      }
      if (writeTurn++ === 0) return { functionCalls: [
        { name: 'write_file', arguments: { path: alpha, content: concept('# Alpha\nRead [[wiki/concepts/beta]] for Beta.\n') } },
        { name: 'write_file', arguments: { path: beta, content: concept(betaBody) } },
      ] };
      expect(writeTurn).toBe(2);
      return 'Publish related concepts';
    });
    f.jobs.start();
    const job = f.jobs.submit({ userId: 1, source: 'mcp', input: 'Record Alpha and Beta as related reusable concepts' });
    const result = await settled(f.jobs, job.id);

    expect(result).toMatchObject({ status: 'succeeded', summary: 'Publish related concepts', error: null });
    expect(repairRequests(f.fake)).toHaveLength(3);
    expect(matter((await f.repo.readFile(beta))!).content).toBe(betaBody + backlink);
    expect(matter((await f.repo.readFile(alpha))!).content).toBe('# Alpha\nRead [[wiki/concepts/beta]] for Beta.\n');
    const events = f.jobs.events(job.id);
    expect(events.filter(event => event.detail?.navigationRepair).map(({ phase, detail }) => ({ phase, detail }))).toEqual([
      { phase: 'editing', detail: { navigationRepair: 'started', navigationIssues: [{ path: alpha, kind: 'orphan', message: expect.any(String) }] } },
      { phase: 'editing', detail: { navigationRepair: 'finished', navigationIssues: [] } },
    ]);
    expect(events.some(event => event.detail?.metadataRepair)).toBe(false);
    expect(events.at(-1)).toMatchObject({ phase: 'done' });
    expect(events.at(-1)!.detail).not.toHaveProperty('navigationIssues');
  }, 20000);

  it('skips the navigation repair model when new concepts already link to each other', async () => {
    const f = await fixture((_request, turn) => {
      if (turn === 0) return { functionCalls: [
        { name: 'write_file', arguments: { path: alpha, content: concept('# Alpha\nRead [[wiki/concepts/beta]] for Beta.\n') } },
        { name: 'write_file', arguments: { path: beta, content: concept('# Beta\nRead [[wiki/concepts/alpha]] for Alpha.\n') } },
      ] };
      expect(turn).toBe(1);
      return 'Publish navigable concepts';
    });
    f.jobs.start();
    const job = f.jobs.submit({ userId: 1, source: 'mcp', input: 'Record linked Alpha and Beta concepts' });
    const result = await settled(f.jobs, job.id);

    expect(result).toMatchObject({ status: 'succeeded', summary: 'Publish navigable concepts', error: null });
    expect(repairRequests(f.fake)).toEqual([]);
    expect(f.fake.requests.filter(request => request.path.endsWith('/responses'))).toHaveLength(2);
    expect(matter((await f.repo.readFile(alpha))!).content).toBe('# Alpha\nRead [[wiki/concepts/beta]] for Beta.\n');
    expect(matter((await f.repo.readFile(beta))!).content).toBe('# Beta\nRead [[wiki/concepts/alpha]] for Alpha.\n');
    const events = f.jobs.events(job.id);
    expect(events.some(event => event.detail?.navigationRepair || event.detail?.metadataRepair)).toBe(false);
    expect(events.at(-1)).toMatchObject({ phase: 'done' });
    expect(events.at(-1)!.detail).not.toHaveProperty('navigationIssues');
  }, 20000);

  it('keeps an unchanged hidden hub out of repair requests and restricts its job findings to administrators', async () => {
    const hiddenHub = 'wiki/private/index.md';
    const hiddenContent = concept('# Private hub\nHIDDEN_NAVIGATION_PAYLOAD\n').replace('type: concept', 'type: hub');
    const addition = '\nRead [[wiki/concepts/not-created]] for a concept that has not been recorded yet.\n';
    let writeTurn = 0;
    let repairTurn = 0;
    const f = await fixture((request) => {
      if (String(request.body.instructions).includes(navigationRepairTitle)) {
        expect(repairTurn++).toBe(0);
        expect(repairInput(request)).toEqual({ issues: [expect.objectContaining({ path: 'index.md', kind: 'broken-link' })] });
        expect(JSON.stringify(request.body)).not.toContain(hiddenHub);
        expect(JSON.stringify(request.body)).not.toContain('HIDDEN_NAVIGATION_PAYLOAD');
        return '기존 색인은 보존했으며 아직 없는 개념의 링크를 남겼다.';
      }
      const turn = writeTurn++;
      if (turn === 0) return { name: 'read_file', arguments: { path: 'index.md' }, call_id: 'root-index' };
      if (turn === 1) {
        const reviewed = toolOutput(request, 'root-index');
        expect(reviewed).toMatchObject({ content: expect.any(String), truncated: false });
        return { name: 'write_file', arguments: { path: 'index.md', content: `${reviewed.content}${addition}` } };
      }
      expect(turn).toBe(2);
      return 'Update the public knowledge index';
    });
    const admin = await f.users.create({ email: 'navigation-admin@example.test', role: 'admin' });
    const editor = f.users.getById(1)!;
    await seedSource(f.repo, hiddenHub, hiddenContent);
    const preservedHub = await f.repo.readFile(hiddenHub);
    f.acl.create({ prefix: 'wiki/private/', subjectType: 'everyone', subject: '', access: 'none' }, admin);
    f.jobs.start();
    const job = f.jobs.submit({ userId: editor.id, source: 'mcp', input: 'Add a public concept reference to the root index' });
    const result = await settled(f.jobs, job.id);

    expect(result).toMatchObject({ status: 'succeeded', summary: 'Update the public knowledge index', error: null });
    expect(repairRequests(f.fake)).toHaveLength(1);
    expect(await f.repo.readFile(hiddenHub)).toBe(preservedHub);
    expect(await f.repo.readFile('index.md')).toContain(addition);
    for (const request of f.fake.requests.filter(request => request.path.endsWith('/responses'))) {
      expect(JSON.stringify(request.body)).not.toContain(hiddenHub);
      expect(JSON.stringify(request.body)).not.toContain('HIDDEN_NAVIGATION_PAYLOAD');
    }
    const hiddenIssue = expect.objectContaining({ path: hiddenHub, kind: 'hub-unlinked' });
    const events = f.jobs.events(job.id);
    expect(events.find(event => event.detail?.navigationRepair === 'started')).toMatchObject({
      phase: 'editing', detail: { navigationIssues: expect.arrayContaining([hiddenIssue]) },
    });
    expect(events.at(-1)).toMatchObject({
      phase: 'done', detail: { navigationIssues: expect.arrayContaining([hiddenIssue]) },
    });
    const administrator = await f.jobs.projectVisibility(admin, result);
    expect(administrator.restricted).toBe(false);
    expect(administrator.job).toEqual(result);
    expect(administrator.sourcePaths).toContain(hiddenHub);
    const ordinary = await f.jobs.projectVisibility(editor, result);
    expect(ordinary.restricted).toBe(true);
    expect(ordinary.job).toMatchObject({ input: '', summary: null, commits: [], conflicts: [], mergeSha: null });
    expect(await f.jobs.visible(editor, result)).toEqual(ordinary.job);
  }, 20000);

  it.each(['unresolved', 'provider-error'] as const)('publishes imported knowledge with remaining issues after an %s navigation repair', async (outcome) => {
    const source = 'raw/import/navigation.md';
    const sourceContent = 'Alpha relates to Beta; its external related concept has not been documented.\n';
    const alphaBody = '# Alpha\nRead [[wiki/concepts/beta]] for Beta and [[wiki/concepts/undocumented]] for the external concept.\n';
    const betaBody = '# Beta\nRead [[wiki/concepts/alpha]] for Alpha.\n';
    let writeTurn = 0;
    let repairTurn = 0;
    const f = await fixture((request) => {
      if (String(request.body.instructions).includes(navigationRepairTitle)) {
        expect(repairTurn++).toBe(0);
        expect(repairInput(request)).toEqual({ issues: [expect.objectContaining({ path: alpha, kind: 'broken-link' })] });
        if (outcome === 'provider-error') return { error: { status: 500, message: 'Navigation repair provider failed', type: 'server_error' } };
        return '외부 개념의 실제 대상을 확인할 수 없어 원문의 지식과 링크를 보존했다.';
      }
      const turn = writeTurn++;
      if (turn === 0) return { name: 'read_file', arguments: { path: source }, call_id: 'import-source' };
      if (turn === 1) {
        expect(toolOutput(request, 'import-source')).toMatchObject({ content: sourceContent, truncated: false });
        return { functionCalls: [
          { name: 'write_file', arguments: { path: alpha, content: concept(alphaBody) } },
          { name: 'write_file', arguments: { path: beta, content: concept(betaBody) } },
        ] };
      }
      expect(turn).toBe(2);
      return 'Integrate the assigned concepts';
    });
    await seedSource(f.repo, source, sourceContent);
    const mainBefore = await f.repo.headSha();
    f.jobs.start();
    const job = f.jobs.submit({ userId: 1, source: 'import', input: 'Integrate the assigned source concepts', requiredReads: [source] });
    const result = await settled(f.jobs, job.id);

    expect(result).toMatchObject({ status: 'succeeded', source: 'import', summary: 'Integrate the assigned concepts', error: null });
    expect(result.mergeSha).not.toBe(mainBefore);
    expect(repairRequests(f.fake)).toHaveLength(1);
    expect(await f.repo.readFile(source)).toBe(sourceContent);
    expect(matter((await f.repo.readFile(alpha))!).content).toBe(alphaBody);
    expect(matter((await f.repo.readFile(beta))!).content).toBe(betaBody);
    const issues = [{ path: alpha, kind: 'broken-link', message: expect.stringContaining('[[wiki/concepts/undocumented]]') }];
    const events = f.jobs.events(job.id);
    const repairEvents = events.filter(event => event.detail?.navigationRepair);
    expect(repairEvents.map(event => event.detail!.navigationRepair)).toEqual(outcome === 'provider-error'
      ? ['started', 'error', 'finished'] : ['started', 'finished']);
    expect(repairEvents[0]).toMatchObject({ phase: 'editing', detail: { navigationRepair: 'started', navigationIssues: issues } });
    if (outcome === 'provider-error') expect(repairEvents[1]).toMatchObject({
      phase: 'editing', detail: { navigationRepair: 'error', error: expect.stringContaining('Navigation repair provider failed') },
    });
    expect(repairEvents.at(-1)).toMatchObject({ phase: 'editing', detail: { navigationRepair: 'finished', navigationIssues: issues } });
    expect(events.some(event => event.detail?.metadataRepair)).toBe(false);
    expect(events.at(-1)).toMatchObject({ phase: 'done', detail: { navigationIssues: issues } });
  }, 20000);
});
