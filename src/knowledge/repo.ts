import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Config } from '../config.js';
import type { Logger } from 'pino';

export interface CommitInfo { sha: string; parents: string[]; authorName: string; authorEmail: string; date: string; subject: string; body: string }
export interface FileChange { status: 'A'|'M'|'D'|'R'; path: string; oldPath?: string }
type Author = { name: string; email: string };
const exec = promisify(execFile);
const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const commitFormat = '%H%x00%P%x00%an%x00%ae%x00%aI%x00%s%x00%b%x00';
let mergeTail: Promise<void> = Promise.resolve();

function missing(error: unknown): boolean { return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }
function repoPath(path: string, allowEmpty = false): string {
  if ((path === '' && !allowEmpty) || isAbsolute(path) || win32.isAbsolute(path) || path.includes('\\') || path.includes('\0')) throw new Error(`Invalid repository path: ${path}`);
  const segments = path.split('/');
  if (segments.some((part) => part === '..' || part.toLowerCase() === '.git')) throw new Error(`Invalid repository path: ${path}`);
  const normalized = segments.filter((part) => part !== '' && part !== '.').join('/');
  return allowEmpty && normalized && path.endsWith('/') ? `${normalized}/` : normalized;
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}
async function confined(root: string, input: string): Promise<string> {
  const path = repoPath(input);
  if (!path) throw new Error('A file path is required');
  const rootReal = await realpath(root);
  let current = root;
  for (const segment of path.split('/')) {
    current = join(current, segment);
    try {
      const physical = await realpath(current);
      if (!inside(rootReal, physical)) throw new Error(`Path escapes the repository: ${input}`);
      // Git metadata must remain inaccessible even through an internal symlink.
      const physicalRelative = relative(rootReal, physical);
      repoPath(physicalRelative, true);
    } catch (error) {
      if (!missing(error)) throw error;
      // A dangling symlink is not a safe location to create a new file.
      try { if ((await lstat(current)).isSymbolicLink()) throw new Error(`Dangling symlink: ${input}`); }
      catch (statError) { if (!missing(statError)) throw statError; }
    }
  }
  return join(root, path);
}
class Git {
  readonly env: NodeJS.ProcessEnv;
  constructor(readonly cfg: Config) {
    this.env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' };
    if (cfg.gitSshKeyPath) {
      const key = cfg.gitSshKeyPath.replaceAll("'", "'\\''");
      this.env.GIT_SSH_COMMAND = `ssh -i '${key}' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
    }
  }
  identity(author: Author = { name: this.cfg.gitBotName, email: this.cfg.gitBotEmail }): Record<string, string> {
    return { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: this.cfg.gitBotName, GIT_COMMITTER_EMAIL: this.cfg.gitBotEmail };
  }
  async run(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
    const result = await exec('git', args, { cwd, env: { ...this.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return result.stdout;
  }
  async hasRef(cwd: string, ref: string): Promise<boolean> {
    try { await this.run(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', ref]); return true; }
    catch (error) { if (error !== null && typeof error === 'object' && 'code' in error && error.code === 1) return false; throw error; }
  }
  async sha(cwd: string, ref: string): Promise<string> {
    try { return (await this.run(cwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim(); }
    catch (error) {
      if (error !== null && typeof error === 'object' && 'code' in error && error.code === 128) {
        throw Object.assign(new Error(`Unknown commit or ref: ${ref}`, { cause: error }), { code: 'NOT_FOUND', status: 404 });
      }
      throw error;
    }
  }
}
function changes(output: string): FileChange[] {
  const tokens = output.split('\0');
  const files: FileChange[] = [];
  for (let i = 0; i < tokens.length && tokens[i];) {
    const status = tokens[i++]!;
    const path = tokens[i++]!;
    if (status.startsWith('R')) files.push({ status: 'R', oldPath: path, path: tokens[i++]! });
    else if (status.startsWith('C')) files.push({ status: 'A', path: tokens[i++]! });
    else files.push({ status: status === 'T' ? 'M' : status as FileChange['status'], path });
  }
  return files;
}
function commits(output: string): CommitInfo[] {
  const fields = output.split('\0');
  const result: CommitInfo[] = [];
  for (let i = 0; i + 6 < fields.length; i += 7) {
    const sha = fields[i]!.trim();
    if (!sha) break;
    result.push({ sha, parents: fields[i + 1]!.split(' ').filter(Boolean), authorName: fields[i + 2]!, authorEmail: fields[i + 3]!, date: fields[i + 4]!, subject: fields[i + 5]!, body: fields[i + 6]!.trimEnd() });
  }
  return result;
}
function treeEntries(output: string): Array<{ mode: string; path: string }> {
  return output.split('\0').filter(Boolean).map((entry) => {
    const tab = entry.indexOf('\t');
    return { mode: entry.slice(0, entry.indexOf(' ')), path: entry.slice(tab + 1) };
  });
}

export class KnowledgeRepo {
  private constructor(private readonly logger: Logger, private readonly git: Git, private readonly path: string, private readonly worktrees: string) {}
  static async open(cfg: Config, log: Logger): Promise<KnowledgeRepo> {
    const path = resolve(cfg.dataDir, 'knowledge');
    const worktrees = resolve(cfg.dataDir, 'worktrees');
    const git = new Git(cfg);
    await mkdir(cfg.dataDir, { recursive: true });
    let exists = true;
    try { await lstat(join(path, '.git')); } catch (error) { if (!missing(error)) throw error; exists = false; }
    if (!exists) {
      if (cfg.knowledgeRepoUrl) await git.run(cfg.dataDir, ['clone', '--', cfg.knowledgeRepoUrl, path]);
      else { await mkdir(path, { recursive: true }); await git.run(path, ['init', '-b', 'main']); }
    }
    await git.run(path, ['config', 'user.name', cfg.gitBotName]);
    await git.run(path, ['config', 'user.email', cfg.gitBotEmail]);
    if (await git.hasRef(path, 'refs/heads/main')) await git.run(path, ['checkout', 'main']);
    else if (await git.hasRef(path, 'refs/remotes/origin/main')) await git.run(path, ['checkout', '-b', 'main', 'origin/main']);
    else if (await git.hasRef(path, 'HEAD')) await git.run(path, ['checkout', '-b', 'main']);
    else {
      await git.run(path, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
      const seeds = [fileURLToPath(new URL('./seed/', import.meta.url)), fileURLToPath(new URL('../../src/knowledge/seed/', import.meta.url))];
      for (const seed of seeds) {
        try { if ((await readdir(seed)).length) { await cp(seed, path, { recursive: true }); break; } }
        catch (error) { if (!missing(error)) throw error; }
      }
      for (const dir of ['raw', 'wiki', 'journal']) await mkdir(join(path, dir), { recursive: true });
      await git.run(path, ['add', '--all']);
      await git.run(path, ['commit', '--allow-empty', '-m', 'Initialize knowledge repository'], git.identity());
    }
    await mkdir(worktrees, { recursive: true });
    const repo = new KnowledgeRepo(log, git, path, worktrees);
    await repo.recoverWorktrees();
    return repo;
  }
  private async recoverWorktrees(): Promise<void> {
    const records = (await this.git.run(this.path, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0');
    for (const record of records) {
      const lines = record.split('\0');
      const location = lines.find((line) => line.startsWith('worktree '))?.slice(9);
      const branch = lines.find((line) => line.startsWith('branch '))?.slice(7);
      if (location && branch?.startsWith('refs/heads/work/') && inside(this.worktrees, resolve(location)) && resolve(location) !== this.worktrees) {
        try { await this.git.run(this.path, ['worktree', 'remove', '--force', '--force', location]); }
        catch (error) { if (await this.git.hasRef(this.path, branch)) { await rm(location, { recursive: true, force: true }); await this.git.run(this.path, ['worktree', 'prune', '--expire', 'now']); } else throw error; }
      }
    }
    await this.git.run(this.path, ['worktree', 'prune', '--expire', 'now']);
    for (const entry of await readdir(this.worktrees)) await rm(join(this.worktrees, entry), { recursive: true, force: true });
    const branches = (await this.git.run(this.path, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/work/'])).trim().split('\n').filter(Boolean);
    for (const branch of branches) await this.git.run(this.path, ['branch', '-D', '--', branch]);
    if (branches.length) this.logger.info({ count: branches.length }, 'Removed abandoned knowledge work branches');
  }
  async headSha(): Promise<string> { return this.git.sha(this.path, 'refs/heads/main'); }
  async readFile(path: string, ref = 'main'): Promise<string | null> {
    const safe = repoPath(path);
    if (!safe) throw new Error('A file path is required');
    const sha = await this.git.sha(this.path, ref);
    const entry = treeEntries(await this.git.run(this.path, ['ls-tree', '-r', '-z', sha, '--', safe])).find((item) => item.path === safe);
    if (!entry) return null;
    if (entry.mode === '120000') throw new Error(`Symlinks are not readable notes: ${path}`);
    if (entry.mode === '160000') return null;
    return this.git.run(this.path, ['show', `${sha}:${safe}`]);
  }
  async listFiles(prefix = '', ref = 'main'): Promise<string[]> {
    const safe = repoPath(prefix, true);
    const sha = await this.git.sha(this.path, ref);
    return treeEntries(await this.git.run(this.path, ['ls-tree', '-r', '-z', sha])).filter((entry) => entry.mode !== '120000' && entry.mode !== '160000' && entry.path.endsWith('.md') && entry.path.startsWith(safe)).map((entry) => repoPath(entry.path)).sort();
  }
  async diffNames(fromSha: string | null, toSha: string): Promise<FileChange[]> {
    const from = fromSha === null ? emptyTree : await this.git.sha(this.path, fromSha);
    const to = await this.git.sha(this.path, toSha);
    return changes(await this.git.run(this.path, ['diff', '--name-status', '-z', '--find-renames', from, to, '--']));
  }
  async log(opts: { path?: string; limit?: number; sinceSha?: string; beforeSha?: string } = {}): Promise<CommitInfo[]> {
    const path = opts.path === undefined ? undefined : repoPath(opts.path);
    const args = ['log', `--format=${commitFormat}`];
    if (opts.limit !== undefined) {
      if (!Number.isSafeInteger(opts.limit) || opts.limit < 0) throw new Error('History limit must be a nonnegative safe integer');
      if (opts.limit === 0) return [];
      args.push(`--max-count=${opts.limit}`);
    } else args.push('--max-count=50');
    if (opts.beforeSha) {
      const cursor = await this.git.sha(this.path, opts.beforeSha);
      const parents = (await this.git.run(this.path, ['show', '-s', '--format=%P', cursor])).trim().split(' ').filter(Boolean);
      if (!parents.length) return [];
      args.push(...parents);
    } else args.push(await this.headSha());
    if (opts.sinceSha) args.push(`^${await this.git.sha(this.path, opts.sinceSha)}`);
    args.push('--');
    if (path !== undefined) args.push(path);
    return commits(await this.git.run(this.path, args));
  }
  async show(sha: string): Promise<{ commit: CommitInfo; files: FileChange[]; patch: string }> {
    const resolved = await this.git.sha(this.path, sha);
    const commit = commits(await this.git.run(this.path, ['show', '-s', `--format=${commitFormat}`, resolved]))[0]!;
    const from = commit.parents[0] ?? emptyTree;
    return { commit, files: await this.diffNames(commit.parents[0] ?? null, resolved), patch: await this.git.run(this.path, ['diff', '--find-renames', from, resolved, '--']) };
  }
  async createWorktree(name: string): Promise<Worktree> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) throw new Error('Worktree name must be a safe identifier');
    const path = join(this.worktrees, name);
    const branch = `work/${name}`;
    const baseSha = await this.headSha();
    await this.git.run(this.path, ['worktree', 'add', '-b', branch, '--', path, baseSha]);
    return new Worktree(path, branch, baseSha, this.path, this.git);
  }
  async withMergeLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = mergeTail;
    let release!: () => void;
    mergeTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  }
  async pushMain(): Promise<{ pushed: boolean; reason?: string }> {
    const remotes = (await this.git.run(this.path, ['remote'])).trim().split('\n').filter(Boolean);
    if (!remotes.length) return { pushed: false, reason: 'No git remote configured; knowledge repository is local-only' };
    await this.git.run(this.path, ['push', remotes.includes('origin') ? 'origin' : remotes[0]!, 'main']);
    return { pushed: true };
  }
}

export class Worktree {
  private author: Author | undefined;
  private disposed = false;
  constructor(readonly path: string, readonly branch: string, readonly baseSha: string, private readonly primary: string, private readonly git: Git) {}
  async read(path: string): Promise<string | null> {
    const file = await confined(this.path, path);
    try { return await readFile(file, 'utf8'); } catch (error) { if (missing(error)) return null; throw error; }
  }
  async write(path: string, content: string): Promise<void> {
    const file = await confined(this.path, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
  }
  async remove(path: string): Promise<void> { await rm(await confined(this.path, path), { force: true }); }
  async move(from: string, to: string): Promise<void> {
    const source = await confined(this.path, from);
    const target = await confined(this.path, to);
    await mkdir(dirname(target), { recursive: true });
    await rename(source, target);
  }
  async list(prefix = ''): Promise<string[]> {
    const safe = repoPath(prefix, true);
    const files: string[] = [];
    const ancestors = new Set<string>();
    const walk = async (directory: string): Promise<void> => {
      const physical = await realpath(directory);
      if (ancestors.has(physical)) throw new Error('Symlink directory cycle in worktree');
      ancestors.add(physical);
      try {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (entry.name.toLowerCase() === '.git') continue;
          const path = relative(this.path, join(directory, entry.name));
          const file = await confined(this.path, path);
          const stat = await lstat(file);
          if (stat.isDirectory()) await walk(file);
          else if (stat.isSymbolicLink()) {
            const target = await realpath(file);
            const targetStat = await lstat(target);
            if (targetStat.isDirectory()) await walk(file);
            else if (targetStat.isFile() && path.startsWith(safe)) files.push(path);
          } else if (stat.isFile() && path.startsWith(safe)) files.push(path);
        }
      } finally { ancestors.delete(physical); }
    };
    await walk(this.path);
    return files.sort();
  }
  async commit(message: string, author: Author): Promise<string | null> {
    this.author = author;
    await this.git.run(this.path, ['add', '--all']);
    const staged = await this.git.run(this.path, ['diff', '--cached', '--name-only', '-z']);
    if (!staged) return null;
    await this.git.run(this.path, ['commit', '-m', message], this.git.identity(author));
    return this.git.sha(this.path, 'HEAD');
  }
  async mergeMain(): Promise<{ ok: true } | { ok: false; conflicts: string[] }> {
    try {
      await this.git.run(this.path, ['merge', '--no-edit', 'refs/heads/main'], this.git.identity(this.author));
      return { ok: true };
    } catch (error) {
      const conflicts = await this.conflictedFiles();
      if (conflicts.length) return { ok: false, conflicts };
      throw error;
    }
  }
  async conflictedFiles(): Promise<string[]> {
    return (await this.git.run(this.path, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean);
  }
  async finishMerge(author: Author): Promise<string> {
    if (!await this.git.hasRef(this.path, 'MERGE_HEAD')) throw new Error('No merge is in progress');
    this.author = author;
    await this.git.run(this.path, ['add', '--all']);
    await this.git.run(this.path, ['commit', '--no-edit'], this.git.identity(author));
    return this.git.sha(this.path, 'HEAD');
  }
  async fastForwardMain(): Promise<string> {
    await this.git.run(this.primary, ['merge', '--ff-only', this.branch], this.git.identity(this.author));
    return this.git.sha(this.primary, 'refs/heads/main');
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.git.run(this.primary, ['worktree', 'remove', '--force', '--force', this.path]);
    await this.git.run(this.primary, ['branch', '-D', '--', this.branch]);
    this.disposed = true;
  }
}
