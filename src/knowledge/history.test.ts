import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import pino from 'pino';
import { afterEach, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { legacyUuidToApi } from '../common/ids.js';
import { commitTrailers } from './commit-trailers.js';
import { KnowledgeRepo, repoPath } from './repo.js';

const dirs: string[] = [];
const author = { name: 'Writer', email: 'writer@example.test' };
const metadata = { jobId: 'job-123', source: 'web', requester: author.email, client: 'editor' };
const noteFrontmatter = `---
type: note
aliases: ["History fixture"]
description: Exercises exact note history and recovery.
author: ["Writer"]
date created: 2020-01-01
date modified: 2026-10-10
tags: [history]
source: ["https://example.test/history"]
confidence: high
---
`;
function note(body: string): string { return noteFrontmatter + body; }
async function fixture() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-10T00:00:00.000Z'));
  const dir = await mkdtemp(join(tmpdir(), 'knowledge-history-'));
  dirs.push(dir);
  const repo = await KnowledgeRepo.open(loadConfig({ NODE_ENV: 'test', DATA_DIR: dir }), pino({ level: 'silent' }));
  return { repo, dir };
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  vi.useRealTimers();
});

it('follows renames with historical paths even across a page cursor', async () => {
  const { repo } = await fixture();
  const wt = await repo.createWorktree('rename');
  await wt.write('wiki/old.md', note('first\nsecond\nthird\n'));
  const first = (await wt.commit('Create', author))!;
  await wt.move('wiki/old.md', 'wiki/new.md');
  const renamed = (await wt.commit('Move', author))!;
  await wt.write('wiki/new.md', note('first\nsecond\nthird\nfourth\n'));
  const last = (await wt.commit('Update', author))!;
  await wt.fastForwardMain();
  const rows = await repo.log('wiki/new.md', { follow: true });
  expect(rows.map(({ sha, path, oldPath }) => ({ sha, path, oldPath }))).toEqual([
    { sha: last, path: 'wiki/new.md', oldPath: undefined },
    { sha: renamed, path: 'wiki/new.md', oldPath: 'wiki/old.md' },
    { sha: first, path: 'wiki/old.md', oldPath: undefined },
  ]);
  expect((await repo.log('wiki/new.md', { follow: true, before: renamed, limit: 1 })).map(({ sha, path }) => ({ sha, path }))).toEqual([{ sha: first, path: 'wiki/old.md' }]);
  expect((await repo.log('wiki/new.md')).map(({ sha }) => sha)).toEqual([last, renamed]);
  expect((await repo.log('wiki/new.md', { ref: renamed, follow: true })).map(({ sha }) => sha)).toEqual([renamed, first]);
  expect((await repo.log({ ref: renamed, path: 'wiki/new.md' })).map(({ sha }) => sha)).toEqual([renamed]);
  expect((await repo.log('wiki/new.md', { ref: renamed, follow: true, before: renamed })).map(({ sha, path }) => ({ sha, path }))).toEqual([{ sha: first, path: 'wiki/old.md' }]);
});

it('records trailers and attributes grouped blame ranges to the introducing jobs', async () => {
  const { repo } = await fixture();
  const seed = (await repo.show(await repo.headSha())).commit;
  expect(seed.trailers).toEqual({ 'Wiki-Job': 'initialize', 'Wiki-Source': 'dreaming', 'Wiki-Requester': 'dony@llmwiki.local' });
  const wt = await repo.createWorktree('blame');
  wt.setCommitMetadata(metadata);
  await wt.write('wiki/lines.md', note('one\ntwo\nthree\nfour\n'));
  const first = (await wt.commit('Create lines', author))!;
  wt.setCommitMetadata({ ...metadata, jobId: 'job-456', source: 'revert' });
  await wt.write('wiki/lines.md', note('one\nTWO\nthree\nfour\n'));
  const last = (await wt.commit('Edit line', author))!;
  await wt.fastForwardMain();
  expect((await repo.show(first)).commit).toMatchObject({ committerName: '도니', committerEmail: 'dony@llmwiki.local', committedAt: expect.any(String), trailers: { 'Wiki-Job': metadata.jobId, 'Wiki-Source': 'web', 'Wiki-Requester': author.email, 'Wiki-Client': 'editor' } });
  expect(await repo.blame('wiki/lines.md', 'main')).toEqual({ ref: last, ranges: [
    { start: 1, end: 12, sha: first, authorName: author.name, date: expect.any(String), summary: 'Create lines', jobId: 'job-123', source: 'web' },
    { start: 13, end: 13, sha: last, authorName: author.name, date: expect.any(String), summary: 'Edit line', jobId: 'job-456', source: 'revert' },
    { start: 14, end: 15, sha: first, authorName: author.name, date: expect.any(String), summary: 'Create lines', jobId: 'job-123', source: 'web' },
  ] });
  expect((await repo.blame('wiki/lines.md', first)).ranges).toMatchObject([{ start: 1, end: 15, sha: first }]);
  expect(commitTrailers(metadata).split('\n')).toEqual(['Wiki-Job: job-123', 'Wiki-Source: web', `Wiki-Requester: ${author.email}`, 'Wiki-Client: editor']);
  expect(() => commitTrailers({ ...metadata, client: 'editor\nWiki-Source: spoof' })).toThrow();
});

