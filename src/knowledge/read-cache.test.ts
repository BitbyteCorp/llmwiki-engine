import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import pino from 'pino';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { KnowledgeRepo } from './repo.js';
import type { CommitInfo } from './repo.js';

interface RepoInternals {
  git: {
    readBlobs(cwd: string, oids: readonly string[]): Promise<Map<string, string | null>>;
    run(cwd: string, args: string[]): Promise<string>;
  };
}

const git = promisify(execFile);
const dirs: string[] = [];
const author = { name: 'Writer', email: 'writer@example.test' };
const noteFrontmatter = `---
type: note
aliases: ["Cache fixture"]
description: Exercises immutable note snapshots and cache invalidation.
author: ["Writer"]
date created: 2020-01-01
date modified: 2026-10-10
tags: [cache]
source: ["https://example.test/cache"]
confidence: high
---
`;
function note(body: string): string { return noteFrontmatter + body; }
async function fixture() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-10T00:00:00.000Z'));
  const dir = await mkdtemp(join(tmpdir(), 'knowledge-cache-'));
  dirs.push(dir);
  const repo = await KnowledgeRepo.open(loadConfig({ NODE_ENV: 'test', DATA_DIR: dir }), pino({ level: 'silent' }));
  // The private Git boundary is the instrumentation seam, not a public API.
  const internals = repo as unknown as RepoInternals;
  return { repo, dir, cwd: join(dir, 'knowledge'), backend: internals.git };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.useRealTimers();
});

it('keeps cached snapshots immutable while main and an external ref advance or rewind', async () => {
  const { repo, cwd } = await fixture();
  const wt = await repo.createWorktree('cache');
  await wt.write('wiki/note.md', note('first\n'));
  const first = (await wt.commit('First', author))!;
  await wt.fastForwardMain();
  await git('git', ['update-ref', 'refs/tags/current', first], { cwd });
  for (const ref of ['main', 'refs/tags/current', first]) {
    expect(await repo.readFile('wiki/note.md', ref)).toBe(note('first\n'));
    expect(await repo.readFile('wiki/added.md', ref)).toBeNull();
    expect(await repo.listFiles('wiki/', ref)).toEqual(['wiki/note.md']);
    expect((await repo.blame('wiki/note.md', ref)).ranges).toMatchObject([{ sha: first }]);
    expect((await repo.log('wiki/note.md', { ref }))[0]!.sha).toBe(first);
  }
  await wt.write('wiki/note.md', note('second\n'));
  await wt.write('wiki/added.md', note('added\n'));
  const second = (await wt.commit('Second', author))!;
  // Updating refs outside KnowledgeRepo must be visible without a main.updated event.
  await git('git', ['update-ref', 'refs/heads/main', second], { cwd });
  await git('git', ['update-ref', 'refs/tags/current', second], { cwd });
  for (const ref of ['main', 'refs/tags/current']) {
    expect(await repo.readFile('wiki/note.md', ref)).toBe(note('second\n'));
    expect(await repo.readFile('wiki/added.md', ref)).toBe(note('added\n'));
    expect(await repo.listFiles('wiki/', ref)).toEqual(['wiki/added.md', 'wiki/note.md']);
    expect(await repo.blame('wiki/note.md', ref)).toMatchObject({ ref: second, ranges: [
      { start: 1, end: 11, sha: first },
      { start: 12, end: 12, sha: second },
    ] });
    expect((await repo.log('wiki/note.md', { ref })).map(({ sha }) => sha)).toEqual([second, first]);
  }
  expect(await repo.readFile('wiki/note.md', first)).toBe(note('first\n'));
  expect(await repo.readFile('wiki/added.md', first)).toBeNull();
  await git('git', ['update-ref', 'refs/tags/current', first], { cwd });
  expect(await repo.readFile('wiki/note.md', 'refs/tags/current')).toBe(note('first\n'));
  expect((await repo.log('wiki/note.md', { ref: 'refs/tags/current' })).map(({ sha }) => sha)).toEqual([first]);
  await git('git', ['update-ref', '-d', 'refs/tags/current'], { cwd });
  await expect(repo.readFile('wiki/note.md', 'refs/tags/current')).rejects.toMatchObject({ status: 404 });
});

it('refreshes warm main reads after an engine fast-forward and preserves cursor boundaries', async () => {
  const { repo } = await fixture();
  const wt = await repo.createWorktree('advance');
  await wt.write('wiki/note.md', note('one\n'));
  const first = (await wt.commit('One', author))!;
  await wt.fastForwardMain();
  await repo.readFile('wiki/note.md');
  await repo.blame('wiki/note.md');
  await repo.log('wiki/note.md', { limit: null });
  await wt.write('wiki/note.md', note('two\n'));
  const second = (await wt.commit('Two', author))!;
  await wt.fastForwardMain();
  expect(await repo.readFile('wiki/note.md')).toBe(note('two\n'));
  expect((await repo.blame('wiki/note.md')).ref).toBe(second);
  expect((await repo.log('wiki/note.md', { limit: null })).map(({ sha }) => sha)).toEqual([second, first]);
  expect((await repo.log('wiki/note.md', { before: second })).map(({ sha }) => sha)).toEqual([first]);
  expect((await repo.log('wiki/note.md', { sinceSha: first })).map(({ sha }) => sha)).toEqual([second]);
  expect((await repo.log('wiki/note.md', { ref: first })).map(({ sha }) => sha)).toEqual([first]);
});

