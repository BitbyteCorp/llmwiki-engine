import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import pino from 'pino';
import { afterEach, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { KnowledgeRepo } from './repo.js';

const git = promisify(execFile);
const dirs: string[] = [];
const author = { name: 'Requesting User', email: 'request@example.test' };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'knowledge-test-'));
  dirs.push(dir);
  const cfg = loadConfig({ NODE_ENV: 'test', DATA_DIR: dir });
  return { dir, cfg, repo: await KnowledgeRepo.open(cfg, pino({ level: 'silent' })) };
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it('isolates worktree writes, commits as the requester, and fast-forwards main', async () => {
  const { dir, repo } = await fixture();
  const initial = await repo.headSha();
  const wt = await repo.createWorktree('request-1');
  await wt.write('wiki/hello.md', '# Hello\n');
  expect(await repo.readFile('wiki/hello.md')).toBeNull();
  const sha = await wt.commit('Add hello\n\nRequested knowledge.', author);
  expect(sha).not.toBeNull();
  expect(await wt.commit('No changes', author)).toBeNull();
  await repo.withMergeLock(async () => {
    expect(await wt.mergeMain()).toEqual({ ok: true });
    expect(await wt.fastForwardMain()).toBe(sha);
  });
  expect(await repo.readFile('wiki/hello.md')).toBe('# Hello\n');
  expect(await repo.readFile('wiki/hello.md', initial)).toBeNull();
  expect(await repo.listFiles('wiki/')).toContain('wiki/hello.md');
  expect(await repo.diffNames(initial, sha!)).toEqual([{ status: 'A', path: 'wiki/hello.md' }]);
  const shown = await repo.show(sha!);
  expect(shown.commit).toMatchObject({ authorName: author.name, authorEmail: author.email });
  expect(shown.patch).toContain('+# Hello');
  expect((await git('git', ['show', '-s', '--format=%cn <%ce>', sha!], { cwd: join(dir, 'knowledge') })).stdout.trim()).toBe('Luna <luna@llmwiki.local>');
  expect(await repo.pushMain()).toMatchObject({ pushed: false, reason: expect.any(String) });
  await wt.dispose();
});

it('resolves two concurrent edits in the work branch before advancing main', async () => {
  const { repo, dir } = await fixture();
  const seed = await repo.createWorktree('start');
  await seed.write('wiki/conflict.md', 'original\n');
  await seed.commit('Start conflict note', author);
  await seed.fastForwardMain();
  await seed.dispose();
  const left = await repo.createWorktree('left');
  const right = await repo.createWorktree('right');
  await left.write('wiki/conflict.md', 'left\n');
  const leftSha = await left.commit('Left edit', author);
  await right.write('wiki/conflict.md', 'right\n');
  const rightSha = await right.commit('Right edit', author);
  await repo.withMergeLock(async () => {
    await left.mergeMain();
    await left.fastForwardMain();
  });
  await repo.withMergeLock(async () => {
    expect(await right.mergeMain()).toEqual({ ok: false, conflicts: ['wiki/conflict.md'] });
    expect(await right.conflictedFiles()).toEqual(['wiki/conflict.md']);
    expect(await repo.headSha()).toBe(leftSha);
    await expect(right.fastForwardMain()).rejects.toThrow();
    await right.write('wiki/conflict.md', 'left and right resolved\n');
    const mergeSha = await right.finishMerge(author);
    expect((await repo.show(mergeSha)).commit).toMatchObject({ parents: [rightSha, leftSha], authorEmail: author.email });
    expect(await right.conflictedFiles()).toEqual([]);
    expect(await right.fastForwardMain()).toBe(mergeSha);
    expect(await repo.readFile('wiki/conflict.md')).toBe('left and right resolved\n');
    expect((await git('git', ['show', '-s', '--format=%cn <%ce>', mergeSha], { cwd: join(dir, 'knowledge') })).stdout.trim()).toBe('Luna <luna@llmwiki.local>');
  });
  await left.dispose();
  await right.dispose();
});

it('preserves requester authorship on an automatic non-conflicting merge', async () => {
  const { repo } = await fixture();
  const left = await repo.createWorktree('auto-left');
  const right = await repo.createWorktree('auto-right');
  await left.write('wiki/left.md', 'left\n');
  const leftSha = await left.commit('Left note', author);
  await right.write('wiki/right.md', 'right\n');
  const rightSha = await right.commit('Right note', author);
  const latestAuthor = { name: 'Second Requester', email: 'second@example.test' };
  expect(await right.commit('No leftover changes', latestAuthor)).toBeNull();
  await left.fastForwardMain();
  expect(await right.mergeMain()).toEqual({ ok: true });
  const merged = await right.fastForwardMain();
  expect((await repo.show(merged)).commit).toMatchObject({ parents: [rightSha, leftSha], authorName: latestAuthor.name, authorEmail: latestAuthor.email });
  expect(await repo.readFile('wiki/left.md')).toBe('left\n');
  expect(await repo.readFile('wiki/right.md')).toBe('right\n');
  await left.dispose();
  await right.dispose();
});