it('normalizes historical UUID job trailers and blame while new commits write API IDs', async () => {
  const { repo } = await fixture();
  const uuid = '550e8400-e29b-41d4-a716-446655440000';
  const jobId = legacyUuidToApi(uuid);
  const wt = await repo.createWorktree('legacy-trailers');
  await wt.write('wiki/legacy.md', 'old line\n');
  const git = promisify(execFile);
  await git('git', ['add', '--all'], { cwd: wt.path });
  await git('git', ['commit', '-m', `Legacy write\n\nWiki-Job: ${uuid}\nWiki-Source: web\nWiki-Requester: ${author.email}`], { cwd: wt.path });
  const { stdout } = await git('git', ['rev-parse', 'HEAD'], { cwd: wt.path });
  const legacySha = stdout.trim();
  await wt.fastForwardMain();
  expect((await repo.log('wiki/legacy.md'))[0]!.trailers['Wiki-Job']).toBe(jobId);
  expect((await repo.show(legacySha)).commit.trailers['Wiki-Job']).toBe(jobId);
  expect((await repo.blame('wiki/legacy.md')).ranges).toMatchObject([{ sha: legacySha, jobId }]);
  wt.setCommitMetadata({ ...metadata, jobId: uuid });
  await wt.write('wiki/legacy.md', note('new line\n'));
  const currentSha = (await wt.commit('Current write', author))!;
  const message = (await git('git', ['show', '-s', '--format=%B', currentSha], { cwd: wt.path })).stdout;
  expect(message).toContain(`Wiki-Job: ${jobId}`);
  expect(message).not.toContain(uuid);
  expect(commitTrailers({ ...metadata, jobId: uuid })).toContain(`Wiki-Job: ${jobId}`);
});

it('resolves UUID-named failed refs by API ID and prefers a newer API-named ref', async () => {
  const { repo, dir } = await fixture();
  const uuid = '550e8400-e29b-41d4-a716-446655440000';
  const jobId = legacyUuidToApi(uuid);
  const wt = await repo.createWorktree('legacy-failure');
  await wt.write('wiki/failed.md', note('legacy failure\n'));
  const legacySha = (await wt.commit('Legacy failure', author))!;
  const git = promisify(execFile);
  await git('git', ['update-ref', `refs/wiki/failed/${uuid}`, legacySha], { cwd: join(dir, 'knowledge') });
  await wt.dispose();
  const ref = `refs/wiki/failed/${jobId}`;
  expect(await repo.resolveRef(ref)).toBe(legacySha);
  expect(await repo.readFile('wiki/failed.md', ref)).toBe(note('legacy failure\n'));
  const replacement = await repo.createWorktree('new-failure');
  await replacement.write('wiki/failed.md', note('new failure\n'));
  const newSha = (await replacement.commit('New failure', author))!;
  await replacement.preserveFailed(jobId);
  await replacement.dispose();
  expect(await repo.resolveRef(ref)).toBe(newSha);
  expect(await repo.readFile('wiki/failed.md', ref)).toBe(note('new failure\n'));
});

