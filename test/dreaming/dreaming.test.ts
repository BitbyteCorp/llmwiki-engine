import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { Module, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Command } from 'commander';
import Database from 'better-sqlite3';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../../src/config.js';
import { CONFIG, DB, LOGGER } from '../../src/common/tokens.js';
import { newId, toStorageId } from '../../src/common/ids.js';
import { registerDreamCommands } from '../../src/dreaming/dreaming.commands.js';
import { DreamRunsRepository } from '../../src/dreaming/dream-runs.repository.js';
import { DreamingService } from '../../src/dreaming/dreaming.service.js';
import type { StructureSignals } from '../../src/dreaming/structure-signals.js';
import { EventsService } from '../../src/events/events.service.js';
import { KnowledgeRepo, type CommitInfo, type FileChange, type Worktree } from '../../src/knowledge/repo.js';
import { commitTrailers, type CommitMetadata } from '../../src/knowledge/commit-trailers.js';
import { AgentService } from '../../src/agent/agent.service.js';
import type { AgentTool, RunAgentOptions } from '../../src/agent/agent.types.js';
import { IndexerService } from '../../src/rag/indexer.service.js';
import { SearchService } from '../../src/rag/search.service.js';
import { CatalogService, type CatalogGraph } from '../../src/rag/catalog.service.js';
import { ComparisonService, type DuplicateNotes } from '../../src/rag/comparison.service.js';
import type { SearchHit } from '../../src/rag/types.js';
import { AclService } from '../../src/acl/acl.service.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { UsersService } from '../../src/auth/users.service.js';
import { UsersRepository } from '../../src/auth/users.repository.js';

const execute = promisify(execFile);
const resources: Array<{ root: string; db: Database.Database; app?: INestApplicationContext }> = [];
const journalContent = '# Daily journal\n\nKnowledge reviewed and learned.\n';
const userContent = 'The deployment process requires a review before release.';
function wikiNote(type: 'hub' | 'note', description: string, tags: readonly string[], body: string): string {
  return [
    '---',
    `type: ${type}`,
    'aliases: []',
    `description: ${description}`,
    'author: [도니]',
    'date created: 2026-10-10',
    'date modified: 2026-10-10',
    'tags:',
    ...tags.map((tag) => `  - ${tag}`),
    '---',
    '',
    body,
  ].join('\n');
}
const similarContent = wikiNote(
  'note',
  '배포마다 검토자가 승인한다.',
  ['release', 'review'],
  '# Release process\n\nA reviewer approves each release.\n',
);
const engineeringIndexContent = wikiNote(
  'hub',
  '엔지니어링 분야의 배포 노트로 이동하는 탐색 경로다.',
  ['engineering', 'reference'],
  '# Engineering\n\n- [[release]]\n',
);
const deploymentContent = wikiNote(
  'note',
  '릴리스 전에 검토가 필요하다.',
  ['release', 'review'],
  '# Deployment\n\nReleases require review.\n',
);
const dreamingReleaseContent = wikiNote(
  'note',
  '꿈꾸기에서 검토한 배포 노트의 내용이다.',
  ['release', 'review'],
  'dreaming review\n',
);
const concurrentReleaseContent = wikiNote(
  'note',
  '동시에 들어온 배포 검토 결과다.',
  ['release', 'review'],
  'concurrent review\n',
);
const mergedReleaseContent = wikiNote(
  'note',
  '꿈꾸기와 동시 편집의 배포 검토 결과를 함께 담는다.',
  ['release', 'review'],
  'dreaming review\nconcurrent review\n',
);
const similarHit: SearchHit = {
  path: 'wiki/engineering/release.md', title: 'Release process', heading: '',
  snippet: 'A reviewer approves each release.', score: 0.9, kind: 'wiki', related: [],
  anchor: null, excerpt: 'A reviewer approves each release.', highlights: [], tags: [], updatedAt: null,
  type: null, description: null,
};
type Author = { name: string; email: string };
type MessageInput = { id: string; conversation_id: string; content: string; created_at: string };
type DreamInput = {
  date: string; fromSha: string; toSha: string; commits: CommitInfo[];
  changedNotes: Array<{ change: FileChange; content: string | null; similarNotes: Array<{ path: string; title: string; excerpt: string }> }>;
  userMessages: MessageInput[];
  mode: 'local' | 'structural' | 'sweep';
  focus: string | null;
  structure: { signals: StructureSignals; focus: string | null; files: string[] };
};

@Module({})
class DreamingTestModule {}

// This fixture implements the git seam directly without constructing KnowledgeRepo.
class TempRepo {
  readonly path: string;
  readonly origin: string;
  worktreeCount = 0;
  pushCount = 0;
  pushError: Error | null = null;
  private mergeTail: Promise<unknown> = Promise.resolve();

  constructor(readonly root: string, readonly config: Config) {
    this.path = join(root, 'knowledge');
    this.origin = join(root, 'origin.git');
  }

