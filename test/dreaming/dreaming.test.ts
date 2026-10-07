import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../../src/config.js';
import type { AppContext } from '../../src/context.js';
import { Dreaming } from '../../src/dreaming/index.js';
import type { CommitInfo, FileChange, Worktree } from '../../src/knowledge/repo.js';
import type { AgentTool, RunAgentOptions } from '../../src/luna/index.js';
import type { SearchHit } from '../../src/rag/index.js';

const execute = promisify(execFile);
const resources: Array<{ root: string; db: Database.Database }> = [];
const journalContent = '# Daily journal\n\nKnowledge reviewed and learned.\n';
const userContent = 'The deployment process requires a review before release.';
const similarContent = '# Release process\n\nA reviewer approves each release.\n';
const similarHit: SearchHit = {
  path: 'wiki/release.md', title: 'Release process', heading: '',
  snippet: 'A reviewer approves each release.', score: 0.9, kind: 'wiki', related: [],
};
type Author = { name: string; email: string };
type MessageInput = { id: string; conversation_id: string; content: string; created_at: string };
type DreamInput = {
  date: string; fromSha: string; toSha: string; commits: CommitInfo[];
  changedNotes: Array<{ change: FileChange; content: string | null; similarNotes: Array<SearchHit & { content: string | null }> }>;
  userMessages: MessageInput[];
};

// This fixture implements the git boundary directly: it never imports KnowledgeRepo.
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
    await mkdir(join(this.path, 'wiki'));
    await writeFile(join(this.path, 'wiki/release.md'), similarContent);
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
      .filter((path) => path.endsWith('.md') && path.startsWith(prefix));
  }
  async diffNames(fromSha: string | null, toSha: string): Promise<FileChange[]> {
    const args = fromSha
      ? ['diff', '--name-status', '-M', fromSha, toSha]
      : ['diff-tree', '--root', '--no-commit-id', '-r', '--name-status', toSha];
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
    const [hash, parents, authorName, authorEmail, date, subject, body] =
      (await this.git(['show', '-s', '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%s%x00%b', sha])).split('\0');
    return { sha: hash, parents: parents ? parents.split(' ') : [], authorName, authorEmail, date, subject, body };
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
  async change(path = 'wiki/deployment.md', content = '# Deployment\n\nReleases require review.\n'): Promise<string> {
    await mkdir(dirname(join(this.path, path)), { recursive: true });
    await writeFile(join(this.path, path), content);
    await this.git(['add', '.']);
    await this.git(['commit', '-m', 'Add deployment knowledge']);
    return this.headSha();
  }
}