it('confines file operations and immutable ref reads against traversal and symlinks', async () => {
  const { repo, dir } = await fixture();
  const wt = await repo.createWorktree('confined');
  const invalid = ['../outside.md', '/tmp/outside.md', '.git/config', 'wiki/../../outside.md', 'wiki/.git/config', 'C:\\outside.md'];
  for (const path of invalid) {
    await expect(wt.read(path)).rejects.toThrow();
    await expect(wt.write(path, 'unsafe')).rejects.toThrow();
    await expect(wt.remove(path)).rejects.toThrow();
    await expect(wt.move('index.md', path)).rejects.toThrow();
    await expect(wt.move(path, 'wiki/destination.md')).rejects.toThrow();
    await expect(wt.list(path)).rejects.toThrow();
    await expect(repo.readFile(path)).rejects.toThrow();
    await expect(repo.listFiles(path)).rejects.toThrow();
    await expect(repo.log({ path, limit: 0 })).rejects.toThrow();
  }
  const outside = join(dir, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'secret.md'), 'secret');
  await symlink(outside, join(wt.path, 'escape'));
  await symlink(join(dir, 'knowledge', '.git'), join(wt.path, 'metadata'));
  await symlink(join(outside, 'missing'), join(wt.path, 'dangling'));
  for (const path of ['escape/secret.md', 'escape/new.md', 'metadata/config', 'dangling']) {
    await expect(wt.read(path)).rejects.toThrow();
    await expect(wt.write(path, 'unsafe')).rejects.toThrow();
    await expect(wt.remove(path)).rejects.toThrow();
    await expect(wt.move('index.md', path)).rejects.toThrow();
  }
  await expect(wt.list()).rejects.toThrow();
  await rm(join(wt.path, 'escape'));
  await rm(join(wt.path, 'metadata'));
  await rm(join(wt.path, 'dangling'));
  await wt.write('wiki/safe.md', 'safe');
  await wt.write('raw/source.txt', 'raw');
  await wt.write('raw-extra/source.md', 'separate directory');
  await symlink('wiki/safe.md', join(wt.path, 'safe-link.md'));
  expect(await wt.read('safe-link.md')).toBe('safe');
  expect(await wt.list('raw/')).toContain('raw/source.txt');
  expect(await wt.list('raw/')).not.toContain('raw-extra/source.md');
  await wt.commit('Safe notes and link', author);
  await wt.fastForwardMain();
  expect(await repo.listFiles('raw/')).not.toContain('raw-extra/source.md');
  await expect(repo.readFile('safe-link.md')).rejects.toThrow();
  expect(await repo.listFiles()).not.toContain('safe-link.md');
  await wt.dispose();
});

it('prunes crash worktrees and abandoned work branches without changing main', async () => {
  const { repo, cfg, dir } = await fixture();
  const head = await repo.headSha();
  const abandoned = await repo.createWorktree('crashed');
  await abandoned.write('wiki/uncommitted.md', 'lost edit');
  const missingTree = await repo.createWorktree('missing-tree');
  await rm(missingTree.path, { recursive: true, force: true });
  await git('git', ['branch', 'work/orphan'], { cwd: join(dir, 'knowledge') });
  await mkdir(join(dir, 'worktrees', 'unregistered'));
  const reopened = await KnowledgeRepo.open(cfg, pino({ level: 'silent' }));
  expect(await reopened.headSha()).toBe(head);
  expect(await reopened.readFile('wiki/uncommitted.md')).toBeNull();
  expect(await readdir(join(dir, 'worktrees'))).toEqual([]);
  expect((await git('git', ['for-each-ref', '--format=%(refname)', 'refs/heads/work/'], { cwd: join(dir, 'knowledge') })).stdout).toBe('');
  const recovered = await reopened.createWorktree('crashed');
  await recovered.dispose();
});