  async git(args: string[], cwd = this.path): Promise<string> {
    const { stdout } = await execute('git', args, {
      cwd,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout.trimEnd();
  }

  async init(): Promise<void> {
    await mkdir(this.path);
    await this.git(['init', '-b', 'main']);
    await this.git(['config', 'user.name', this.config.gitBotName]);
    await this.git(['config', 'user.email', this.config.gitBotEmail]);
    await this.git(['config', 'commit.gpgsign', 'false']);
    await this.git(['config', 'core.hooksPath', '/dev/null']);
    await mkdir(join(this.path, 'wiki/engineering'), { recursive: true });
    await writeFile(join(this.path, 'wiki/engineering/release.md'), similarContent);
    await writeFile(join(this.path, 'wiki/engineering/index.md'), engineeringIndexContent);
    await writeFile(join(this.path, 'index.md'), '# Knowledge\n\n- [[wiki/engineering/index]]\n');
    await writeFile(join(this.path, 'AGENTS.md'), 'Use verified facts.\n');
    await this.git(['add', '.']);
    await this.git(['commit', '-m', 'Initial knowledge']);
    await this.git(['init', '--bare', this.origin]);
    await this.git(['remote', 'add', 'origin', this.origin]);
  }

  headSha(): Promise<string> { return this.git(['rev-parse', 'main']); }
  async readFile(path: string, ref = 'main'): Promise<string | null> {
    try { return (await execute('git', ['show', `${ref}:${path}`], { cwd: this.path })).stdout; }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 128) return null;
      throw error;
    }
  }
  async listFiles(prefix = '', ref = 'main'): Promise<string[]> {
    return (await this.git(['ls-tree', '-r', '--name-only', ref])).split('\n')
      .filter((path) => /\.md$/i.test(path) && path.startsWith(prefix));
  }
  async diffNames(fromSha: string | null, toSha: string): Promise<FileChange[]> {
    const args = fromSha
      ? ['diff', '--name-status', '-M', fromSha, toSha]
      : ['diff', '--name-status', '-M', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', toSha];
    return (await this.git(args)).split('\n').filter(Boolean).map((line) => {
      const [status, first, second] = line.split('\t');
      return status.startsWith('R')
        ? { status: 'R', path: second, oldPath: first }
        : { status: status as FileChange['status'], path: first };
    });
  }
  async log(opts: { path?: string; limit?: number; sinceSha?: string; beforeSha?: string } = {}): Promise<CommitInfo[]> {
    const ref = opts.beforeSha ? `${opts.beforeSha}^` : 'main';
    const args = ['log', '--format=%H', opts.sinceSha ? `${opts.sinceSha}..${ref}` : ref];
    if (opts.limit !== undefined) args.push(`--max-count=${opts.limit}`);
    if (opts.path) args.push('--', opts.path);
    const shas = (await this.git(args)).split('\n').filter(Boolean);
    return Promise.all(shas.map((sha) => this.commitInfo(sha)));
  }
  private async commitInfo(sha: string): Promise<CommitInfo> {
    const [hash, parents, authorName, authorEmail, date, committerName, committerEmail, committedAt, subject, body, trailerText] =
      (await this.git(['show', '-s', '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s%x00%b%x00%(trailers:only,unfold)', sha])).split('\0');
    const trailers: Record<string, string> = {};
    for (const line of trailerText.split('\n')) {
      const separator = line.indexOf(':');
      if (separator > 0) trailers[line.slice(0, separator)] = line.slice(separator + 1).trim();
    }
    return { sha: hash, parents: parents ? parents.split(' ') : [], authorName, authorEmail, date,
      committerName, committerEmail, committedAt, subject, body, trailers };
  }
  async show(sha: string): Promise<{ commit: CommitInfo; files: FileChange[]; patch: string }> {
    const commit = await this.commitInfo(sha);
    return { commit, files: await this.diffNames(commit.parents[0] ?? null, sha), patch: await this.git(['show', '--format=', sha]) };
  }
  async createWorktree(name: string): Promise<TempWorktree> {
    this.worktreeCount++;
    const path = join(this.root, 'worktrees', name);
    await mkdir(dirname(path), { recursive: true });
    const baseSha = await this.headSha();
    const branch = `work/${name}`;
    await this.git(['worktree', 'add', '-b', branch, path, 'main']);
    return new TempWorktree(this, path, branch, baseSha);
  }
  withMergeLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.mergeTail.then(fn);
    this.mergeTail = result.catch(() => undefined);
    return result;
  }
  async pushMain(): Promise<{ pushed: boolean }> {
    this.pushCount++;
    if (this.pushError) throw this.pushError;
    await this.git(['push', 'origin', 'main']);
    return { pushed: true };
  }
  async change(path = 'wiki/engineering/deployment.md', content = deploymentContent): Promise<string> {
    await mkdir(dirname(join(this.path, path)), { recursive: true });
    await writeFile(join(this.path, path), content);
    await this.git(['add', '.']);
    await this.git(['commit', '-m', 'Add deployment knowledge']);
    return this.headSha();
  }
}