it('resolves moving before and since refs even when the history root remains unchanged', async () => {
  const { repo, cwd } = await fixture();
  const wt = await repo.createWorktree('cursor');
  await wt.write('wiki/note.md', note('one\n'));
  const first = (await wt.commit('One', author))!;
  await wt.write('wiki/note.md', note('two\n'));
  const second = (await wt.commit('Two', author))!;
  await wt.fastForwardMain();
  await git('git', ['update-ref', 'refs/tags/cursor', second], { cwd });
  expect((await repo.log('wiki/note.md', { ref: second, before: 'refs/tags/cursor' })).map(({ sha }) => sha)).toEqual([first]);
  expect(await repo.log('wiki/note.md', { ref: second, sinceSha: 'refs/tags/cursor' })).toEqual([]);
  await git('git', ['update-ref', 'refs/tags/cursor', first], { cwd });
  expect(await repo.log('wiki/note.md', { ref: second, before: 'refs/tags/cursor' })).toEqual([]);
  expect((await repo.log('wiki/note.md', { ref: second, sinceSha: 'refs/tags/cursor' })).map(({ sha }) => sha)).toEqual([second]);
});

it('does not share mutable cached results between concurrent consumers or retain failures', async () => {
  const { repo, dir } = await fixture();
  const wt = await repo.createWorktree('isolation');
  await wt.write('wiki/note.md', note('line\n'));
  const sha = (await wt.commit('Original', author))!;
  await wt.fastForwardMain();
  const [left, right] = await Promise.all([repo.log(), repo.log()]);
  left[0]!.subject = 'redacted';
  left[0]!.parents.length = 0;
  left[0]!.trailers['Wiki-Job'] = 'redacted';
  expect(right[0]!).toMatchObject({ sha, subject: 'Original', trailers: { 'Wiki-Job': 'isolation' } });
  expect((await repo.log())[0]!).toMatchObject({ sha, subject: 'Original', trailers: { 'Wiki-Job': 'isolation' } });
  const blame = await repo.blame('wiki/note.md');
  blame.ranges[0]!.summary = 'redacted';
  expect((await repo.blame('wiki/note.md')).ranges[0]!.summary).toBe('Original');
  const files = await repo.listFiles();
  files.length = 0;
  expect(await repo.listFiles('wiki/')).toEqual(['wiki/note.md']);
  const changes = await repo.diffNames(null, sha);
  changes[0]!.path = 'redacted';
  expect((await repo.diffNames(null, sha)).some(({ path }) => path === 'wiki/note.md')).toBe(true);
  await expect(repo.readFile('wiki/note.md', 'refs/tags/later')).rejects.toMatchObject({ status: 404 });
  await git('git', ['update-ref', 'refs/tags/later', sha], { cwd: join(dir, 'knowledge') });
  expect(await repo.readFile('wiki/note.md', 'refs/tags/later')).toBe(note('line\n'));
  await symlink('note.md', join(wt.path, 'wiki/link.md'));
  await wt.commit('Symlink', author);
  await wt.fastForwardMain();
  expect(await repo.listFiles('wiki/')).toEqual(['wiki/note.md']);
  await expect(repo.readFile('wiki/link.md')).rejects.toThrow('Symlinks');
  await expect(repo.blame('wiki/link.md')).rejects.toThrow('Symlinks');
});

it('reads cold blobs in one byte-framed batch and keeps more than 256 small notes warm', async () => {
  const { repo, cwd, backend } = await fixture();
  const fixtures = new Map<string, Buffer>([
    ['wiki/normal.md', Buffer.from('# Normal\nplain markdown\n')],
    ['wiki/한글 이름.md', Buffer.from('# 한글\n지식과 꿈꾸기\n')],
    [`wiki/${'한글'.normalize('NFD')}.md`, Buffer.from('# NFD\n분해된 경로\n')],
    ['wiki/tab\tand\nnewline.md', Buffer.from('# Odd path\n')],
    ['raw/binary-ish.md', Buffer.concat([Buffer.from([0xff, 0x00, 0xfe]), Buffer.from('한글\nblob 3\n\0'.repeat(20000))])],
    ['raw/empty.md', Buffer.alloc(0)],
    ...Array.from({ length: 300 }, (_, index): [string, Buffer] =>
      [`raw/cache-${index}.md`, Buffer.from(`unique small note ${index}\n`)]),
  ]);
  for (const [path, bytes] of fixtures) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), bytes);
  }
  await git('git', ['add', '-A'], { cwd });
  await git('git', ['commit', '-m', 'Batch fixtures'], { cwd });
  const head = await repo.headSha();
  await repo.listFiles('', head);
  const batch = vi.spyOn(backend, 'readBlobs');
  const run = vi.spyOn(backend, 'run');
  const paths = [...fixtures.keys(), 'wiki/missing.md', './wiki/normal.md'];
  const contents = await repo.readFiles(paths, head);
  expect(batch).toHaveBeenCalledTimes(1);
  expect(batch.mock.calls[0]![1]).toHaveLength(fixtures.size);
  expect(run).not.toHaveBeenCalled();
  expect(contents.get('wiki/missing.md')).toBeNull();
  expect(contents.get('./wiki/normal.md')).toBe(fixtures.get('wiki/normal.md')!.toString('utf8'));
  for (const [path, bytes] of fixtures) {
    expect(contents.get(path)).toBe(bytes.toString('utf8'));
    expect(await repo.readFile(path, head)).toBe(contents.get(path));
  }
  expect(await repo.readFiles(paths, head)).toEqual(contents);
  expect(batch).toHaveBeenCalledTimes(1);
  expect(run).not.toHaveBeenCalled();
  expect(await backend.readBlobs(cwd, ['0'.repeat(40)])).toEqual(new Map([['0'.repeat(40), null]]));
});