it('parses renames, unusual filenames, full messages, and history cursors', async () => {
  const { repo } = await fixture();
  const root = await repo.headSha();
  const rootShow = await repo.show(root);
  expect(rootShow.commit.parents).toEqual([]);
  expect(rootShow.files).toEqual(await repo.diffNames(null, root));
  const wt = await repo.createWorktree('history');
  const oldPath = 'wiki/한글\told\nnote.md';
  const newPath = 'wiki/한글\tnew\nnote.md';
  await wt.write(oldPath, '# Stable text\n\nLong note content remains exactly the same.\n');
  const first = (await wt.commit('First note\n\nFirst paragraph.\n\nSecond paragraph.', author))!;
  await wt.move(oldPath, newPath);
  const second = (await wt.commit('Rename note', author))!;
  await wt.write('wiki/unrelated.md', 'unrelated');
  const third = (await wt.commit('Unrelated note', author))!;
  await wt.fastForwardMain();
  expect(await repo.readFile(oldPath, first)).toContain('# Stable text');
  expect(await repo.readFile(oldPath)).toBeNull();
  expect(await repo.readFile(newPath)).toContain('# Stable text');
  expect(await repo.diffNames(first, second)).toEqual([{ status: 'R', oldPath, path: newPath }]);
  expect((await repo.show(second)).files).toEqual([{ status: 'R', oldPath, path: newPath }]);
  expect((await repo.log({ sinceSha: root })).map((commit) => commit.sha)).toEqual([third, second, first]);
  expect((await repo.log({ beforeSha: third })).map((commit) => commit.sha)).toEqual([second, first, root]);
  expect((await repo.log({ sinceSha: root, beforeSha: third })).map((commit) => commit.sha)).toEqual([second, first]);
  expect((await repo.log({ path: newPath, beforeSha: third })).map((commit) => commit.sha)).toEqual([second]);
  expect(await repo.log({ beforeSha: root })).toEqual([]);
  await expect(repo.show('does-not-exist')).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  await wt.dispose();
});

it('shows Korean paths in patch headers without octal escapes', async () => {
  const { dir, repo } = await fixture();
  await git('git', ['config', 'core.quotePath', 'true'], { cwd: join(dir, 'knowledge') });
  const wt = await repo.createWorktree('korean-note');
  const path = 'wiki/한국어-노트.md';
  await wt.write(path, '# 한국어 노트\n');
  const sha = (await wt.commit('Add Korean note', author))!;

  const shown = await repo.show(sha);
  expect(shown.files[0]?.path).toBe(path);
  expect(shown.patch).toContain(`diff --git a/${path} b/${path}`);
  expect(shown.patch).not.toMatch(/\\[0-7]{3}/);
  await wt.dispose();
});

it('clones an empty remote, seeds main, pushes it, and reopens its tracked state', async () => {
  const { dir } = await fixture();
  const remote = join(dir, 'backup.git');
  await git('git', ['init', '--bare', '-b', 'main', remote]);
  const cfg = loadConfig({ NODE_ENV: 'test', DATA_DIR: join(dir, 'client'), KNOWLEDGE_REPO_URL: remote });
  const repo = await KnowledgeRepo.open(cfg, pino({ level: 'silent' }));
  const initial = await repo.headSha();
  expect(await repo.readFile('AGENTS.md')).toContain('raw');
  expect(await repo.pushMain()).toEqual({ pushed: true, remote: 'origin', sha: initial });
  expect((await git('git', ['rev-parse', 'refs/heads/main'], { cwd: remote })).stdout.trim()).toBe(initial);
  const wt = await repo.createWorktree('remote-note');
  await wt.write('wiki/remote.md', 'backed up\n');
  const sha = await wt.commit('Back up note', author);
  await wt.fastForwardMain();
  await wt.dispose();
  await repo.pushMain();
  const cloneCfg = loadConfig({ NODE_ENV: 'test', DATA_DIR: join(dir, 'reader'), KNOWLEDGE_REPO_URL: remote });
  const clone = await KnowledgeRepo.open(cloneCfg, pino({ level: 'silent' }));
  expect(await clone.headSha()).toBe(sha);
  expect(await clone.readFile('wiki/remote.md')).toBe('backed up\n');
});

it('serializes merge locks across repository instances and releases after errors', async () => {
  const first = await fixture();
  const second = await fixture();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const failed = first.repo.withMergeLock(async () => {
    order.push('first');
    await gate;
    throw new Error('merge failed');
  });
  const failedAssertion = expect(failed).rejects.toThrow('merge failed');
  const queued = second.repo.withMergeLock(async () => { order.push('second'); return 42; });
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  expect(order).toEqual(['first']);
  release();
  await failedAssertion;
  expect(await queued).toBe(42);
  expect(order).toEqual(['first', 'second']);
});
