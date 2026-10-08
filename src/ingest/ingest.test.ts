import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { zipSync, strToU8 } from 'fflate';
import matter from 'gray-matter';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import { AclService } from '../acl/acl.service.js';
import { UsersRepository } from '../auth/users.repository.js';
import { UsersService } from '../auth/users.service.js';
import { apiIdToLegacyUuid, newId } from '../common/ids.js';
import { loadConfig } from '../config.js';
import { openDb, runMigrations, type Db } from '../db/index.js';
import { EventsService } from '../events/events.service.js';
import { NoteWriterService } from '../jobs/note-writer.service.js';
import { WriteJobsRepository } from '../jobs/write-jobs.repository.js';
import { WriteJobsService } from '../jobs/write-jobs.service.js';
import { KnowledgeRepo, type Worktree } from '../knowledge/repo.js';
import type { AgentService } from '../agent/agent.service.js';
import type { IndexerService } from '../rag/indexer.service.js';
import { UploadsService } from '../uploads/uploads.service.js';
import { ImportsRepository } from './imports.repository.js';
import { IngestService } from './ingest.service.js';
const git = promisify(execFile);
const fixtures: Array<{ dir: string; db: Db; jobs: WriteJobsService; ingest: IngestService }> = [];
afterEach(async () => { for (const item of fixtures.splice(0)) { await item.jobs.stop(); item.ingest.onModuleDestroy(); item.db.close(); await rm(item.dir, { recursive: true, force: true }); } });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'llmwiki-ingest-'));
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: dir });
  const db = openDb(':memory:'); runMigrations(db);
  const users = new UsersService(new UsersRepository(db));
  const owner = users.create({ email: 'editor@example.com', role: 'editor' });
  const other = users.create({ email: 'other@example.com', role: 'viewer' });
  const log = pino({ level: 'silent' });
  const repo = await KnowledgeRepo.open(config, log);
  const events = new EventsService();
  const repository = new WriteJobsRepository(db);
  const indexer = { syncToHead: vi.fn(async () => {}) } as unknown as IndexerService;
  const observed: string[] = [];
  const agent = { runWrite: vi.fn(async (job: { input: string }, wt: Worktree) => {
    const path = job.input.match(/at (raw\/[^\s]+\.md)\./)![1]!;
    const source = await wt.read(path);
    observed.push(source!);
    await wt.write('wiki/imported.md', `# Integrated knowledge\n[Source](../${path})\n`);
    return { summary: 'Integrate imported knowledge' };
  }), resolveConflicts: vi.fn() } as unknown as AgentService;
  const acl = new AclService(db, users, new AuditService(db));
  const writer = new NoteWriterService(repository, repo, users, indexer, events, log, acl);
  const jobs = new WriteJobsService(repository, agent, indexer, repo, users, log, events, acl);
  const uploads = new UploadsService(config, db, writer, log);
  const imports = new ImportsRepository(db);
  const ingest = new IngestService(imports, uploads, writer, jobs, repository, repo, events, new AuditService(db));
  ingest.start();
  fixtures.push({ dir, db, jobs, ingest });
  return { dir, db, repo, owner, other, jobs, uploads, ingest, imports, repository, agent, observed, events, writer };
}