it('compares either merge parent and enriches automatic and resolved merges', async () => {
  const { repo } = await fixture();
  const left = await repo.createWorktree('left');
  const right = await repo.createWorktree('right');
  right.setCommitMetadata(metadata);
  await left.write('wiki/left.md', note('left\n'));
  const leftSha = (await left.commit('Left', author))!;
  await right.write('wiki/right.md', note('right\n'));
  const rightSha = (await right.commit('Right', author))!;
  await left.fastForwardMain();
  await right.mergeMain();
  const merged = await right.fastForwardMain();
  expect((await repo.show(merged)).files).toEqual([{ status: 'A', path: 'wiki/left.md' }]);
  expect((await repo.show(merged, 2)).files).toEqual([{ status: 'A', path: 'wiki/right.md' }]);
  expect((await repo.show(merged, 2)).commit).toMatchObject({ parents: [rightSha, leftSha], trailers: { 'Wiki-Job': 'job-123' } });
  expect(await repo.compare(leftSha, merged, 'wiki/right.md')).toMatchObject({ base: leftSha, head: merged, files: [{ status: 'A', path: 'wiki/right.md' }], patch: expect.stringContaining('+right') });
  await expect(repo.show(merged, 3)).rejects.toMatchObject({ status: 400, code: 'invalid_parent' });
  await left.dispose(); await right.dispose();
  const a = await repo.createWorktree('conflict-a');
  const b = await repo.createWorktree('conflict-b');
  b.setCommitMetadata(metadata);
  await a.write('wiki/left.md', note('a\n')); await a.commit('A', author); await a.fastForwardMain();
  await b.write('wiki/left.md', note('b\n')); await b.commit('B', author);
  expect(await b.mergeMain()).toMatchObject({ ok: false });
  await b.write('wiki/left.md', note('resolved\n'));
  const resolved = await b.finishMerge(author);
  expect((await repo.show(resolved)).commit.trailers['Wiki-Job']).toBe('job-123');
});

it('applies a path-limited inverse atop later edits, including binary data and index changes', async () => {
  const { repo } = await fixture();
  const wt = await repo.createWorktree('inverse');
  const original = Buffer.from([0, 255, 1, 2, 3]);
  await wt.write('assets/file.bin', original);
  await wt.write('wiki/note.md', note('first\nsecond\nthird\nfourth\nfifth\nsixth\n'));
  await wt.write('wiki/keep.md', note('before\n'));
  await wt.commit('Initial', author);
  await wt.write('assets/file.bin', Buffer.from([0, 254, 3, 4]));
  await wt.write('wiki/note.md', note('FIRST\nsecond\nthird\nfourth\nfifth\nsixth\n'));
  await wt.write('wiki/keep.md', note('after\n'));
  const change = (await wt.commit('Change', author))!;
  await wt.write('wiki/note.md', note('FIRST\nsecond\nthird\nfourth\nfifth\nSIXTH\n'));
  await wt.commit('Later independent edit', author);
  await wt.write('wiki/note.md', note('FIRST\nsecond\nthird\nfourth\nFIFTH\nSIXTH\n'));
  await wt.revert(change, ['assets/file.bin', 'wiki/note.md']);
  expect(await readFile(join(wt.path, 'assets/file.bin'))).toEqual(original);
  expect(await wt.read('wiki/note.md')).toBe(note('first\nsecond\nthird\nfourth\nFIFTH\nSIXTH\n'));
  expect(await wt.read('wiki/keep.md')).toBe(note('after\n'));
  const diff = await wt.diff();
  expect(diff.files).toEqual([{ status: 'M', path: 'assets/file.bin' }, { status: 'M', path: 'wiki/note.md' }]);
  expect(diff.patch).toContain('GIT binary patch');
  expect(diff.patch).toContain('+first');
  await wt.commit('Inverse', author);
  expect(await wt.diff()).toEqual({ files: [], patch: '' });
});

it('reports inverse conflicts and preserves failed commits beyond disposal and reopening', async () => {
  const { repo, dir } = await fixture();
  const wt = await repo.createWorktree('failed');
  await wt.write('wiki/note.md', note('original\n')); await wt.commit('Original', author);
  await wt.write('wiki/note.md', note('change\n')); const change = (await wt.commit('Change', author))!;
  await wt.write('wiki/note.md', note('later\n')); const last = (await wt.commit('Later', author))!;
  await expect(wt.revert(change)).rejects.toMatchObject({ status: 409, code: 'revert_conflict', message: expect.stringContaining('current worktree') });
  expect(await wt.preserveFailed('failed-job')).toBe(last);
  await wt.dispose();
  const reopened = await KnowledgeRepo.open(loadConfig({ NODE_ENV: 'test', DATA_DIR: dir }), pino({ level: 'silent' }));
  expect(await reopened.resolveRef('refs/wiki/failed/failed-job')).toBe(last);
});