class TempWorktree {
  constructor(readonly repo: TempRepo, readonly path: string, readonly branch: string, readonly baseSha: string) {}
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
    return [...new Set(files.split('\n').filter((path) => path.endsWith('.md') && path.startsWith(prefix)))];
  }
  async commit(message: string, author: Author): Promise<string | null> {
    await this.repo.git(['add', '-A'], this.path);
    if (!(await this.repo.git(['diff', '--cached', '--name-only'], this.path))) return null;
    await this.repo.git(['commit', '--author', `${author.name} <${author.email}>`, '-m', message], this.path);
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
  db.exec(await readFile(new URL('../../src/db/migrations/005_dreaming.sql', import.meta.url), 'utf8'));
  db.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')), content TEXT NOT NULL,
    citations TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, learned_at TEXT
  )`);
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: root, GIT_BOT_NAME: 'Dream Bot', GIT_BOT_EMAIL: 'dream@example.test' });
  const repo = new TempRepo(root, config);
  await repo.init();
  const baseSha = await repo.headSha();
  const runAgent = vi.fn(async (options: RunAgentOptions) => {
    await writeJournal(options);
    return { text: 'Knowledge reviewed.', toolCalls: 1 };
  });
  const indexer = { syncToHead: vi.fn(async () => ({ indexedSha: await repo.headSha(), changedFiles: 1 })) };
  const search = { search: vi.fn(async () => [similarHit]) };
  const luna = {
    runAgent,
    baseInstructions: async () => 'Use verified facts.',
    worktreeTools: (worktree: Worktree, author: Author): AgentTool[] => [
      { name: 'write_file', description: 'Write a note', parameters: { type: 'object' },
        run: async ({ path, content }: { path: string; content: string }) => { await worktree.write(path, content); return 'written'; } },
      { name: 'commit', description: 'Commit notes', parameters: { type: 'object' },
        run: async ({ message }: { message: string }) => JSON.stringify({ sha: await worktree.commit(message, author) }) },
    ],
    resolveConflicts: vi.fn(async () => { throw new Error('Unexpected merge conflict'); }),
  };
  const ctx = { config, db, log: pino({ level: 'silent' }), repo, luna, indexer, search } as unknown as AppContext;
  const addMessage = (id: string, role: 'user' | 'assistant' = 'user', createdAt = '2020-01-01T00:00:00.000Z', learnedAt: string | null = null) => {
    db.prepare('INSERT INTO messages (id, conversation_id, role, content, created_at, learned_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, 'conversation-1', role, role === 'user' ? userContent : 'Assistant-only unsupported claim.', createdAt, learnedAt);
  };
  const learnedAt = (id: string): string | null => {
    const row = db.prepare('SELECT learned_at FROM messages WHERE id = ?').get(id);
    if (!row || typeof row !== 'object' || !('learned_at' in row)
      || (row.learned_at !== null && typeof row.learned_at !== 'string')) {
      throw new Error(`Invalid message row: ${id}`);
    }
    return row.learned_at;
  };
  const checkpoint = (sha: string) => db.prepare(`INSERT INTO dream_runs
    (id, started_at, finished_at, status, from_sha, to_sha, merge_sha, pushed)
    VALUES ('previous-success', '2020-01-01T00:00:00.000Z', '2020-01-01T00:01:00.000Z', 'succeeded', ?, ?, ?, 1)`)
    .run(baseSha, sha, sha);
  return { ctx, db, repo, baseSha, runAgent, indexer, search, addMessage, learnedAt, checkpoint };
}

afterEach(async () => {
  await Promise.all(resources.splice(0).map(async ({ root, db }) => {
    if (db.open) db.close();
    await rm(root, { recursive: true, force: true });
  }));
});

describe('Dreaming.runOnce', () => {
  it('reviews only post-baseline changes, merges a dated journal into main, and pushes the actual result', async () => {
    const f = await fixture();
    const toSha = await f.repo.change();
    const run = await new Dreaming(f.ctx).runOnce();
    const input = inputOf(f.runAgent.mock.calls[0][0]);
    const kstDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(run.startedAt));
    expect(run).toMatchObject({ status: 'succeeded', fromSha: f.baseSha, toSha, pushed: true, error: null });
    expect(run.finishedAt).not.toBeNull();
    expect(input).toMatchObject({ date: kstDate, fromSha: f.baseSha, toSha });
    expect(input.commits.map((commit) => commit.sha)).toEqual([toSha]);
    expect(input.changedNotes).toEqual([{
      change: { status: 'A', path: 'wiki/deployment.md' },
      content: '# Deployment\n\nReleases require review.\n',
      similarNotes: [{ ...similarHit, content: similarContent }],
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

  it('keeps main untouched when Luna fails, but still pushes main', async () => {
    const f = await fixture();
    const head = await f.repo.change();
    f.addMessage('pending');
    f.runAgent.mockImplementationOnce(async (options) => {
      await writeJournal(options);
      throw new Error('Luna unavailable');
    });
    const run = await new Dreaming(f.ctx).runOnce();
    expect(run).toMatchObject({ status: 'failed', mergeSha: null, pushed: true });
    expect(run.error).toContain('Luna unavailable');
    expect(await f.repo.headSha()).toBe(head);
    expect(await f.repo.listFiles('journal/')).toEqual([]);
    expect(f.learnedAt('pending')).toBeNull();
    expect(f.indexer.syncToHead).not.toHaveBeenCalled();
    expect(f.repo.pushCount).toBe(1);
    expect(await f.repo.git(['rev-parse', 'main'], f.repo.origin)).toBe(head);
  });

  it('supplies only eligible user backlog and marks it learned after merge and indexing complete', async () => {
    const f = await fixture();
    f.addMessage('backlog');
    f.addMessage('assistant', 'assistant');
    f.addMessage('future', 'user', '2999-01-01T00:00:00.000Z');
    f.addMessage('already-learned', 'user', '2020-01-01T00:00:00.000Z', '2020-01-02T00:00:00.000Z');
    const entered = deferred();
    const release = deferred();
    f.indexer.syncToHead.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { indexedSha: await f.repo.headSha(), changedFiles: 1 };
    });
    const pending = new Dreaming(f.ctx).runOnce();
    await entered.promise;
    try {
      expect(await f.repo.listFiles('journal/')).toEqual([`journal/${inputOf(f.runAgent.mock.calls[0][0]).date}.md`]);
      expect(f.learnedAt('backlog')).toBeNull();
    } finally {
      release.resolve();
    }
    const run = await pending;
    expect(run.status).toBe('succeeded');
    const input = inputOf(f.runAgent.mock.calls[0][0]);
    expect(input.userMessages).toEqual([{ id: 'backlog', conversation_id: 'conversation-1', content: userContent, created_at: '2020-01-01T00:00:00.000Z' }]);
    expect(JSON.stringify(input)).not.toContain('Assistant-only unsupported claim.');
    expect(f.learnedAt('backlog')).toEqual(expect.any(String));
    expect(f.learnedAt('assistant')).toBeNull();
    expect(f.learnedAt('future')).toBeNull();
    expect(f.learnedAt('already-learned')).toBe('2020-01-02T00:00:00.000Z');
  });

  it('joins concurrent callers across Dreaming instances sharing one repo', async () => {
    const f = await fixture();
    f.addMessage('pending');
    const entered = deferred();
    const release = deferred();
    f.runAgent.mockImplementationOnce(async (options) => {
      entered.resolve();
      await release.promise;
      await writeJournal(options);
      return { text: 'Completed once.', toolCalls: 1 };
    });
    const first = new Dreaming(f.ctx).runOnce();
    await entered.promise;
    const second = new Dreaming(f.ctx).runOnce();
    release.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(a.id).toBe(b.id);
    expect(a.status).toBe('succeeded');
    expect(f.runAgent).toHaveBeenCalledTimes(1);
    expect(f.repo.worktreeCount).toBe(1);
    expect(await f.repo.listFiles('journal/')).toEqual([`journal/${inputOf(f.runAgent.mock.calls[0][0]).date}.md`]);
    expect(f.db.prepare('SELECT id FROM dream_runs').all()).toEqual([{ id: a.id }]);
    expect(f.repo.pushCount).toBe(1);
  });

  it('records a successful no-op and pushes without creating a worktree when checkpoint equals head', async () => {
    const f = await fixture();
    const head = await f.repo.headSha();
    f.checkpoint(head);
    const run = await new Dreaming(f.ctx).runOnce();
    expect(run).toMatchObject({ status: 'succeeded', fromSha: head, toSha: head, mergeSha: null, pushed: true, error: null });
    expect(await f.repo.headSha()).toBe(head);
    expect(f.runAgent).not.toHaveBeenCalled();
    expect(f.indexer.syncToHead).not.toHaveBeenCalled();
    expect(f.repo.worktreeCount).toBe(0);
    expect(f.repo.pushCount).toBe(1);
  });

  it('retries unlearned backlog after a failed attempt rather than advancing the checkpoint', async () => {
    const f = await fixture();
    const head = await f.repo.change();
    f.checkpoint(f.baseSha);
    f.addMessage('retry-me');
    f.runAgent.mockRejectedValueOnce(new Error('Temporary Luna failure'));
    const dreaming = new Dreaming(f.ctx);
    const failed = await dreaming.runOnce();
    expect(failed.status).toBe('failed');
    expect(f.learnedAt('retry-me')).toBeNull();
    const retried = await dreaming.runOnce();
    expect(retried).toMatchObject({ status: 'succeeded', fromSha: f.baseSha, toSha: head });
    for (const [options] of f.runAgent.mock.calls) {
      expect(inputOf(options).userMessages.map((message) => message.id)).toEqual(['retry-me']);
    }
    expect(f.learnedAt('retry-me')).toEqual(expect.any(String));
    expect(f.repo.pushCount).toBe(2);
  });

  it('does not learn messages if indexing fails after their journal reaches main', async () => {
    const f = await fixture();
    f.addMessage('pending-index');
    f.indexer.syncToHead.mockRejectedValueOnce(new Error('Index unavailable'));
    const run = await new Dreaming(f.ctx).runOnce();
    expect(run.status).toBe('failed');
    expect(run.error).toContain('Index unavailable');
    expect(await f.repo.readFile(`journal/${inputOf(f.runAgent.mock.calls[0][0]).date}.md`)).toBe(journalContent);
    expect(f.learnedAt('pending-index')).toBeNull();
    expect(f.repo.pushCount).toBe(1);
  });

  it('leaves merged messages learned even if the backup push fails', async () => {
    const f = await fixture();
    f.addMessage('merged-before-push');
    f.repo.pushError = new Error('Backup unavailable');
    const run = await new Dreaming(f.ctx).runOnce();
    expect(run).toMatchObject({ status: 'failed', pushed: false });
    expect(run.error).toContain('Backup unavailable');
    expect(await f.repo.readFile(`journal/${inputOf(f.runAgent.mock.calls[0][0]).date}.md`)).toBe(journalContent);
    expect(f.learnedAt('merged-before-push')).toEqual(expect.any(String));
    expect(f.repo.pushCount).toBe(1);
  });

  it('pins the input snapshot and reviews concurrently added main commits on the next run', async () => {
    const f = await fixture();
    const sampledSha = await f.repo.change();
    const originalLog = f.repo.log.bind(f.repo);
    let concurrentSha: string | undefined;
    const concurrentContent = '# Later knowledge\n\nThis arrived after the dream started.\n';
    f.repo.log = async (options) => {
      if (!concurrentSha) concurrentSha = await f.repo.change('wiki/later.md', concurrentContent);
      return originalLog(options);
    };
    const dreaming = new Dreaming(f.ctx);
    const first = await dreaming.runOnce();
    expect(first).toMatchObject({ status: 'succeeded', toSha: sampledSha });
    const firstInput = inputOf(f.runAgent.mock.calls[0][0]);
    expect(firstInput.commits.map((commit) => commit.sha)).toEqual([sampledSha]);
    expect(firstInput.changedNotes.map((note) => note.change.path)).toEqual(['wiki/deployment.md']);
    expect(await f.repo.readFile('wiki/later.md')).toBe(concurrentContent);
    expect(first.mergeSha).not.toBe(sampledSha);

    const second = await dreaming.runOnce();
    expect(second).toMatchObject({ status: 'succeeded', fromSha: sampledSha, toSha: first.mergeSha });
    const secondInput = inputOf(f.runAgent.mock.calls[1][0]);
    expect(secondInput.commits.map((commit) => commit.sha)).toContain(concurrentSha);
    expect(secondInput.changedNotes).toContainEqual(expect.objectContaining({
      change: { status: 'A', path: 'wiki/later.md' }, content: concurrentContent,
    }));
  });

  it.each([null, ' \n\t'])('rejects a missing or empty journal before changing main (%j)', async (content) => {
    const f = await fixture();
    f.addMessage('no-journal');
    const head = await f.repo.headSha();
    f.runAgent.mockImplementationOnce(async (options) => {
      const tool = options.tools.find((candidate) => candidate.name === 'write_file')!;
      await tool.run({ path: 'wiki/partial.md', content: '# Unfinished work\n' });
      if (content !== null) await writeJournal(options, content);
      return { text: 'No valid journal.', toolCalls: 1 };
    });
    const run = await new Dreaming(f.ctx).runOnce();
    expect(run).toMatchObject({ status: 'failed', mergeSha: null, pushed: true });
    expect(await f.repo.headSha()).toBe(head);
    expect(await f.repo.readFile('wiki/partial.md')).toBeNull();
    expect(f.learnedAt('no-journal')).toBeNull();
    expect(f.indexer.syncToHead).not.toHaveBeenCalled();
    expect(f.repo.pushCount).toBe(1);
  });
});