it('validates all batch paths and rejects symlinks without starting a blob batch', async () => {
  const { repo, cwd, backend } = await fixture();
  await symlink('index.md', join(cwd, 'link.md'));
  await git('git', ['add', 'link.md'], { cwd });
  await git('git', ['commit', '-m', 'Symlink'], { cwd });
  const batch = vi.spyOn(backend, 'readBlobs');
  for (const path of ['../outside.md', '/tmp/outside.md', '.git/config', 'wiki/../outside.md', 'bad\0.md', '\ud800.md']) {
    await expect(repo.readFiles(['index.md', path])).rejects.toThrow();
  }
  await expect(repo.readFiles(['index.md', 'link.md'])).rejects.toThrow('Symlinks');
  expect(await repo.readFiles([])).toEqual(new Map());
  expect(batch).not.toHaveBeenCalled();
});

it('batches last-modifying metadata on linear history with exact per-path results at merges', async () => {
  const { repo, cwd, backend } = await fixture();
  await mkdir(join(cwd, 'raw'), { recursive: true });
  await writeFile(join(cwd, 'raw/one.md'), 'one\n');
  await writeFile(join(cwd, 'raw/한글\n둘.md'), 'two\n');
  await git('git', ['add', '-A'], { cwd });
  await git('git', ['commit', '-m', 'Both'], { cwd });
  await writeFile(join(cwd, 'raw/one.md'), 'changed\n');
  await git('git', ['commit', '-am', 'One'], { cwd });
  const paths = ['raw/one.md', 'raw/한글\n둘.md', 'raw/missing.md'];
  const expected = new Map<string, CommitInfo>();
  for (const path of paths) {
    const [touch] = await repo.log({ path, limit: 1 });
    if (touch) expected.set(path, touch);
  }
  const run = vi.spyOn(backend, 'run');
  const head = await repo.headSha();
  run.mockClear();
  expect(await repo.lastModified(paths, head)).toEqual(expected);
  expect(run.mock.calls.filter(([, args]) => args[0] === 'log')).toHaveLength(1);
  await git('git', ['checkout', '-b', 'side'], { cwd });
  await writeFile(join(cwd, 'raw/한글\n둘.md'), 'side edit\n');
  await git('git', ['commit', '-am', 'Side'], { cwd });
  await git('git', ['checkout', 'main'], { cwd });
  await writeFile(join(cwd, 'raw/one.md'), 'main edit\n');
  await git('git', ['commit', '-am', 'Main'], { cwd });
  await git('git', ['merge', '--no-ff', 'side', '-m', 'Merge side'], { cwd });
  const merged = await repo.lastModified(paths);
  for (const path of paths) {
    const [touch] = await repo.log({ path, limit: 1 });
    expect(merged.get(path)).toEqual(touch);
  }
});

it('coalesces concurrent blob misses and does not retain missing objects or batch failures', async () => {
  const { repo, cwd, backend } = await fixture();
  await mkdir(join(cwd, 'raw'), { recursive: true });
  await writeFile(join(cwd, 'raw/retry.md'), 'retry content\n');
  await git('git', ['add', '-A'], { cwd });
  await git('git', ['commit', '-m', 'Retry'], { cwd });
  const head = await repo.headSha();
  const batch = vi.spyOn(backend, 'readBlobs');
  batch.mockRejectedValueOnce(new Error('batch failed'));
  await expect(repo.readFiles(['raw/retry.md'], head)).rejects.toThrow('batch failed');
  batch.mockResolvedValueOnce(new Map());
  expect(await Promise.all([
    repo.readFiles(['raw/retry.md'], head),
    repo.readFiles(['raw/retry.md'], head),
  ])).toEqual([new Map([['raw/retry.md', null]]), new Map([['raw/retry.md', null]])]);
  expect(batch).toHaveBeenCalledTimes(2);
  expect(await Promise.all([
    repo.readFile('raw/retry.md', head),
    repo.readFiles(['raw/retry.md'], head),
  ])).toEqual(['retry content\n', new Map([['raw/retry.md', 'retry content\n']])]);
  expect(batch).toHaveBeenCalledTimes(3);
});