it('confines compare, blame, inverse paths and worktree diffs', async () => {
  const { repo, dir } = await fixture();
  const wt = await repo.createWorktree('boundary');
  await wt.write('wiki/new.md', note('new\n'));
  const untracked = await wt.diff();
  expect(untracked.files).toEqual([{ status: 'A', path: 'wiki/new.md' }]);
  const sha = (await wt.commit('New', author))!;
  await wt.fastForwardMain();
  for (const path of ['../outside', '/tmp/file', '.git/config', 'wiki/.GiT/config', 'wiki\\file', '.', './']) {
    expect(() => repoPath(path)).toThrow();
    await expect(repo.compare(sha, sha, path)).rejects.toThrow();
    await expect(repo.blame(path)).rejects.toThrow();
    await expect(wt.revert(sha, [path])).rejects.toThrow();
    await expect(repo.fileObjectId(path)).rejects.toThrow();
    await expect(wt.hasFile(path)).rejects.toThrow();
  }
  await symlink(dir, join(wt.path, 'escape'));
  await expect(wt.write('escape/outside', Buffer.from([0]))).rejects.toThrow('escapes');
  const linkSha = (await wt.commit('Link', author))!;
  await expect(repo.blame('escape', linkSha)).rejects.toThrow('Symlinks');
  await expect(repo.fileObjectId('escape', linkSha)).rejects.toThrow('Symlinks');
  await expect(wt.hasFile('escape/outside')).rejects.toThrow('escapes');
});

it('checks binary object identity from immutable tree metadata and distinguishes directory prefixes', async () => {
  const { repo } = await fixture();
  const wt = await repo.createWorktree('binary-existence');
  const bytes = Buffer.from([0, 255, 254, 1]);
  const expected = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  await wt.write('raw/hash/original.bin', bytes);
  expect(await wt.hasFile('raw/hash/original.bin')).toBe(true);
  expect(await wt.hasFile('raw/hash')).toBe(false);
  const original = (await wt.commit('Original', author))!;
  await wt.fastForwardMain();
  expect(await repo.fileObjectId('raw/hash/original.bin')).toBe(expected);
  expect(await repo.fileObjectId('raw/hash')).toBeNull();
  expect(await repo.fileObjectId('raw/hash/original')).toBeNull();
  await wt.remove('raw/hash/original.bin');
  expect(await wt.hasFile('raw/hash/original.bin')).toBe(false);
  await wt.commit('Delete', author);
  await wt.fastForwardMain();
  expect(await repo.fileObjectId('raw/hash/original.bin')).toBeNull();
  expect(await repo.fileObjectId('raw/hash/original.bin', original)).toBe(expected);
});

it('retains interrupted committed work before boot recovery removes its branch and edits', async () => {
  const { repo, dir } = await fixture();
  const main = await repo.headSha();
  const interrupted = await repo.createWorktree('interrupted-job');
  interrupted.setCommitMetadata({ ...metadata, jobId: 'interrupted-job' });
  await interrupted.write('wiki/interrupted.md', note('committed intent\n'));
  const sha = (await interrupted.commit('Interrupted', author))!;
  await interrupted.write('wiki/interrupted.md', note('uncommitted draft\n'));
  const reopened = await KnowledgeRepo.open(loadConfig({ NODE_ENV: 'test', DATA_DIR: dir }), pino({ level: 'silent' }));
  expect(await reopened.headSha()).toBe(main);
  expect(await reopened.resolveRef('refs/wiki/failed/interrupted-job')).toBe(sha);
  expect((await reopened.show('refs/wiki/failed/interrupted-job')).commit.trailers['Wiki-Job']).toBe('interrupted-job');
  expect(await reopened.readFile('wiki/interrupted.md', 'refs/wiki/failed/interrupted-job')).toBe(note('committed intent\n'));
  const replacement = await reopened.createWorktree('interrupted-job');
  expect(await replacement.read('wiki/interrupted.md')).toBeNull();
  await replacement.dispose();
  expect(await reopened.resolveRef('refs/wiki/failed/interrupted-job')).toBe(sha);
});
