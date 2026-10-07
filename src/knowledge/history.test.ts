import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { commitTrailers } from './commit-trailers.js';
import { KnowledgeRepo, repoPath } from './repo.js';

const dirs: string[] = [];
const author = { name: 'Writer', email: 'writer@example.test' };
const metadata = { jobId: 'job-123', source: 'web', requester: author.email, client: 'editor' };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'knowledge-history-'));
  dirs.push(dir);
  const repo = await KnowledgeRepo.open(loadConfig({ NODE_ENV: 'test', DATA_DIR: dir }), pino({ level: 'silent' }));
  return { repo, dir };
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

it('follows renames with historical paths even across a page cursor', async () => {
  const { repo } = await fixture();
  const wt = await repo.createWorktree('rename');
  await wt.write('wiki/old.md', 'first\nsecond\nthird\n');
  const first = (await wt.commit('Create', author))!;
  await wt.move('wiki/old.md', 'wiki/new.md');
  const renamed = (await wt.commit('Move', author))!;
  await wt.write('wiki/new.md', 'first\nsecond\nthird\nfourth\n');
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
  expect(seed.trailers).toEqual({ 'Wiki-Job': 'initialize', 'Wiki-Source': 'dreaming', 'Wiki-Requester': 'luna@llmwiki.local' });
  const wt = await repo.createWorktree('blame');
  wt.setCommitMetadata(metadata);
  await wt.write('wiki/lines.md', 'one\ntwo\nthree\nfour\n');
  const first = (await wt.commit('Create lines', author))!;
  wt.setCommitMetadata({ ...metadata, jobId: 'job-456', source: 'revert' });
  await wt.write('wiki/lines.md', 'one\nTWO\nthree\nfour\n');
  const last = (await wt.commit('Edit line', author))!;
  await wt.fastForwardMain();
  expect((await repo.show(first)).commit).toMatchObject({ committerName: 'Luna', committerEmail: 'luna@llmwiki.local', committedAt: expect.any(String), trailers: { 'Wiki-Job': metadata.jobId, 'Wiki-Source': 'web', 'Wiki-Requester': author.email, 'Wiki-Client': 'editor' } });
  expect(await repo.blame('wiki/lines.md', 'main')).toEqual({ ref: last, ranges: [
    { start: 1, end: 1, sha: first, authorName: author.name, date: expect.any(String), summary: 'Create lines', jobId: 'job-123', source: 'web' },
    { start: 2, end: 2, sha: last, authorName: author.name, date: expect.any(String), summary: 'Edit line', jobId: 'job-456', source: 'revert' },
    { start: 3, end: 4, sha: first, authorName: author.name, date: expect.any(String), summary: 'Create lines', jobId: 'job-123', source: 'web' },
  ] });
  expect((await repo.blame('wiki/lines.md', first)).ranges).toMatchObject([{ start: 1, end: 4, sha: first }]);
  expect(commitTrailers(metadata).split('\n')).toEqual(['Wiki-Job: job-123', 'Wiki-Source: web', `Wiki-Requester: ${author.email}`, 'Wiki-Client: editor']);
  expect(() => commitTrailers({ ...metadata, client: 'editor\nWiki-Source: spoof' })).toThrow();
});

it('compares either merge parent and enriches automatic and resolved merges', async () => {
  const { repo } = await fixture();
  const left = await repo.createWorktree('left');
  const right = await repo.createWorktree('right');
  right.setCommitMetadata(metadata);
  await left.write('wiki/left.md', 'left\n');
  const leftSha = (await left.commit('Left', author))!;
  await right.write('wiki/right.md', 'right\n');
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
  await a.write('wiki/left.md', 'a\n'); await a.commit('A', author); await a.fastForwardMain();
  await b.write('wiki/left.md', 'b\n'); await b.commit('B', author);
  expect(await b.mergeMain()).toMatchObject({ ok: false });
  await b.write('wiki/left.md', 'resolved\n');
  const resolved = await b.finishMerge(author);
  expect((await repo.show(resolved)).commit.trailers['Wiki-Job']).toBe('job-123');
});

it('applies a path-limited inverse atop later edits, including binary data and index changes', async () => {
  const { repo } = await fixture();
  const wt = await repo.createWorktree('inverse');
  const original = Buffer.from([0, 255, 1, 2, 3]);
  await wt.write('assets/file.bin', original);
  await wt.write('wiki/note.md', 'first\nsecond\nthird\nfourth\nfifth\nsixth\n');
  await wt.write('wiki/keep.md', 'before\n');
  await wt.commit('Initial', author);
  await wt.write('assets/file.bin', Buffer.from([0, 254, 3, 4]));
  await wt.write('wiki/note.md', 'FIRST\nsecond\nthird\nfourth\nfifth\nsixth\n');
  await wt.write('wiki/keep.md', 'after\n');
  const change = (await wt.commit('Change', author))!;
  await wt.write('wiki/note.md', 'FIRST\nsecond\nthird\nfourth\nfifth\nSIXTH\n');
  await wt.commit('Later independent edit', author);
  await wt.write('wiki/note.md', 'FIRST\nsecond\nthird\nfourth\nFIFTH\nSIXTH\n');
  await wt.revert(change, ['assets/file.bin', 'wiki/note.md']);
  expect(await readFile(join(wt.path, 'assets/file.bin'))).toEqual(original);
  expect(await wt.read('wiki/note.md')).toBe('first\nsecond\nthird\nfourth\nFIFTH\nSIXTH\n');
  expect(await wt.read('wiki/keep.md')).toBe('after\n');
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
  await wt.write('wiki/note.md', 'original\n'); await wt.commit('Original', author);
  await wt.write('wiki/note.md', 'change\n'); const change = (await wt.commit('Change', author))!;
  await wt.write('wiki/note.md', 'later\n'); const last = (await wt.commit('Later', author))!;
  await expect(wt.revert(change)).rejects.toMatchObject({ status: 409, code: 'revert_conflict', message: expect.stringContaining('current worktree') });
  expect(await wt.preserveFailed('failed-job')).toBe(last);
  await wt.dispose();
  const reopened = await KnowledgeRepo.open(loadConfig({ NODE_ENV: 'test', DATA_DIR: dir }), pino({ level: 'silent' }));
  expect(await reopened.resolveRef('refs/wiki/failed/failed-job')).toBe(last);
});

it('confines compare, blame, inverse paths and worktree diffs', async () => {
  const { repo, dir } = await fixture();
  const wt = await repo.createWorktree('boundary');
  await wt.write('wiki/new.md', 'new\n');
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