class TempWorktree {
  private metadata: CommitMetadata | undefined;
  constructor(readonly repo: TempRepo, readonly path: string, readonly branch: string, readonly baseSha: string) {}
  setCommitMetadata(metadata: CommitMetadata): void { this.metadata = metadata; }
  async read(path: string): Promise<string | null> {
    try { return await readFile(join(this.path, path), 'utf8'); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }
  async write(path: string, content: string): Promise<void> {
    await mkdir(dirname(join(this.path, path)), { recursive: true });
    await writeFile(join(this.path, path), content);
  }
  async remove(path: string): Promise<void> { await rm(join(this.path, path), { force: true }); }
  async move(from: string, to: string): Promise<void> {
    await mkdir(dirname(join(this.path, to)), { recursive: true });
    await rename(join(this.path, from), join(this.path, to));
  }
  async list(prefix = ''): Promise<string[]> {
    const files = await this.repo.git(['ls-files', '--cached', '--others', '--exclude-standard'], this.path);
    return [...new Set(files.split('\n').filter((path) => path && path.startsWith(prefix)))];
  }
  async commit(message: string, author: Author): Promise<string | null> {
    await this.repo.git(['add', '-A'], this.path);
    if (!(await this.repo.git(['diff', '--cached', '--name-only'], this.path))) return null;
    const fullMessage = this.metadata ? `${message}\n\n${commitTrailers(this.metadata)}` : message;
    await this.repo.git(['commit', '--author', `${author.name} <${author.email}>`, '-m', fullMessage], this.path);
    return this.repo.git(['rev-parse', 'HEAD'], this.path);
  }
  async mergeMain(): Promise<{ ok: true } | { ok: false; conflicts: string[] }> {
    try { await this.repo.git(['merge', '--no-edit', 'main'], this.path); return { ok: true }; }
    catch (error) {
      const conflicts = await this.conflictedFiles();
      if (conflicts.length) return { ok: false, conflicts };
      throw error;
    }
  }
  async conflictedFiles(): Promise<string[]> {
    return (await this.repo.git(['diff', '--name-only', '--diff-filter=U'], this.path)).split('\n').filter(Boolean);
  }
  async finishMerge(author: Author): Promise<string> {
    await this.repo.git(['add', '-A'], this.path);
    await this.repo.git(['commit', '--no-edit', '--author', `${author.name} <${author.email}>`], this.path);
    return this.repo.git(['rev-parse', 'HEAD'], this.path);
  }
  async fastForwardMain(): Promise<string> {
    await this.repo.git(['merge', '--ff-only', this.branch]);
    return this.repo.headSha();
  }
  async dispose(): Promise<void> {
    await this.repo.git(['worktree', 'remove', '--force', this.path]);
    await this.repo.git(['branch', '-D', this.branch]);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function inputOf(options: RunAgentOptions): DreamInput {
  if (typeof options.input !== 'string') throw new Error('Dream input must be JSON text');
  return JSON.parse(options.input) as DreamInput;
}
async function writeJournal(options: RunAgentOptions, content = journalContent): Promise<void> {
  const tool = options.tools.find((candidate) => candidate.name === 'write_file');
  if (!tool) throw new Error('Dream run must provide worktree write tools');
  await tool.run({ path: `journal/${inputOf(options).date}.md`, content });
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'llmwiki-dreaming-'));
  const db = new Database(':memory:');
  resources.push({ root, db });
  for (const migration of ['001_core', '002_auth', '005_dreaming', '008_ops', '011_platform', '013_acl', '021_dream_modes', '027_user_passwords']) db.exec(await readFile(new URL(`../../src/db/migrations/${migration}.sql`, import.meta.url), 'utf8'));
  db.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')), content TEXT NOT NULL,
    citations TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, learned_at TEXT
  )`);
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: root, GIT_BOT_NAME: 'Dream Bot', GIT_BOT_EMAIL: 'dream@example.test' });
  const logs: Record<string, unknown>[] = [];
  const log = pino({ level: 'info' }, { write: line => { logs.push(JSON.parse(line)); } });
  const repo = new TempRepo(root, config);
  await repo.init();
  const baseSha = await repo.headSha();
  const runAgent = vi.fn(async (options: RunAgentOptions) => {
    await writeJournal(options);
    return { text: 'Knowledge reviewed.', toolCalls: 1 };
  });
  const indexer = { syncToHead: vi.fn(async () => ({ indexedSha: await repo.headSha(), changedFiles: 1 })) };
  const search = { search: vi.fn(async () => [similarHit]) };
  const catalog = { graph: vi.fn((): CatalogGraph => ({
    nodes: [{ path: similarHit.path, title: similarHit.title, tags: [] }],
    edges: [],
  })) };
  const comparison = { duplicates: vi.fn(async (): Promise<DuplicateNotes[]> => []) };
  const agent = {
    runAgent,
    baseInstructions: async () => 'Use verified facts.',
    worktreeTools: (worktree: Worktree, author: Author): AgentTool[] => [
      { name: 'write_file', description: 'Write a note', parameters: { type: 'object' },
        run: async ({ path, content }: { path: string; content: string }) => { await worktree.write(path, content); return 'written'; } },
      { name: 'move_file', description: 'Move a note', parameters: { type: 'object' },
        run: async ({ from, to }: { from: string; to: string }) => { await worktree.move(from, to); return 'moved'; } },
      { name: 'commit', description: 'Commit notes', parameters: { type: 'object' },
        run: async ({ message }: { message: string }) => JSON.stringify({ sha: await worktree.commit(message, author) }) },
    ],
    resolveConflicts: vi.fn(async (_worktree: Worktree, _files: string[], _user?: unknown, _options?: Pick<RunAgentOptions, 'onUsage'>) => { throw new Error('Unexpected merge conflict'); }),
  };
  const app = await NestFactory.createApplicationContext({
    module: DreamingTestModule,
    providers: [
      { provide: CONFIG, useValue: config },
      { provide: DB, useValue: db },
      { provide: LOGGER, useValue: log },
      { provide: KnowledgeRepo, useValue: repo },
      { provide: AgentService, useValue: agent },
      { provide: IndexerService, useValue: indexer },
      { provide: SearchService, useValue: search },
      { provide: CatalogService, useValue: catalog },
      { provide: ComparisonService, useValue: comparison },
      AuditService,
      { provide: UsersService, useValue: new UsersService(new UsersRepository(db)) },
      AclService,
      DreamRunsRepository,
      EventsService,
      DreamingService,
      { provide: 'otherDreaming', useClass: DreamingService },
    ],
  }, { logger: false, abortOnError: false });
  resources[resources.length - 1].app = app;
  const dreaming = app.get(DreamingService);
  const otherDreaming = app.get<DreamingService>('otherDreaming');
  const conversationId = newId();
  const addMessage = (role: 'user' | 'assistant' = 'user', createdAt = '2020-01-01T00:00:00.000Z', learnedAt: string | null = null) => {
    const id = newId();
    db.prepare('INSERT INTO messages (id, conversation_id, role, content, created_at, learned_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(toStorageId(id), toStorageId(conversationId), role, role === 'user' ? userContent : 'Assistant-only unsupported claim.', createdAt, learnedAt);
    return id;
  };
  const learnedAt = (id: string): string | null => {
    const row = db.prepare('SELECT learned_at FROM messages WHERE id = ?').get(toStorageId(id));
    if (!row || typeof row !== 'object' || !('learned_at' in row)
      || (row.learned_at !== null && typeof row.learned_at !== 'string')) {
      throw new Error(`Invalid message row: ${id}`);
    }
    return row.learned_at;
  };
  const checkpoint = (sha: string) => db.prepare(`INSERT INTO dream_runs
    (id, started_at, finished_at, status, from_sha, to_sha, merge_sha, pushed)
    VALUES (?, '2020-01-01T00:00:00.000Z', '2020-01-01T00:01:00.000Z', 'succeeded', ?, ?, ?, 1)`)
    .run(toStorageId(newId()), baseSha, sha, sha);
  return { app, dreaming, otherDreaming, db, repo, baseSha, runAgent, agent, logs, indexer, search, addMessage, learnedAt, checkpoint, conversationId };
}

afterEach(async () => {
  await Promise.all(resources.splice(0).map(async ({ root, db, app }) => {
    await app?.close();
    if (db.open) db.close();
    await rm(root, { recursive: true, force: true });
  }));
});

describe('DreamingService.runOnce', () => {
  it('logs complete dreaming and conflict totals after a successful merge', async () => {
    const f = await fixture();
    f.addMessage();
    f.runAgent.mockImplementationOnce(async (options) => {
      options.onUsage?.({ inputTokens: 100, cachedInputTokens: 60, outputTokens: 20, reasoningTokens: 6 });
      await writeJournal(options);
      const write = options.tools.find(tool => tool.name === 'write_file')!;
      await write.run({ path: 'wiki/engineering/release.md', content: dreamingReleaseContent });
      await f.repo.change('wiki/engineering/release.md', concurrentReleaseContent);
      options.onUsage?.({ inputTokens: 80, cachedInputTokens: 40, outputTokens: 12, reasoningTokens: 3 });
      return { text: 'Reviewed knowledge.', toolCalls: 2 };
    });
    f.agent.resolveConflicts.mockImplementationOnce(async (wt, files, _user, options) => {
      expect(files).toEqual(['wiki/engineering/release.md']);
      options?.onUsage?.({ inputTokens: 50, cachedInputTokens: 20, outputTokens: 10, reasoningTokens: 2 });
      await wt.write('wiki/engineering/release.md', mergedReleaseContent);
      options?.onUsage?.({ inputTokens: 30, cachedInputTokens: 10, outputTokens: 5, reasoningTokens: 1 });
    });
    const run = await f.dreaming.runOnce();
    expect(run.status).toBe('succeeded');
    expect(await f.repo.readFile('wiki/engineering/release.md')).toBe(mergedReleaseContent);
    expect(f.logs.find(log => log.msg === 'Dreaming completed' && log.runId === run.id)).toMatchObject({
      usage: { inputTokens: 260, cachedInputTokens: 130, outputTokens: 47, reasoningTokens: 12 },
    });
  });

  it('logs consumed responses when dreaming fails before producing a result', async () => {
    const f = await fixture();
    const message = f.addMessage();
    const head = await f.repo.headSha();
    f.runAgent.mockImplementationOnce(async (options) => {
      options.onUsage?.({ inputTokens: 90, cachedInputTokens: 40, outputTokens: 18, reasoningTokens: 5 });
      await writeJournal(options);
      options.onUsage?.({ inputTokens: 70, cachedInputTokens: 30, outputTokens: 10, reasoningTokens: 2 });
      throw new Error('Provider stopped before completion');
    });
    const run = await f.dreaming.runOnce();
    expect(run.status).toBe('failed');
    expect(await f.repo.headSha()).toBe(head);
    expect(f.learnedAt(message)).toBeNull();
    expect(f.logs.find(log => log.msg === 'Dreaming failed' && log.runId === run.id)).toMatchObject({
      error: 'Provider stopped before completion',
      usage: { inputTokens: 160, cachedInputTokens: 70, outputTokens: 28, reasoningTokens: 7 },
    });
  });

  it('pushes without an agent or worktree when there are no inputs or sweepable notes', async () => {
    const f = await fixture();
    await f.repo.git(['rm', 'wiki/engineering/release.md', 'wiki/engineering/index.md']);
    await f.repo.git(['commit', '-m', 'Remove sweepable knowledge']);
    const head = await f.repo.headSha();
    f.checkpoint(head);
    const run = await f.dreaming.runOnce();
    expect(run).toMatchObject({
      status: 'succeeded', fromSha: head, toSha: head, mode: null, focus: null,
      mergeSha: null, journalPath: null, structuralChanges: [], pushed: true, error: null,
    });
    expect(f.runAgent).not.toHaveBeenCalled();
    expect(await f.repo.headSha()).toBe(head);
    expect(f.indexer.syncToHead).not.toHaveBeenCalled();
    expect(f.repo.worktreeCount).toBe(0);
    expect(f.repo.pushCount).toBe(1);
    expect(await f.repo.git(['rev-parse', 'main'], f.repo.origin)).toBe(head);
    expect(f.logs.find(log => log.msg === 'Dreaming completed' && log.runId === run.id)).toMatchObject({
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
    });
  });

  it('reviews only post-baseline changes, merges a dated journal into main, and pushes the actual result', async () => {
    const f = await fixture();
    const toSha = await f.repo.change();
    const run = await f.dreaming.runOnce();
    const input = inputOf(f.runAgent.mock.calls[0][0]);
    const kstDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(run.startedAt));
    expect(run).toMatchObject({ status: 'succeeded', fromSha: f.baseSha, toSha, mode: 'local', focus: null, pushed: true, error: null });
    expect(run.finishedAt).not.toBeNull();
    expect(input).toMatchObject({ date: kstDate, fromSha: f.baseSha, toSha, mode: 'local', focus: null });
    expect(input.commits.map((commit) => commit.sha)).toEqual([toSha]);
    expect(input.changedNotes).toEqual([{
      change: { status: 'A', path: 'wiki/engineering/deployment.md' },
      content: deploymentContent,
      similarNotes: [{ path: similarHit.path, title: similarHit.title, excerpt: similarHit.excerpt }],
    }]);
    expect(await f.repo.readFile(`journal/${kstDate}.md`)).toBe(journalContent);
    expect(run.mergeSha).toBe(await f.repo.headSha());
    expect(run.mergeSha).not.toBe(toSha);
    const commit = (await f.repo.show(run.mergeSha!)).commit;
    expect(commit).toMatchObject({ authorName: 'Dream Bot', authorEmail: 'dream@example.test' });
    expect(f.repo.pushCount).toBe(1);
    expect(await f.repo.git(['rev-parse', 'main'], f.repo.origin)).toBe(run.mergeSha);
    expect(f.indexer.syncToHead).toHaveBeenCalledTimes(1);
  });

  it('bounds related-note excerpts instead of injecting their full bodies', async () => {
    const f = await fixture();
    const longExcerpt = 'Grounded related fact. '.repeat(200);
    f.search.search.mockResolvedValue([{ ...similarHit, excerpt: longExcerpt }]);
    await f.repo.change();
    const run = await f.dreaming.runOnce();
    expect(run.status).toBe('succeeded');
    const related = inputOf(f.runAgent.mock.calls[0][0]).changedNotes[0].similarNotes[0];
    expect(related).toEqual({ path: similarHit.path, title: similarHit.title, excerpt: longExcerpt.slice(0, 1500) });
    expect(related).not.toHaveProperty('content');
  });

  it('keeps main untouched when Dony fails, but still pushes main', async () => {
    const f = await fixture();
    const head = await f.repo.change();
    const messageId = f.addMessage();
    f.runAgent.mockImplementationOnce(async (options) => {
      await writeJournal(options);
      throw new Error('Dony unavailable');
    });
    const run = await f.dreaming.runOnce();
    expect(run).toMatchObject({ status: 'failed', mergeSha: null, pushed: true });
    expect(run.error).toContain('Dony unavailable');
    expect(await f.repo.headSha()).toBe(head);
    expect(await f.repo.listFiles('journal/')).toEqual([]);
    expect(f.learnedAt(messageId)).toBeNull();
    expect(f.indexer.syncToHead).not.toHaveBeenCalled();
    expect(f.repo.pushCount).toBe(1);
    expect(await f.repo.git(['rev-parse', 'main'], f.repo.origin)).toBe(head);
  });

  it('supplies only eligible user backlog and marks it learned after merge and indexing complete', async () => {
    const f = await fixture();
    const backlog = f.addMessage();
    const assistant = f.addMessage('assistant');
    const future = f.addMessage('user', '2999-01-01T00:00:00.000Z');
    const alreadyLearned = f.addMessage('user', '2020-01-01T00:00:00.000Z', '2020-01-02T00:00:00.000Z');
    const entered = deferred();
    const release = deferred();
    f.indexer.syncToHead.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { indexedSha: await f.repo.headSha(), changedFiles: 1 };
    });
    const pending = f.dreaming.runOnce();
    await entered.promise;
    try {
      expect(await f.repo.listFiles('journal/')).toEqual([`journal/${inputOf(f.runAgent.mock.calls[0][0]).date}.md`]);
      expect(f.learnedAt(backlog)).toBeNull();
    } finally {
      release.resolve();
    }
    const run = await pending;
    expect(run.status).toBe('succeeded');
    const input = inputOf(f.runAgent.mock.calls[0][0]);
    expect(input.userMessages).toEqual([{ id: backlog, conversation_id: f.conversationId, content: userContent, created_at: '2020-01-01T00:00:00.000Z' }]);
    expect(JSON.stringify(input)).not.toContain('Assistant-only unsupported claim.');
    expect(f.learnedAt(backlog)).toEqual(expect.any(String));
    expect(f.learnedAt(assistant)).toBeNull();
    expect(f.learnedAt(future)).toBeNull();
    expect(f.learnedAt(alreadyLearned)).toBe('2020-01-02T00:00:00.000Z');
  });

  it('joins concurrent callers across service instances sharing one repo', async () => {
    const f = await fixture();
    f.addMessage();
    const entered = deferred();
    const release = deferred();
    f.runAgent.mockImplementationOnce(async (options) => {
      entered.resolve();
      await release.promise;
      await writeJournal(options);
      return { text: 'Completed once.', toolCalls: 1 };
    });
    const first = f.dreaming.runOnce();
    await entered.promise;
    const second = f.otherDreaming.runOnce();
    release.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(a.id).toBe(b.id);
    expect(a.status).toBe('succeeded');
    expect(f.runAgent).toHaveBeenCalledTimes(1);
    expect(f.repo.worktreeCount).toBe(1);
    expect(await f.repo.listFiles('journal/')).toEqual([`journal/${inputOf(f.runAgent.mock.calls[0][0]).date}.md`]);
    expect(f.db.prepare('SELECT id FROM dream_runs').all()).toEqual([{ id: toStorageId(a.id) }]);
    expect(f.repo.pushCount).toBe(1);
  });

  it('sweeps existing notes and merges a journal when checkpoint equals head', async () => {
    const f = await fixture();
    const head = await f.repo.headSha();
    f.checkpoint(head);
    const run = await f.dreaming.runOnce();
    const input = inputOf(f.runAgent.mock.calls[0][0]);
    const journalPath = `journal/${input.date}.md`;
    expect(run).toMatchObject({
      status: 'succeeded', fromSha: head, toSha: head, mode: 'sweep', focus: 'wiki/engineering/',
      journalPath, changedPaths: [journalPath], structuralChanges: [], pushed: true, error: null,
    });
    expect(input).toMatchObject({
      mode: 'sweep', focus: 'wiki/engineering/', commits: [], changedNotes: [], userMessages: [],
      structure: { focus: 'wiki/engineering/', files: ['wiki/engineering/index.md', 'wiki/engineering/release.md'] },
    });
    expect(await f.repo.readFile(journalPath)).toBe(journalContent);
    expect(await f.repo.headSha()).toBe(run.mergeSha);
    expect(run.mergeSha).not.toBe(head);
    expect(f.runAgent).toHaveBeenCalledTimes(1);
    expect(f.indexer.syncToHead).toHaveBeenCalledTimes(1);
    expect(f.repo.worktreeCount).toBe(1);
    expect(f.repo.pushCount).toBe(1);
    expect(await f.repo.git(['rev-parse', 'main'], f.repo.origin)).toBe(run.mergeSha);
  });

  it('retries unlearned backlog after a failed attempt rather than advancing the checkpoint', async () => {
    const f = await fixture();
    const head = await f.repo.change();
    f.checkpoint(f.baseSha);
    const messageId = f.addMessage();
    f.runAgent.mockRejectedValueOnce(new Error('Temporary Dony failure'));
    const dreaming = f.dreaming;
    const failed = await dreaming.runOnce();
    expect(failed.status).toBe('failed');
    expect(f.learnedAt(messageId)).toBeNull();
    const retried = await dreaming.runOnce();
    expect(retried).toMatchObject({ status: 'succeeded', fromSha: f.baseSha, toSha: head });
    for (const [options] of f.runAgent.mock.calls) {
      expect(inputOf(options).userMessages.map((message) => message.id)).toEqual([messageId]);
    }
    expect(f.learnedAt(messageId)).toEqual(expect.any(String));
    expect(f.repo.pushCount).toBe(2);
  });

  it('does not learn messages if indexing fails after their journal reaches main', async () => {
    const f = await fixture();
    const messageId = f.addMessage();
    f.indexer.syncToHead.mockRejectedValueOnce(new Error('Index unavailable'));
    const run = await f.dreaming.runOnce();
    expect(run.status).toBe('failed');
    expect(run.error).toContain('Index unavailable');
    expect(await f.repo.readFile(`journal/${inputOf(f.runAgent.mock.calls[0][0]).date}.md`)).toBe(journalContent);
    expect(f.learnedAt(messageId)).toBeNull();
    expect(f.repo.pushCount).toBe(1);
  });

  it('preserves the local checkpoint and learned messages when only backup push fails', async () => {
    const f = await fixture();
    const inputSha = await f.repo.change();
    const messageId = f.addMessage();
    f.repo.pushError = new Error('Backup unavailable');
    const run = await f.dreaming.runOnce();
    expect(run).toMatchObject({ status: 'succeeded', error: null, toSha: inputSha, pushed: false,
      push: { status: 'failed', reason: 'Backup unavailable' } });
    expect(await f.repo.readFile(`journal/${inputOf(f.runAgent.mock.calls[0][0]).date}.md`)).toBe(journalContent);
    expect(f.learnedAt(messageId)).toEqual(expect.any(String));
    expect(f.repo.pushCount).toBe(1);
    const next = await f.dreaming.runOnce();
    expect(next).toMatchObject({ status: 'succeeded', error: null, fromSha: inputSha });
    const nextInput = inputOf(f.runAgent.mock.calls[1][0]);
    expect(nextInput.commits.map(commit => commit.sha)).not.toContain(inputSha);
    expect(nextInput.changedNotes.map(note => note.change.path)).not.toContain('wiki/deployment.md');
    expect(nextInput.userMessages).toEqual([]);
  });

  it('pins the input snapshot and reviews concurrently added main commits on the next run', async () => {
    const f = await fixture();
    const sampledSha = await f.repo.change();
    const originalLog = f.repo.log.bind(f.repo);
    let concurrentSha: string | undefined;
    const concurrentContent = wikiNote(
      'note',
      '꿈꾸기 시작 후 도착한 지식을 보존한다.',
      ['knowledge'],
      '# Later knowledge\n\nThis arrived after the dream started.\n',
    );
    f.repo.log = async (options) => {
      if (!concurrentSha) concurrentSha = await f.repo.change('wiki/engineering/later.md', concurrentContent);
      return originalLog(options);
    };
    const dreaming = f.dreaming;
    const first = await dreaming.runOnce();
    expect(first).toMatchObject({ status: 'succeeded', toSha: sampledSha });
    const firstInput = inputOf(f.runAgent.mock.calls[0][0]);
    expect(firstInput.commits.map((commit) => commit.sha)).toEqual([sampledSha]);
    expect(firstInput.changedNotes.map((note) => note.change.path)).toEqual(['wiki/engineering/deployment.md']);
    expect(await f.repo.readFile('wiki/engineering/later.md')).toBe(concurrentContent);
    expect(first.mergeSha).not.toBe(sampledSha);

    const second = await dreaming.runOnce();
    expect(second).toMatchObject({ status: 'succeeded', fromSha: sampledSha, toSha: first.mergeSha });
    const secondInput = inputOf(f.runAgent.mock.calls[1][0]);
    expect(secondInput.commits.map((commit) => commit.sha)).toContain(concurrentSha);
    expect(secondInput.changedNotes).toContainEqual(expect.objectContaining({
      change: { status: 'A', path: 'wiki/engineering/later.md' }, content: concurrentContent,
    }));
  });

  it('allows broken links introduced by concurrent main changes during the agent run', async () => {
    const f = await fixture();
    const messageId = f.addMessage();
    const sampledSha = await f.repo.headSha();
    const concurrentContent = wikiNote(
      'note',
      '아직 대상이 없는 위키링크를 기록한다.',
      ['reference'],
      '# Concurrent note\n\n[[missing-concurrent-note]]\n',
    );
    let concurrentSha: string | undefined;
    f.runAgent.mockImplementationOnce(async (options) => {
      await writeJournal(options);
      concurrentSha = await f.repo.change('wiki/engineering/concurrent.md', concurrentContent);
      return { text: 'Reviewed the captured inputs.', toolCalls: 1 };
    });

    const run = await f.dreaming.runOnce();

    expect(run).toMatchObject({ status: 'succeeded', toSha: sampledSha, pushed: true, error: null });
    expect(run.mergeSha).toBe(await f.repo.headSha());
    expect(run.mergeSha).not.toBe(concurrentSha);
    expect(run.changedPaths).toEqual([run.journalPath]);
    expect(await f.repo.readFile('wiki/engineering/concurrent.md')).toBe(concurrentContent);
    expect(await f.repo.readFile(run.journalPath!)).toBe(journalContent);
    expect(f.learnedAt(messageId)).toEqual(expect.any(String));
    expect(await f.repo.git(['rev-parse', 'main'], f.repo.origin)).toBe(run.mergeSha);
  });

  it('allows unresolved links inherited when main advances before worktree creation', async () => {
    const f = await fixture();
    f.addMessage();
    const sampledSha = await f.repo.headSha();
    const originalCreateWorktree = f.repo.createWorktree.bind(f.repo);
    const concurrentContent = wikiNote(
      'note',
      '워크트리 생성 전에 들어온 미해결 위키링크를 보존한다.',
      ['reference'],
      '# Inherited note\n\n[[missing-before-worktree]]\n',
    );
    let concurrentSha: string | undefined;
    f.repo.createWorktree = async (name) => {
      concurrentSha = await f.repo.change('wiki/engineering/inherited.md', concurrentContent);
      return originalCreateWorktree(name);
    };

    const run = await f.dreaming.runOnce();

    expect(run).toMatchObject({ status: 'succeeded', toSha: sampledSha, pushed: true, error: null });
    expect(inputOf(f.runAgent.mock.calls[0][0]).toSha).toBe(sampledSha);
    expect(run.mergeSha).toBe(await f.repo.headSha());
    expect(run.mergeSha).not.toBe(concurrentSha);
    expect(await f.repo.readFile('wiki/engineering/inherited.md')).toBe(concurrentContent);
    expect(await f.repo.readFile(run.journalPath!)).toBe(journalContent);
  });

  it('retains captured unresolved targets when concurrent main repairs them', async () => {
    const f = await fixture();
    const olderContent = wikiNote(
      'note',
      '아직 해결되지 않은 위키링크 대상을 보존한다.',
      ['reference'],
      '# Older note\n\n[[missing-before-run]]\n',
    );
    const repairedContent = wikiNote(
      'note',
      '해결되지 않은 위키링크를 제거한 결과를 기록한다.',
      ['reference'],
      '# Older note\n\nThe unresolved reference was removed.\n',
    );
    const sampledSha = await f.repo.change('wiki/engineering/older.md', olderContent);
    const journal = `${journalContent}\nStill unresolved: [[missing-before-run]]\n`;
    f.runAgent.mockImplementationOnce(async (options) => {
      await writeJournal(options, journal);
      await f.repo.change('wiki/engineering/older.md', repairedContent);
      return { text: 'Preserved an existing unresolved target.', toolCalls: 1 };
    });

    const run = await f.dreaming.runOnce();

    expect(run).toMatchObject({ status: 'succeeded', toSha: sampledSha, pushed: true, error: null });
    expect(await f.repo.readFile('wiki/engineering/older.md')).toBe(repairedContent);
    expect(await f.repo.readFile(run.journalPath!)).toBe(journal);
    expect(run.mergeSha).toBe(await f.repo.headSha());
  });

  it('rejects a dreaming move that breaks a link introduced by concurrent main', async () => {
    const f = await fixture();
    const messageId = f.addMessage();
    const concurrentContent = wikiNote(
      'note',
      '배포 노트와 미해결 위키링크를 함께 참조한다.',
      ['reference'],
      '# Concurrent note\n\n[[wiki/engineering/release]]\n[[missing-concurrent-note]]\n',
    );
    let concurrentSha: string | undefined;
    f.runAgent.mockImplementationOnce(async (options) => {
      await writeJournal(options);
      const move = options.tools.find(tool => tool.name === 'move_file')!;
      await move.run({ from: 'wiki/engineering/release.md', to: 'wiki/engineering/renamed-release.md' });
      await options.tools.find(tool => tool.name === 'write_file')!.run({
        path: 'wiki/engineering/index.md',
        content: wikiNote('hub', '엔지니어링 분야의 배포 노트로 이동하는 탐색 경로다.', ['engineering', 'reference'], '# Engineering\n\n- [[renamed-release]]\n'),
      });
      concurrentSha = await f.repo.change('wiki/engineering/concurrent.md', concurrentContent);
      return { text: 'Moved release knowledge.', toolCalls: 3 };
    });

    const run = await f.dreaming.runOnce();

    expect(run).toMatchObject({
      status: 'failed', mergeSha: null, pushed: true,
      error: 'Dreaming introduced broken links: wiki/engineering/release',
      structuralChanges: [{ kind: 'move', from: 'wiki/engineering/release.md', to: 'wiki/engineering/renamed-release.md' }],
    });
    expect(await f.repo.headSha()).toBe(concurrentSha);
    expect(await f.repo.readFile('wiki/engineering/release.md')).toBe(similarContent);
    expect(await f.repo.readFile('wiki/engineering/renamed-release.md')).toBeNull();
    expect(await f.repo.readFile('wiki/engineering/concurrent.md')).toBe(concurrentContent);
    expect(await f.repo.listFiles('journal/')).toEqual([]);
    expect(f.learnedAt(messageId)).toBeNull();
    expect(f.indexer.syncToHead).not.toHaveBeenCalled();
    expect(await f.repo.git(['rev-parse', 'main'], f.repo.origin)).toBe(concurrentSha);
  });

  it('rejects a broken link introduced in an uppercase markdown extension', async () => {
    const f = await fixture();
    f.addMessage();
    const head = await f.repo.headSha();
    f.runAgent.mockImplementationOnce(async (options) => {
      await writeJournal(options);
      await options.tools.find(tool => tool.name === 'write_file')!.run({
        path: 'wiki/engineering/UPPER.MD',
        content: wikiNote('note', '대문자 확장자 노트에서 미해결 위키링크를 기록한다.', ['reference'], '# Uppercase note\n\n[[missing-uppercase-target]]\n'),
      });
      return { text: 'Added an uppercase note.', toolCalls: 2 };
    });

    const run = await f.dreaming.runOnce();

    expect(run).toMatchObject({ status: 'failed', mergeSha: null, error: 'Dreaming introduced broken links: missing-uppercase-target' });
    expect(await f.repo.headSha()).toBe(head);
    expect(await f.repo.readFile('wiki/engineering/UPPER.MD')).toBeNull();
    expect(f.indexer.syncToHead).not.toHaveBeenCalled();
  });

  it('allows respelling an existing unresolved target with the same normalized identity', async () => {
    const f = await fixture();
    const unresolvedReferenceContent = wikiNote(
      'note',
      '대소문자와 확장자 표기를 정규화할 미해결 위키링크를 기록한다.',
      ['reference'],
      '# Reference\n\n[[Missing.MD]]\n',
    );
    const updated = wikiNote(
      'note',
      '대소문자와 확장자 표기를 정규화할 미해결 위키링크를 기록한다.',
      ['reference'],
      '# Reference\n\n[[missing]]\n',
    );
    const sampledSha = await f.repo.change('wiki/engineering/reference.MD', unresolvedReferenceContent);
    f.runAgent.mockImplementationOnce(async (options) => {
      await writeJournal(options);
      await options.tools.find(tool => tool.name === 'write_file')!.run({ path: 'wiki/engineering/reference.MD', content: updated });
      return { text: 'Normalized an existing unresolved target.', toolCalls: 2 };
    });

    const run = await f.dreaming.runOnce();

    expect(run).toMatchObject({ status: 'succeeded', toSha: sampledSha, pushed: true, error: null });
    expect(await f.repo.readFile('wiki/engineering/reference.MD')).toBe(updated);
    expect(run.mergeSha).toBe(await f.repo.headSha());
  });

  it('rejects a new basename collision that makes an existing resolved link ambiguous', async () => {
    const f = await fixture();
    const referenceContent = wikiNote(
      'note',
      '배포 노트로 향하는 위키링크를 기록한다.',
      ['reference'],
      '# Reference\n\n[[release]]\n',
    );
    const otherReleaseContent = wikiNote(
      'note',
      '다른 주제의 배포 검토를 설명한다.',
      ['release', 'review'],
      '# Another release\n\nA different topic.\n',
    );
    const head = await f.repo.change('wiki/engineering/reference.md', referenceContent);
    f.runAgent.mockImplementationOnce(async (options) => {
      await writeJournal(options);
      await options.tools.find(tool => tool.name === 'write_file')!.run({
        path: 'wiki/other/release.md', content: otherReleaseContent,
      });
      return { text: 'Added another release note.', toolCalls: 2 };
    });

    const run = await f.dreaming.runOnce();

    expect(run).toMatchObject({ status: 'failed', mergeSha: null, error: 'Dreaming introduced broken links: release' });
    expect(await f.repo.headSha()).toBe(head);
    expect(await f.repo.readFile('wiki/other/release.md')).toBeNull();
    expect(await f.repo.readFile('wiki/engineering/reference.md')).toBe(referenceContent);
    expect(f.indexer.syncToHead).not.toHaveBeenCalled();
  });

  it('allows a new embed targeting an existing asset', async () => {
    const f = await fixture();
    await f.repo.change('assets/diagram.png', 'image bytes');
    const content = wikiNote('note', '문서에 기존 이미지 첨부를 임베드한다.', ['media', 'reference'], '# Diagram\n\n![[assets/diagram.png]]\n');
    f.runAgent.mockImplementationOnce(async (options) => {
      await writeJournal(options);
      await options.tools.find(tool => tool.name === 'write_file')!.run({ path: 'wiki/engineering/diagram.md', content });
      return { text: 'Referenced an existing asset.', toolCalls: 2 };
    });

    const run = await f.dreaming.runOnce();

    expect(run).toMatchObject({ status: 'succeeded', pushed: true, error: null });
    expect(await f.repo.readFile('wiki/engineering/diagram.md')).toBe(content);
    expect(await f.repo.readFile('assets/diagram.png')).toBe('image bytes');
    expect(run.mergeSha).toBe(await f.repo.headSha());
  });

  it('rejects a move that breaks an existing asset embed', async () => {
    const f = await fixture();
    await f.repo.change('assets/diagram.png', 'image bytes');
    const content = wikiNote('note', '문서에 기존 이미지 첨부를 임베드한다.', ['media', 'reference'], '# Diagram\n\n![[assets/diagram.png]]\n');
    const head = await f.repo.change('wiki/engineering/diagram.md', content);
    f.runAgent.mockImplementationOnce(async (options) => {
      await writeJournal(options);
      await options.tools.find(tool => tool.name === 'move_file')!.run({ from: 'assets/diagram.png', to: 'assets/renamed.png' });
      return { text: 'Moved an embedded asset.', toolCalls: 2 };
    });

    const run = await f.dreaming.runOnce();

    expect(run).toMatchObject({ status: 'failed', mergeSha: null, error: 'Dreaming introduced broken links: assets/diagram.png' });
    expect(await f.repo.headSha()).toBe(head);
    expect(await f.repo.readFile('assets/diagram.png')).toBe('image bytes');
    expect(await f.repo.readFile('assets/renamed.png')).toBeNull();
    expect(await f.repo.readFile('wiki/engineering/diagram.md')).toBe(content);
    expect(f.indexer.syncToHead).not.toHaveBeenCalled();
  });

  it('rejects a new asset basename collision that makes an existing embed ambiguous', async () => {
    const f = await fixture();
    await f.repo.change('assets/diagram.png', 'image bytes');
    const content = wikiNote('note', '파일명으로 이미지 첨부를 임베드한다.', ['media', 'reference'], '# Diagram\n\n![[diagram.png]]\n');
    const head = await f.repo.change('wiki/engineering/diagram.md', content);
    f.runAgent.mockImplementationOnce(async (options) => {
      await writeJournal(options);
      await options.tools.find(tool => tool.name === 'write_file')!.run({
        path: 'assets/other/diagram.png', content: 'other image bytes',
      });
      return { text: 'Added another diagram asset.', toolCalls: 2 };
    });

    const run = await f.dreaming.runOnce();

    expect(run).toMatchObject({ status: 'failed', mergeSha: null, error: 'Dreaming introduced broken links: diagram.png' });
    expect(await f.repo.headSha()).toBe(head);
    expect(await f.repo.readFile('assets/other/diagram.png')).toBeNull();
    expect(await f.repo.readFile('wiki/engineering/diagram.md')).toBe(content);
  });

  it.each([null, ' \n\t'])('rejects a missing or empty journal before changing main (%j)', async (content) => {
    const f = await fixture();
    const messageId = f.addMessage();
    const head = await f.repo.headSha();
    f.runAgent.mockImplementationOnce(async (options) => {
      const tool = options.tools.find((candidate) => candidate.name === 'write_file')!;
      await tool.run({
        path: 'wiki/engineering/partial.md',
        content: wikiNote('note', '완료되지 않은 작업 내용을 담는다.', ['knowledge'], '# Unfinished work\n'),
      });
      if (content !== null) await writeJournal(options, content);
      return { text: 'No valid journal.', toolCalls: 1 };
    });
    const run = await f.dreaming.runOnce();
    expect(run).toMatchObject({ status: 'failed', mergeSha: null, pushed: true });
    expect(await f.repo.headSha()).toBe(head);
    expect(await f.repo.readFile('wiki/engineering/partial.md')).toBeNull();
    expect(f.learnedAt(messageId)).toBeNull();
    expect(f.indexer.syncToHead).not.toHaveBeenCalled();
    expect(f.repo.pushCount).toBe(1);
  });
});

describe('DreamingService shutdown', () => {
  it('waits for an in-flight run to finish indexing, learning, backup, and recording', async () => {
    const f = await fixture();
    const messageId = f.addMessage();
    const entered = deferred();
    const release = deferred();
    f.indexer.syncToHead.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { indexedSha: await f.repo.headSha(), changedFiles: 1 };
    });
    f.dreaming.start();
    const pending = f.dreaming.runOnce();
    await entered.promise;
    let closed = false;
    const closing = f.app.close().then(() => { closed = true; });
    try {
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(f.learnedAt(messageId)).toBeNull();
    } finally {
      release.resolve();
    }
    await closing;
    const run = await pending;
    expect(run.status).toBe('succeeded');
    expect(f.learnedAt(messageId)).toEqual(expect.any(String));
    expect(await f.repo.git(['rev-parse', 'main'], f.repo.origin)).toBe(run.mergeSha);
    expect(f.db.prepare('SELECT status, finished_at FROM dream_runs WHERE id = ?').get(toStorageId(run.id)))
      .toEqual({ status: 'succeeded', finished_at: run.finishedAt });
  });
});

describe('registerDreamCommands', () => {
  it.each(['succeeded', 'failed'] as const)('prints the %s run from a real Nest context and sets failure exit status', async (status) => {
    const f = await fixture();
    const messageId = f.addMessage();
    if (status === 'failed') f.runAgent.mockRejectedValueOnce(new Error('CLI Dony unavailable'));
    const printed = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const program = new Command();
      registerDreamCommands(program, async () => f.app);
      await program.parseAsync(['dream', 'run'], { from: 'user' });
      const output = JSON.parse(printed.mock.calls[0][0] as string) as { id: string; status: string; pushed: boolean; error: string | null };
      expect(output).toMatchObject({
        status, pushed: true, error: status === 'failed' ? 'CLI Dony unavailable' : null,
      });
      expect(process.exitCode).toBe(status === 'failed' ? 1 : undefined);
      expect(f.db.prepare('SELECT status FROM dream_runs WHERE id = ?').get(toStorageId(output.id))).toEqual({ status });
      expect(f.learnedAt(messageId)).toEqual(status === 'failed' ? null : expect.any(String));
    } finally {
      process.exitCode = previousExitCode;
      printed.mockRestore();
    }
  });
});
