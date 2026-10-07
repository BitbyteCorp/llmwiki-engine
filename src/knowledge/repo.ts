import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitTrailers, type CommitMetadata } from './commit-trailers.js';
import type { Config } from '../config.js';
import type { Logger } from 'pino';

export interface CommitInfo {
  sha: string; parents: string[]; authorName: string; authorEmail: string; date: string;
  committerName: string; committerEmail: string; committedAt: string;
  subject: string; body: string; trailers: Record<string, string>; path?: string; oldPath?: string;
}
export interface LogOptions { path?: string; ref?: string; limit?: number | null; sinceSha?: string; beforeSha?: string; before?: string; follow?: boolean }
export interface BlameRange { start: number; end: number; sha: string; authorName: string; date: string; summary: string; jobId?: string; source?: string }
export interface FileChange { status: 'A'|'M'|'D'|'R'; path: string; oldPath?: string }
type Author = { name: string; email: string };
const metadataFormat = '%(trailers:only,unfold)';
const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const commitFormat = `%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%s%x00%b%x00${metadataFormat}%x00`;
let mergeTail: Promise<void> = Promise.resolve();

function missing(error: unknown): boolean { return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'; }
export function repoPath(path: string, allowEmpty = false): string {
  if ((path === '' && !allowEmpty) || isAbsolute(path) || win32.isAbsolute(path) || path.includes('\\') || path.includes('\0')) throw new Error(`Invalid repository path: ${path}`);
  const segments = path.split('/');
  if (segments.some((part) => part === '..' || part.toLowerCase() === '.git')) throw new Error(`Invalid repository path: ${path}`);
  const normalized = segments.filter((part) => part !== '' && part !== '.').join('/');
  if (!normalized && !allowEmpty) throw new Error('A file path is required');
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
  async run(cwd: string, args: string[], env: Record<string, string> = {}, input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile('git', ['-c', 'core.quotePath=false', ...args], { cwd, env: { ...this.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stderr }));
        else resolve(stdout);
      });
      if (input !== undefined) {
        child.stdin!.on('error', () => { /* Git's exit status supplies the useful failure. */ });
        child.stdin!.end(input);
      }
    });
  }
  async runBuffer(cwd: string, args: string[]): Promise<Buffer> {
    const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
    execFile('git', ['-c', 'core.quotePath=false', ...args], { cwd, env: this.env, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr: stderr.toString('utf8') }));
      else resolve(stdout);
    });
    return promise;
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
  for (let i = 0; i + 10 < fields.length; i += 11) {
    const sha = fields[i]!.trim();
    if (!sha) break;
    const trailers: Record<string, string> = {};
    for (const line of fields[i + 10]!.split('\n')) {
      const separator = line.indexOf(':');
      if (separator > 0) trailers[line.slice(0, separator)] = line.slice(separator + 1).trim();
    }
    result.push({ sha, parents: fields[i + 1]!.split(' ').filter(Boolean), authorName: fields[i + 2]!, authorEmail: fields[i + 3]!, date: fields[i + 4]!, committerName: fields[i + 5]!, committerEmail: fields[i + 6]!, committedAt: fields[i + 7]!, subject: fields[i + 8]!, body: fields[i + 9]!.trimEnd(), trailers });
  }
  return result;
}
function treeEntries(output: string): Array<{ mode: string; oid: string; path: string }> {
  return output.split('\0').filter(Boolean).map((entry) => {
    const tab = entry.indexOf('\t');
    return { mode: entry.slice(0, entry.indexOf(' ')), oid: entry.slice(entry.lastIndexOf(' ', tab) + 1, tab), path: entry.slice(tab + 1) };
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
      await git.run(path, ['commit', '--allow-empty', '-m', `Initialize knowledge repository\n\n${commitTrailers({ jobId: 'initialize', source: 'dreaming', requester: cfg.gitBotEmail })}`], git.identity());
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
    const branches = (await this.git.run(this.path, ['for-each-ref', '--format=%(refname)', 'refs/heads/work/'])).trim().split('\n').filter(Boolean);
    for (const branch of branches) {
      const sha = await this.git.sha(this.path, branch);
      await this.git.run(this.path, ['update-ref', `refs/wiki/failed/${branch.slice('refs/heads/work/'.length)}`, sha]);
      await this.git.run(this.path, ['branch', '-D', '--', branch.slice('refs/heads/'.length)]);
    }
    if (branches.length) this.logger.info({ count: branches.length }, 'Removed abandoned knowledge work branches');
  }
  async headSha(): Promise<string> { return this.git.sha(this.path, 'refs/heads/main'); }
  async resolveRef(ref: string): Promise<string> { return this.git.sha(this.path, ref); }
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
  async readFileBytes(path: string, ref = 'main'): Promise<Buffer | null> {
    const safe = repoPath(path);
    const sha = await this.resolveRef(ref);
    const entry = treeEntries(await this.git.run(this.path, ['ls-tree', '-r', '-z', sha, '--', safe])).find((item) => item.path === safe);
    if (entry?.mode === '120000') throw Object.assign(new Error(`Symlinks are not readable assets: ${path}`), { status: 403, code: 'forbidden' });
    if (entry?.mode !== '100644' && entry?.mode !== '100755') return null;
    return this.git.runBuffer(this.path, ['cat-file', 'blob', entry.oid]);
  }
  async fileObjectId(path: string, ref = 'main'): Promise<string | null> {
    const safe = repoPath(path);
    const sha = await this.resolveRef(ref);
    const entry = treeEntries(await this.git.run(this.path, ['ls-tree', '-r', '-z', sha, '--', safe])).find((item) => item.path === safe);
    if (entry?.mode === '120000') throw new Error(`Symlinks are not readable notes: ${path}`);
    return entry?.mode === '100644' || entry?.mode === '100755' ? entry.oid : null;
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
  /** Regenerate a diff from an explicit, already-authorized set of paths. */
  async diffPatch(base: string | null, head: string, paths: string[]): Promise<string> {
    if (!paths.length) return '';
    const from = base === null ? emptyTree : await this.resolveRef(base);
    const to = await this.resolveRef(head);
    const selected = new Set(paths.map((path) => repoPath(path)));
    const temporary = await mkdtemp(join(this.worktrees, 'acl-diff-'));
    const env = { GIT_INDEX_FILE: join(temporary, 'index') };
    try {
      const trees: string[] = [];
      for (const ref of [from, to]) {
        // A filename pathspec also selects descendants when a file becomes a
        // directory. Membership must therefore be exact after tree discovery.
        const entries = treeEntries(await this.git.run(this.path, ['ls-tree', '-r', '-z', ref, '--', ...selected]));
        await this.git.run(this.path, ['read-tree', '--empty'], env);
        const index = entries.filter((entry) => selected.has(entry.path))
          .map((entry) => `${entry.mode} ${entry.oid}\t${entry.path}\0`).join('');
        if (index) await this.git.run(this.path, ['update-index', '-z', '--index-info'], env, index);
        trees.push((await this.git.run(this.path, ['write-tree'], env)).trim());
      }
      return await this.git.run(this.path, ['diff', '--binary', '--find-renames', trees[0]!, trees[1]!, '--']);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  async log(opts?: LogOptions): Promise<CommitInfo[]>;
  async log(path?: string, opts?: Omit<LogOptions, 'path'>): Promise<CommitInfo[]>;
  async log(pathOrOpts: string | LogOptions = {}, options: Omit<LogOptions, 'path'> = {}): Promise<CommitInfo[]> {
    const opts = typeof pathOrOpts === 'string' ? { ...options, path: pathOrOpts } : { ...options, ...pathOrOpts };
    const path = opts.path === undefined ? undefined : repoPath(opts.path);
    const limit = opts.limit === null ? null : opts.limit ?? 50;
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 0)) throw new Error('History limit must be a nonnegative safe integer');
    if (limit === 0) return [];
    const root = opts.ref === undefined ? await this.headSha() : await this.resolveRef(opts.ref);
    const follow = opts.follow === true && path !== undefined;
    const args = ['log', `--format=${commitFormat}`];
    if (follow) args.push('--follow');
    else if (limit !== null) args.push(`--max-count=${limit}`);
    let ancestors: Set<string> | undefined;
    const before = opts.before ?? opts.beforeSha;
    if (before) {
      const cursor = await this.resolveRef(before);
      const parents = (await this.git.run(this.path, ['show', '-s', '--format=%P', cursor])).trim().split(' ').filter(Boolean);
      if (!parents.length) return [];
      if (follow) {
        ancestors = new Set((await this.git.run(this.path, ['rev-list', ...parents, '--'])).trim().split('\n'));
        args.push(root);
      } else args.push(...parents);
    } else args.push(root);
    if (opts.sinceSha) args.push(`^${await this.resolveRef(opts.sinceSha)}`);
    args.push('--');
    if (path !== undefined) args.push(path);
    const history = commits(await this.git.run(this.path, args));
    if (!follow) return history;
    const result: CommitInfo[] = [];
    let currentPath = path!;
    for (const commit of history) {
      commit.path = currentPath;
      const renamed = (await this.diffNames(commit.parents[0] ?? null, commit.sha)).find((file) => file.status === 'R' && file.path === currentPath);
      if (renamed) { commit.oldPath = renamed.oldPath; currentPath = renamed.oldPath!; }
      if (!ancestors || ancestors.has(commit.sha)) result.push(commit);
      if (result.length === limit) break;
    }
    return result;
  }
  async compare(base: string, head: string, path?: string): Promise<{ base: string; head: string; files: FileChange[]; patch: string }> {
    const from = await this.resolveRef(base);
    const to = await this.resolveRef(head);
    const paths = path === undefined ? [] : [repoPath(path)];
    return {
      base: from, head: to,
      files: changes(await this.git.run(this.path, ['diff', '--name-status', '-z', '--find-renames', from, to, '--', ...paths])),
      patch: await this.git.run(this.path, ['diff', '--binary', '--find-renames', from, to, '--', ...paths]),
    };
  }
  async show(sha: string, parent = 1): Promise<{ commit: CommitInfo; files: FileChange[]; patch: string }> {
    const resolved = await this.resolveRef(sha);
    const commit = commits(await this.git.run(this.path, ['show', '-s', `--format=${commitFormat}`, resolved]))[0]!;
    if (!Number.isSafeInteger(parent) || parent < 1 || parent > Math.max(1, commit.parents.length)) throw Object.assign(new Error(`Commit has no parent ${parent}`), { status: 400, code: 'invalid_parent' });
    const from = commit.parents[parent - 1] ?? emptyTree;
    return {
      commit,
      files: changes(await this.git.run(this.path, ['diff', '--name-status', '-z', '--find-renames', from, resolved, '--'])),
      patch: await this.git.run(this.path, ['diff', '--binary', '--find-renames', from, resolved, '--']),
    };
  }
  async blame(path: string, ref = 'main'): Promise<{ ref: string; ranges: BlameRange[] }> {
    const safe = repoPath(path);
    const resolved = await this.resolveRef(ref);
    const entryAtRef = treeEntries(await this.git.run(this.path, ['ls-tree', '-r', '-z', resolved, '--', safe])).find((entry) => entry.path === safe);
    if (!entryAtRef || entryAtRef.mode === '160000') throw Object.assign(new Error(`Note not found: ${safe}`), { status: 404, code: 'NOT_FOUND' });
    if (entryAtRef.mode === '120000') throw new Error(`Symlinks are not readable notes: ${safe}`);
    const output = await this.git.run(this.path, ['blame', '--line-porcelain', resolved, '--', safe]);
    const lines: Array<{ sha: string; line: number }> = [];
    let entry: { sha: string; line: number } | undefined;
    for (const line of output.split('\n')) {
      const header = /^([a-f0-9]{40,64}) \d+ (\d+)(?: \d+)?$/.exec(line);
      if (header) entry = { sha: header[1]!, line: Number(header[2]) };
      else if (line.startsWith('\t') && entry) { lines.push(entry); entry = undefined; }
    }
    const shas = [...new Set(lines.map((line) => line.sha))];
    const metadata = new Map((shas.length ? commits(await this.git.run(this.path, ['show', '-s', `--format=${commitFormat}`, ...shas, '--'])) : []).map((commit) => [commit.sha, commit]));
    const ranges: BlameRange[] = [];
    for (const line of lines) {
      const previous = ranges.at(-1);
      if (previous?.sha === line.sha && previous.end + 1 === line.line) { previous.end = line.line; continue; }
      const commit = metadata.get(line.sha)!;
      ranges.push({
        start: line.line, end: line.line, sha: line.sha,
        authorName: commit.authorName, date: commit.date, summary: commit.subject,
        ...(commit.trailers['Wiki-Job'] ? { jobId: commit.trailers['Wiki-Job'] } : {}),
        ...(commit.trailers['Wiki-Source'] ? { source: commit.trailers['Wiki-Source'] } : {}),
      });
    }
    return { ref: resolved, ranges };
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
  async pushMain(): Promise<{ pushed: boolean; reason?: string; remote?: string; sha?: string }> {
    const remotes = (await this.git.run(this.path, ['remote'])).trim().split('\n').filter(Boolean);
    if (!remotes.length) return { pushed: false, reason: 'No git remote configured; knowledge repository is local-only' };
    const remote = remotes.includes('origin') ? 'origin' : remotes[0]!;
    const sha = await this.headSha();
    await this.git.run(this.path, ['push', remote, `${sha}:refs/heads/main`]);
    return { pushed: true, remote, sha };
  }
}

export class Worktree {
  private author: Author | undefined;
  private metadata: CommitMetadata | undefined;
  onPhase?: (phase: 'editing' | 'resolving_conflict', detail: Record<string, unknown>) => void;
  private disposed = false;
  constructor(readonly path: string, readonly branch: string, readonly baseSha: string, private readonly primary: string, private readonly git: Git) {}
  setCommitMetadata(metadata: CommitMetadata): void {
    commitTrailers(metadata);
    this.metadata = { ...metadata };
  }
  private message(subject: string): string {
    const metadata = this.metadata ?? { jobId: this.branch.slice('work/'.length), source: 'web', requester: this.author?.email ?? this.git.cfg.gitBotEmail };
    return `${subject.trimEnd()}\n\n${commitTrailers(metadata)}`;
  }
  async read(path: string): Promise<string | null> {
    const file = await confined(this.path, path);
    try { return await readFile(file, 'utf8'); } catch (error) { if (missing(error)) return null; throw error; }
  }
  async hasFile(path: string): Promise<boolean> {
    const file = await confined(this.path, path);
    try { return (await stat(file)).isFile(); }
    catch (error) { if (missing(error)) return false; throw error; }
  }
  async write(path: string, content: string | Buffer): Promise<void> {
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
    await this.git.run(this.path, ['commit', '-m', this.message(message)], this.git.identity(author));
    return this.git.sha(this.path, 'HEAD');
  }
  async mergeMain(): Promise<{ ok: true } | { ok: false; conflicts: string[] }> {
    try {
      await this.git.run(this.path, ['merge', '-m', this.message(`Merge main into ${this.branch}`), 'refs/heads/main'], this.git.identity(this.author));
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
    await this.git.run(this.path, ['commit', '-m', this.message(`Resolve merge of main into ${this.branch}`)], this.git.identity(author));
    return this.git.sha(this.path, 'HEAD');
  }
  async fastForwardMain(): Promise<string> {
    await this.git.run(this.primary, ['merge', '--ff-only', this.branch], this.git.identity(this.author));
    return this.git.sha(this.primary, 'refs/heads/main');
  }
  async preserveFailed(jobId: string): Promise<string> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(jobId)) throw new Error('Job ID must be a safe identifier');
    const sha = await this.git.sha(this.path, 'HEAD');
    await this.git.run(this.primary, ['update-ref', `refs/wiki/failed/${jobId}`, sha]);
    return sha;
  }
  async revert(sha: string, paths?: string[]): Promise<void> {
    const resolved = await this.git.sha(this.path, sha);
    const parents = (await this.git.run(this.path, ['show', '-s', '--format=%P', resolved])).trim().split(' ').filter(Boolean);
    const from = parents[0] ?? emptyTree;
    const selected = paths?.map((path) => repoPath(path));
    if (selected?.length === 0) return;
    const files = changes(await this.git.run(this.path, ['diff', '--name-status', '-z', '--find-renames', from, resolved, '--', ...(selected ?? [])]));
    for (const file of files) {
      await confined(this.path, file.path);
      if (file.oldPath) await confined(this.path, file.oldPath);
    }
    const patch = await this.git.run(this.path, ['diff', '--binary', '--full-index', '--find-renames', from, resolved, '--', ...(selected ?? [])]);
    if (!patch) return;
    try {
      await this.git.run(this.path, ['add', '--all']);
      await this.git.run(this.path, ['apply', '--reverse', '--index', '--3way'], {}, patch);
    } catch (error) {
      const explanation = error !== null && typeof error === 'object' && 'stderr' in error ? String(error.stderr).trim() : String(error);
      throw Object.assign(new Error(`Cannot revert ${resolved} onto the current worktree: ${explanation}`, { cause: error }), { status: 409, code: 'revert_conflict' });
    }
  }
  async diff(): Promise<{ files: FileChange[]; patch: string }> {
    await this.git.run(this.path, ['add', '--all']);
    return {
      files: changes(await this.git.run(this.path, ['diff', '--cached', '--name-status', '-z', '--find-renames', 'HEAD', '--'])),
      patch: await this.git.run(this.path, ['diff', '--cached', '--binary', '--find-renames', 'HEAD', '--']),
    };
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.git.run(this.primary, ['worktree', 'remove', '--force', '--force', this.path]);
    await this.git.run(this.primary, ['branch', '-D', '--', this.branch]);
    this.disposed = true;
  }
}
