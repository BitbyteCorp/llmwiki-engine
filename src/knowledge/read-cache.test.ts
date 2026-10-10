import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pino from 'pino';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { KnowledgeRepo } from './repo.js';

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
  return { repo, dir, cwd: join(dir, 'knowledge') };
}
afterEach(async () => {
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