describe('IngestService with real uploads, SQLite and git', () => {
  it('commits immutable original and provenance atomically, then integrates once through Dony', async () => {
    const ctx = await fixture();
    const before = await ctx.repo.headSha();
    const result = await ctx.ingest.ingest({ userId: ctx.owner.id, kind: 'text', text: '# Source\nDurable knowledge', filename: 'knowledge.md', instructions: 'Explain the key idea' });
    expect(result.importId).toMatch(/^[0-9A-Za-z]{22}$/);
    expect(result.jobIds).toEqual([expect.stringMatching(/^[0-9A-Za-z]{22}$/)]);
    const item = ctx.ingest.get(result.importId, ctx.owner.id);
    const sha = createHash('sha256').update('# Source\nDurable knowledge').digest('hex');
    expect(item.sha).toBe(sha);
    expect(item.status).toBe('queued');
    expect(item.rawPaths).toEqual([`raw/${sha}/original/knowledge.md`, `raw/${sha}/imports/${result.importId}.md`]);
    expect(await ctx.repo.readFile(item.rawPaths[0]!)).toBe('# Source\nDurable knowledge');
    expect(await ctx.repo.readFile(item.rawPaths[1]!)).toContain('source: "text:knowledge.md"');
    expect(matter((await ctx.repo.readFile(item.rawPaths[1]!))!).data.importer).toBe(ctx.owner.id);
    const commits = await ctx.repo.log(undefined, { limit: 10 });
    expect(commits[0]!.trailers['Wiki-Source']).toBe('import');
    expect(commits[0]!.trailers['Wiki-Requester']).toBe('editor@example.com');
    const { stdout } = await git('git', ['rev-list', '--count', `${before}..main`], { cwd: join(ctx.dir, 'knowledge') });
    expect(stdout.trim()).toBe('1');
    const queued = ctx.jobs.get(result.jobIds[0]!)!;
    expect(queued.kind).toBe('agent');
    expect(queued.source).toBe('import');
    expect(queued.input).toContain(item.rawPaths[1]);
    expect(queued.input).toContain('Explain the key idea');
    ctx.jobs.start();
    await vi.waitFor(() => expect(ctx.ingest.get(result.importId, ctx.owner.id).status).toBe('succeeded'), { timeout: 10_000 });
    expect(ctx.observed[0]).toContain('Durable knowledge');
    expect(await ctx.repo.readFile('wiki/imported.md')).toContain(item.rawPaths[1]);
    expect(ctx.agent.runWrite).toHaveBeenCalledTimes(1);
    expect(ctx.jobs.list().filter((job) => job.kind === 'agent')).toHaveLength(1);
  });
  it('links an import to each retried integration job and clears its previous failure', async () => {
    const ctx = await fixture();
    vi.mocked(ctx.agent.runWrite).mockRejectedValueOnce(new Error('First integration failed')).mockRejectedValueOnce(new Error('Second integration failed'));
    const result = await ctx.ingest.ingest({ userId: ctx.owner.id, kind: 'text', text: 'Retryable source' });
    const original = ctx.ingest.get(result.importId, ctx.owner.id);
    ctx.jobs.start();
    await vi.waitFor(() => expect(ctx.ingest.get(result.importId, ctx.owner.id)).toMatchObject({ jobs: [{ jobId: result.jobIds[0], status: 'failed' }], status: 'failed', error: 'batch 1/1: First integration failed' }), { timeout: 10_000 });
    await ctx.jobs.stop();
    expect(ctx.ingest.get(result.importId, ctx.owner.id).finishedAt).not.toBeNull();

    const retry = ctx.jobs.retry(result.jobIds[0]!);
    expect(ctx.imports.get(result.importId)).toMatchObject({ jobs: [{ jobId: retry.id }], status: 'queued', error: null, finishedAt: null });
    expect(ctx.ingest.list(ctx.owner.id)[0]).toMatchObject({ jobs: [{ jobId: retry.id }], status: 'queued', rawPaths: original.rawPaths, sha: original.sha });
    ctx.jobs.start();
    await vi.waitFor(() => expect(ctx.ingest.get(result.importId, ctx.owner.id)).toMatchObject({ jobs: [{ jobId: retry.id }], status: 'failed', error: 'batch 1/1: Second integration failed' }), { timeout: 10_000 });
    await ctx.jobs.stop();

    const nextRetry = ctx.jobs.retry(retry.id);
    expect(ctx.imports.get(result.importId)).toMatchObject({ jobs: [{ jobId: nextRetry.id }], status: 'queued', error: null, finishedAt: null });
    ctx.jobs.start();
    await vi.waitFor(() => expect(ctx.ingest.get(result.importId, ctx.owner.id)).toMatchObject({ jobs: [{ jobId: nextRetry.id }], status: 'succeeded', error: null }), { timeout: 10_000 });
    expect(ctx.jobs.get(result.jobIds[0]!)!.status).toBe('failed');
    expect(ctx.jobs.get(retry.id)!.status).toBe('failed');
    expect(await ctx.repo.readFile('wiki/imported.md')).toContain(original.rawPaths[1]);
  });
  it.each(['read', 'startup'] as const)('recovers missed integration retry chains on %s', async (recovery) => {
    const ctx = await fixture();
    vi.mocked(ctx.agent.runWrite).mockRejectedValueOnce(new Error('Original failed')).mockRejectedValueOnce(new Error('Retry failed'));
    const result = await ctx.ingest.ingest({ userId: ctx.owner.id, kind: 'text', text: 'Recoverable source' });
    ctx.jobs.start();
    await vi.waitFor(() => expect(ctx.ingest.get(result.importId, ctx.owner.id).status).toBe('failed'), { timeout: 10_000 });
    await ctx.jobs.stop();
    ctx.ingest.onModuleDestroy();

    const retry = ctx.jobs.retry(result.jobIds[0]!);
    ctx.jobs.start();
    await vi.waitFor(() => expect(ctx.jobs.get(retry.id)!.status).toBe('failed'), { timeout: 10_000 });
    await ctx.jobs.stop();
    const nextRetry = ctx.jobs.retry(retry.id);
    expect(ctx.imports.get(result.importId)).toMatchObject({ jobs: [{ jobId: result.jobIds[0] }], status: 'failed', error: 'batch 1/1: Original failed' });

    if (recovery === 'startup') {
      ctx.ingest.start();
      expect(ctx.imports.get(result.importId)).toMatchObject({ jobs: [{ jobId: nextRetry.id }], status: 'queued', error: null, finishedAt: null });
    } else {
      expect(ctx.ingest.list(ctx.owner.id)[0]).toMatchObject({ jobs: [{ jobId: nextRetry.id }], status: 'queued', error: null, finishedAt: null });
    }
    ctx.jobs.start();
    await vi.waitFor(() => expect(ctx.ingest.get(result.importId, ctx.owner.id)).toMatchObject({ jobs: [{ jobId: nextRetry.id }], status: 'succeeded', error: null }), { timeout: 10_000 });
  });
  it('reuses identical immutable originals without rewriting and preserves each provenance record', async () => {
    const ctx = await fixture();
    const first = await ctx.ingest.ingest({ userId: ctx.owner.id, kind: 'text', text: 'Identical content', filename: 'same.md' });
    const second = await ctx.ingest.ingest({ userId: ctx.owner.id, kind: 'text', text: 'Identical content', filename: 'same.md' });
    const one = ctx.ingest.get(first.importId, ctx.owner.id);
    const two = ctx.ingest.get(second.importId, ctx.owner.id);
    expect(two.sha).toBe(one.sha);
    expect(two.rawPaths[0]).toBe(one.rawPaths[0]);
    expect(await ctx.repo.readFile(one.rawPaths[1]!)).toContain(first.importId);
    expect(await ctx.repo.readFile(two.rawPaths[1]!)).toContain(second.importId);
    const commit = (await ctx.repo.log(undefined, { limit: 1 }))[0]!;
    const detail = await ctx.repo.show(commit.sha);
    expect(detail.files.map((file) => file.path)).toEqual([two.rawPaths[1]]);
  });
  it('rejects pre-existing mismatched immutable bytes instead of linking false provenance', async () => {
    const ctx = await fixture();
    const text = 'Actual source bytes';
    const sha = createHash('sha256').update(text).digest('hex');
    const path = `raw/${sha}/original/source.md`;
    await ctx.writer.apply({ userId: ctx.owner.id, source: 'import', baseSha: await ctx.repo.headSha(), ops: [{ op: 'put', path, content: 'Wrong bytes', create: true }] });
    await expect(ctx.ingest.ingest({ userId: ctx.owner.id, kind: 'text', text })).rejects.toMatchObject({ code: 'raw_conflict', status: 409 });
    expect(await ctx.repo.readFile(path)).toBe('Wrong bytes');
    expect(ctx.jobs.list().filter((job) => job.kind === 'agent')).toEqual([]);
    expect(ctx.ingest.list(ctx.owner.id)[0]).toMatchObject({ status: 'failed', jobs: [] });
  });
  it.each(['obsidian', 'notion'] as const)('preserves %s ZIP bytes and extracted attachments in one raw commit', async (kind) => {
    const ctx = await fixture();
    const id = '0123456789abcdef0123456789abcdef';
    const suffix = kind === 'notion' ? ` ${id}` : '';
    const buffer = Buffer.from(zipSync({ [`Note${suffix}.md`]: strToU8(`[Other](Other${suffix.replace(' ', '%20')}.md)\n![[asset.png]]`), [`Other${suffix}.md`]: strToU8('# Other'), 'asset.png': new Uint8Array([137,80,78,71,0,255]) }));
    const upload = await ctx.uploads.save(ctx.owner.id, { name: 'vault.zip', mediaType: 'application/zip', purpose: 'import', buffer });
    const before = await ctx.repo.headSha();
    const result = await ctx.ingest.ingest({ userId: ctx.owner.id, kind, uploadId: kind === 'notion' ? apiIdToLegacyUuid(upload.id)! : upload.id });
    const item = ctx.ingest.get(result.importId, ctx.owner.id);
    const original = await git('git', ['show', `main:${item.rawPaths[0]}`], { cwd: join(ctx.dir, 'knowledge'), encoding: 'buffer' });
    expect(original.stdout).toEqual(buffer);
    expect(item.rawPaths).toContain(`raw/${item.sha}/extracted/${kind}/files/Note.md`);
    expect(await ctx.repo.readFile(`raw/${item.sha}/extracted/${kind}/files/Note.md`)).toContain('[Other](Other.md)');
    const attachment = await git('git', ['show', `main:raw/${item.sha}/extracted/${kind}/files/asset.png`], { cwd: join(ctx.dir, 'knowledge'), encoding: 'buffer' });
    expect(attachment.stdout).toEqual(Buffer.from([137,80,78,71,0,255]));
    const count = await git('git', ['rev-list', '--count', `${before}..main`], { cwd: join(ctx.dir, 'knowledge') });
    expect(count.stdout.trim()).toBe('1');
  });
  it('covers every vault Markdown in disjoint serial batches and retries only the failed batch', async () => {
    const ctx = await fixture();
    const pages = Array.from({ length: 81 }, (_, index) => `Page-${String(index).padStart(2, '0')}.md`);
    const archive = Object.fromEntries(pages.map((path, index) => [path, strToU8(`Durable fact ${index}`)]));
    archive['asset.png'] = new Uint8Array([137, 80, 78, 71]);
    const upload = await ctx.uploads.save(ctx.owner.id, { name: 'large.zip', mediaType: 'application/zip', purpose: 'import', buffer: Buffer.from(zipSync(archive)) });
    const result = await ctx.ingest.ingest({ userId: ctx.owner.id, kind: 'obsidian', uploadId: upload.id });
    const original = ctx.ingest.get(result.importId, ctx.owner.id);
    expect(result.jobIds).toHaveLength(3);
    expect(original.jobs.map((job) => ({ batch: job.batch, files: job.files }))).toEqual([
      { batch: 0, files: 40 }, { batch: 1, files: 40 }, { batch: 2, files: 1 },
    ]);
    const owned = result.jobIds.map((jobId) => {
      const paths = ctx.jobs.events(jobId).find((event) => event.phase === 'queued')!.detail!.sourcePaths as string[];
      expect(paths.slice(0, 2)).toEqual(original.rawPaths.slice(0, 2));
      return paths.slice(2);
    });
    const expected = pages.map((path) => `raw/${original.sha}/extracted/obsidian/files/${path}`);
    expect(owned.flat().sort()).toEqual(expected);
    expect(new Set(owned.flat()).size).toBe(pages.length);
    let failSecond = true;
    const consumed: string[] = [];
    vi.mocked(ctx.agent.runWrite).mockImplementation(async (job, wt, _author, _user, options) => {
      const batch = Number(job.input.match(/Batch (\d+) of 3/)![1]) - 1;
      if (batch === 1 && failSecond) {
        failSecond = false;
        throw new Error('Second batch failed');
      }
      if (batch === 2) expect(await wt.read('wiki/batch-0.md')).toContain('Durable fact 0');
      const paths = options!.requiredReads!;
      const facts = await Promise.all(paths.map((path) => wt.read(path)));
      consumed.push(...paths);
      await wt.write(`wiki/batch-${batch}.md`, `# Batch knowledge\n${facts.join('\n')}\n`);
      return { summary: 'Integrate batch knowledge' };
    });
    ctx.jobs.start();
    await vi.waitFor(() => expect(ctx.ingest.get(result.importId, ctx.owner.id)).toMatchObject({
      status: 'failed', error: 'batch 2/3: Second batch failed',
      jobs: [{ status: 'succeeded' }, { status: 'failed' }, { status: 'succeeded' }],
    }), { timeout: 10_000 });
    await ctx.jobs.stop();
    const retry = ctx.jobs.retry(result.jobIds[1]!);
    const retried = ctx.ingest.get(result.importId, ctx.owner.id);
    expect(retried.jobs.map((job) => job.jobId)).toEqual([result.jobIds[0], retry.id, result.jobIds[2]]);
    expect(retried).toMatchObject({ status: 'queued', error: null, finishedAt: null, rawPaths: original.rawPaths, sha: original.sha });
    ctx.jobs.start();
    await vi.waitFor(() => expect(ctx.ingest.get(result.importId, ctx.owner.id).status).toBe('succeeded'), { timeout: 10_000 });
    expect(consumed.sort()).toEqual(expected);
    for (let index = 0; index < 3; index++) {
      expect(await ctx.repo.readFile(`wiki/batch-${index}.md`)).toContain(`Durable fact ${index * 40}`);
    }
    ctx.ingest.get(result.importId, ctx.owner.id);
    ctx.ingest.list(ctx.owner.id);
    expect(ctx.db.prepare("SELECT outcome FROM audit_events WHERE action='import.complete' ORDER BY id").all()).toEqual([
      { outcome: 'failure' }, { outcome: 'success' },
    ]);
  });
  it('keeps unfinished batches non-terminal and reports a canceled retry as a failed batch', async () => {
    const ctx = await fixture();
    const archive = Object.fromEntries(Array.from({ length: 41 }, (_, index) => [`${index}.md`, strToU8('Fact')]));
    const upload = await ctx.uploads.save(ctx.owner.id, { name: 'states.zip', mediaType: 'application/zip', purpose: 'import', buffer: Buffer.from(zipSync(archive)) });
    const result = await ctx.ingest.ingest({ userId: ctx.owner.id, kind: 'notion', uploadId: upload.id });
    ctx.repository.markFailed(result.jobIds[0]!, 'Failure', new Date().toISOString());
    expect(ctx.ingest.get(result.importId, ctx.owner.id)).toMatchObject({ status: 'queued', error: null, finishedAt: null });
    ctx.repository.markMerging(result.jobIds[1]!, 'Merge', []);
    expect(ctx.ingest.get(result.importId, ctx.owner.id)).toMatchObject({ status: 'running', finishedAt: null, jobs: [{ status: 'failed' }, { status: 'running' }] });
    ctx.repository.markSucceeded(result.jobIds[1]!, new Date().toISOString());
    expect(ctx.ingest.get(result.importId, ctx.owner.id)).toMatchObject({ status: 'failed', error: 'batch 1/2: Failure' });
    const retry = ctx.jobs.retry(result.jobIds[0]!);
    ctx.jobs.cancel(retry.id);
    expect(ctx.ingest.get(result.importId, ctx.owner.id)).toMatchObject({ status: 'failed', error: 'batch 1/2: canceled' });
  });
  it('hides owner imports and rejects foreign upload IDs while admins can inspect', async () => {
    const ctx = await fixture();
    const result = await ctx.ingest.ingest({ userId: ctx.owner.id, kind: 'text', text: 'Private source' });
    expect(ctx.ingest.list(ctx.other.id)).toEqual([]);
    expect(() => ctx.ingest.get(result.importId, ctx.other.id)).toThrow('Import not found');
    expect(ctx.ingest.get(result.importId, ctx.other.id, true).id).toBe(result.importId);
    const upload = await ctx.uploads.save(ctx.owner.id, { name: 'note.md', mediaType: 'text/markdown', buffer: Buffer.from('# Owned') });
    await expect(ctx.ingest.ingest({ userId: ctx.other.id, kind: 'file', uploadId: upload.id })).rejects.toThrow('Upload not found');
  });
  it('reconciles missed events on reads and interrupted extraction on startup', async () => {
    const ctx = await fixture();
    const result = await ctx.ingest.ingest({ userId: ctx.owner.id, kind: 'text', text: 'Source' });
    ctx.ingest.onModuleDestroy();
    ctx.repository.markFailed(result.jobIds[0]!, 'Integration failed', new Date().toISOString());
    expect(ctx.ingest.get(result.importId, ctx.owner.id)).toMatchObject({ status: 'failed', error: 'batch 1/1: Integration failed' });
    const interrupted = newId();
    ctx.imports.create(interrupted, ctx.owner.id, 'text', 'text:source.md');
    ctx.ingest.start();
    expect(ctx.ingest.get(interrupted, ctx.owner.id)).toMatchObject({ status: 'failed', error: 'Engine restarted before source import completed' });
  });
  it('normalizes requester instructions and rejects instructions beyond the limit', async () => {
    const ctx = await fixture();
    const result = await ctx.ingest.ingest({ userId: ctx.owner.id, kind: 'text', text: 'Source', instructions: `${' '.repeat(20_000)}Summarize the concept${' '.repeat(20_000)}` });
    const job = ctx.jobs.get(result.jobIds[0]!)!;
    expect(job.input).toContain('Requester instructions:\nSummarize the concept');
    await expect(ctx.ingest.ingest({ userId: ctx.owner.id, kind: 'text', text: 'Source', instructions: 'x'.repeat(10_001) })).rejects.toMatchObject({ code: 'invalid_import' });
  });
  it('rejects contradictory source kinds rather than dispatching silently', async () => {
    const ctx = await fixture();
    await expect(ctx.ingest.ingest({ userId: ctx.owner.id, kind: 'url', text: 'Not a URL' })).rejects.toMatchObject({ code: 'invalid_import' });
    await expect(ctx.ingest.ingest({ userId: ctx.owner.id, kind: 'text', text: 'text', url: 'https://example.com' })).rejects.toMatchObject({ code: 'invalid_import' });
  });
});
