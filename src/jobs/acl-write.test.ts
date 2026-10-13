import 'reflect-metadata';
import { Test, type TestingModule } from '@nestjs/testing';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import pino from 'pino';
import matter from 'gray-matter';
import { afterEach, expect, it, vi } from 'vitest';
import { AclModule } from '../acl/acl.module.js';
import { AclService } from '../acl/acl.service.js';
import { AuditService } from '../audit/audit.service.js';
import { UsersService } from '../auth/users.service.js';
import { CommonModule } from '../common/common.module.js';
import { CONFIG, LOGGER } from '../common/tokens.js';
import { loadConfig } from '../config.js';
import { DreamingModule } from '../dreaming/dreaming.module.js';
import { DreamingService } from '../dreaming/dreaming.service.js';
import { DreamRunsRepository } from '../dreaming/dream-runs.repository.js';
import { EventsModule } from '../events/events.module.js';
import { KnowledgeRepo } from '../knowledge/repo.js';
import { AgentService } from '../agent/agent.service.js';
import { OpsModule } from '../ops/ops.module.js';
import { JobsModule } from './jobs.module.js';
import { NoteWriterService, type NoteOp } from './note-writer.service.js';
import { WriteJobsService } from './write-jobs.service.js';
import { WriteJobsRepository } from './write-jobs.repository.js';

type FakeCall = { name: string; arguments: Record<string, unknown> };
type FakeScript = ReadonlyArray<string | FakeCall | { functionCalls: FakeCall[] }>;
interface FakeProvider {
  url: string;
  close(): Promise<void>;
  requests: Array<{ path: string; body: Record<string, unknown> }>;
}

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

function note(body: string): string {
  return `---\ntype: note\naliases: []\ndescription: Durable knowledge used by ACL tests.\ntags: [knowledge]\n---\n${body}`;
}
async function fixture(script: FakeScript = []) {
  // The shared test fixture is outside the production TypeScript root; static imports fail rootDir validation.
  const { startFakeOpenAI }: { startFakeOpenAI(script?: FakeScript): Promise<FakeProvider> } = await import(new URL('../../test/fake-openai.ts', import.meta.url).href);
  const dir = await mkdtemp(join(tmpdir(), 'acl-write-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const fake = await startFakeOpenAI(script);
  cleanup.push(() => fake.close());
  const log = pino({ level: 'silent' });
  const warning = vi.spyOn(log, 'warn');
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: dir, OPENAI_API_KEY: 'test', OPENAI_BASE_URL: fake.url, EMBEDDING_DIMENSIONS: '2' });
  const module: TestingModule = await Test.createTestingModule({ imports: [CommonModule, EventsModule, AclModule, JobsModule, DreamingModule, OpsModule] })
    .overrideProvider(CONFIG).useValue(config).overrideProvider(LOGGER).useValue(log).compile();
  cleanup.push(() => module.close());
  await module.init();
  const users = module.get(UsersService);
  const admin = await users.create({ email: 'admin@acl.test', role: 'admin' });
  const editor = await users.create({ email: 'editor@acl.test', role: 'editor' });
  const other = await users.create({ email: 'other@acl.test', role: 'editor' });
  const acl = module.get(AclService);
  acl.create({ prefix: 'wiki/private/', subjectType: 'everyone', subject: '', access: 'none' }, admin);
  acl.create({ prefix: 'wiki/readonly/', subjectType: 'everyone', subject: '', access: 'read' }, admin);
  acl.create({ prefix: 'raw/', subjectType: 'everyone', subject: '', access: 'none' }, admin);
  const repo = module.get(KnowledgeRepo);
  const writer = module.get(NoteWriterService);
  const jobs = module.get(WriteJobsService);
  const seed = await writer.apply({ userId: admin.id, source: 'web', baseSha: await repo.headSha(), ops: [
    { op: 'put', path: 'wiki/public.md', content: note('# Public\nDurable public fact.') },
    { op: 'put', path: 'wiki/private/secret.md', content: note('# Private\nHIDDEN_PAYLOAD') },
    { op: 'put', path: 'wiki/readonly/note.md', content: note('# Readonly\n') },
  ] });
  async function apply(ops: NoteOp[], userId = editor.id) {
    return writer.apply({ userId, source: 'web', baseSha: await repo.headSha(), ops });
  }
  async function completed(id: string) {
    await vi.waitFor(() => expect(['succeeded', 'failed']).toContain(jobs.get(id)?.status), { timeout: 15000, interval: 10 });
    await jobs.stop();
    return jobs.get(id)!;
  }
  return { module, users, admin, editor, other, acl, repo, writer, jobs, apply, completed, fake, seed, warning, config };
}

it('rejects direct puts/deletes and both move endpoints atomically while preserving admin bypass', async () => {
  const f = await fixture();
  const head = await f.repo.headSha();
  for (const ops of [
    [{ op: 'put', path: 'wiki/private/new.md', content: 'denied' }],
    [{ op: 'delete', path: 'wiki/private/secret.md' }],
    [{ op: 'move', from: 'wiki/private/secret.md', to: 'wiki/moved.md' }],
    [{ op: 'move', from: 'wiki/public.md', to: 'wiki/private/moved.md' }],
    [{ op: 'put', path: 'wiki/new.md', content: 'must not land' }, { op: 'delete', path: 'wiki/private/secret.md' }],
  ] satisfies NoteOp[][]) await expect(f.apply(ops)).rejects.toMatchObject({ status: 404 });
  await expect(f.apply([{ op: 'put', path: 'wiki/readonly/note.md', content: 'denied' }])).rejects.toMatchObject({ status: 403 });
  expect(await f.repo.headSha()).toBe(head);
  expect(await f.repo.readFile('wiki/new.md')).toBeNull();
  await f.apply([{ op: 'put', path: 'wiki/private/secret.md', content: 'admin revision' }], f.admin.id);
  expect(matter((await f.repo.readFile('wiki/private/secret.md'))!).content).toBe('admin revision');
  f.acl.create({ prefix: 'wiki/private/', subjectType: 'user', subject: String(f.other.id), access: 'write' }, f.admin);
  await f.apply([{ op: 'put', path: 'wiki/private/secret.md', content: 'authorized revision' }], f.other.id);
  expect(matter((await f.repo.readFile('wiki/private/secret.md'))!).content).toBe('authorized revision');
});

it('requires every touched revert path writable, including previews and rename source/destination', async () => {
  const f = await fixture();
  const changed = await f.apply([
    { op: 'put', path: 'wiki/public.md', content: 'public revision' },
    { op: 'put', path: 'wiki/private/secret.md', content: 'secret revision' },
  ], f.admin.id);
  const head = await f.repo.headSha();
  await expect(f.writer.applyRevert({ userId: f.editor.id, sha: changed.mergeSha, preview: true })).rejects.toMatchObject({ status: 404 });
  await expect(f.writer.applyRevert({ userId: f.editor.id, sha: changed.mergeSha })).rejects.toMatchObject({ status: 404 });
  const preview = await f.writer.applyRevert({ userId: f.editor.id, sha: changed.mergeSha, paths: ['wiki/public.md'], preview: true });
  expect(preview.patch).toContain('Durable public fact');
  expect(preview.patch).not.toContain('secret revision');
  expect(await f.repo.headSha()).toBe(head);
  const moved = await f.apply([{ op: 'move', from: 'wiki/public.md', to: 'wiki/private/moved.md' }], f.admin.id);
  await expect(f.writer.applyRevert({ userId: f.editor.id, sha: moved.mergeSha, paths: ['wiki/public.md'], preview: true })).rejects.toMatchObject({ status: 404 });
  expect(matter((await f.repo.readFile('wiki/private/moved.md'))!).content).toBe('public revision');
});

it('runs the real Dony tools with requester read/write ACLs, never sending hidden context to the provider', async () => {
  const f = await fixture([
    { functionCalls: [
      { name: 'list_files', arguments: {} },
      { name: 'read_file', arguments: { path: 'wiki/private/secret.md' } },
      { name: 'search', arguments: { query: 'HIDDEN_PAYLOAD' } },
      { name: 'write_file', arguments: { path: 'wiki/readonly/note.md', content: 'denied' } },
      { name: 'write_file', arguments: { path: 'wiki/result.md', content: note('# Allowed result\n') } },
    ] }, 'Saved allowed knowledge.',
  ]);
  f.jobs.start();
  const result = await f.completed(f.jobs.submit({ userId: f.editor.id, source: 'mcp', input: 'Capture durable knowledge' }).id);
  expect(result.status).toBe('succeeded');
  expect(matter((await f.repo.readFile('wiki/result.md'))!).content).toBe('# Allowed result\n');
  expect(matter((await f.repo.readFile('wiki/readonly/note.md'))!).content).toBe('# Readonly\n');
  const outputs = (f.fake.requests.filter(request => request.path.endsWith('/responses'))[1]!.body.input as Array<{ type: string; output?: string }>).filter(item => item.type === 'function_call_output').map(item => item.output!);
  expect(outputs[0]).not.toContain('wiki/private/secret.md');
  expect(JSON.parse(outputs[1]!)).toHaveProperty('error');
  expect(outputs.join('\\n')).not.toContain('HIDDEN_PAYLOAD');
  expect(outputs[2]).not.toContain('wiki/private/secret.md');
  expect(JSON.parse(outputs[3]!)).toHaveProperty('error');
});

it('fails unauthorized model changes and enforces current requester role before touching main', async () => {
  const f = await fixture();
  const agent = f.module.get(AgentService);
  const head = await f.repo.headSha();
  vi.spyOn(agent, 'runWrite').mockImplementationOnce(async (_job, wt) => {
    await wt.write('wiki/private/secret.md', 'unauthorized output');
    return { summary: 'must fail' };
  });
  f.jobs.start();
  const failed = await f.completed(f.jobs.submit({ userId: f.editor.id, source: 'import', input: 'Integrate source' }).id);
  expect(failed).toMatchObject({ status: 'failed', error: expect.stringContaining('Write denied') });
  expect(await f.repo.headSha()).toBe(head);
  vi.spyOn(agent, 'runWrite').mockImplementationOnce(async (_job, wt) => {
    await wt.write('wiki/allowed.md', 'downgraded output');
    f.users.update(f.editor.id, { role: 'viewer' });
    return { summary: 'must fail after role change' };
  });
  f.jobs.start();
  const downgraded = await f.completed(f.jobs.submit({ userId: f.editor.id, source: 'chat', input: 'Save' }).id);
  expect(downgraded.status).toBe('failed');
  expect(await f.repo.readFile('wiki/allowed.md')).toBeNull();
  expect(await f.repo.headSha()).toBe(head);
});

it('rechecks changed policy after conflict resolution and does not reject unrelated upstream private changes', async () => {
  const f = await fixture();
  const agent = f.module.get(AgentService);
  vi.spyOn(agent, 'runWrite').mockImplementationOnce(async (_job, wt) => {
    await wt.write('wiki/public.md', 'requester edit');
    await f.apply([{ op: 'put', path: 'wiki/public.md', content: 'upstream edit' }], f.admin.id);
    return { summary: 'resolve concurrent edits' };
  });
  vi.spyOn(agent, 'resolveConflicts').mockImplementationOnce(async (wt) => {
    await wt.write('wiki/public.md', 'resolved content');
    f.acl.create({ prefix: 'wiki/public.md', subjectType: 'everyone', subject: '', access: 'read' }, f.admin);
  });
  f.jobs.start();
  const denied = await f.completed(f.jobs.submit({ userId: f.editor.id, source: 'mcp', input: 'Edit' }).id);
  expect(denied.status).toBe('failed');
  expect(matter((await f.repo.readFile('wiki/public.md'))!).content).toBe('upstream edit');
  vi.spyOn(agent, 'runWrite').mockImplementationOnce(async (_job, wt) => {
    await wt.write('wiki/allowed.md', note('requester knowledge'));
    await f.apply([{ op: 'put', path: 'wiki/private/secret.md', content: 'upstream private edit' }], f.admin.id);
    return { summary: 'allowed request' };
  });
  f.jobs.start();
  const allowed = await f.completed(f.jobs.submit({ userId: f.editor.id, source: 'mcp', input: 'Save' }).id);
  expect(allowed.status).toBe('succeeded');
  expect(matter((await f.repo.readFile('wiki/allowed.md'))!).content).toBe('requester knowledge');
  expect(matter((await f.repo.readFile('wiki/private/secret.md'))!).content).toBe('upstream private edit');
});

it('fails a real model write when the ACL is revoked while its final provider response is pending', async () => {
  const f = await fixture([{ name: 'write_file', arguments: { path: 'wiki/race.md', content: 'Initially authorized model edit' } }, 'Saved the edit.']);
  const pending = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let responses = 0;
  const proxy = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.url === '/v1/responses' && ++responses === 2) {
      pending.resolve();
      await release.promise;
    }
    const upstream = await fetch(`${f.fake.url.replace(/\/v1$/, '')}${request.url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks) });
    response.writeHead(upstream.status, { 'content-type': 'application/json' });
    response.end(await upstream.text());
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => { proxy.close(error => error ? reject(error) : resolve()); proxy.closeAllConnections(); }));
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('Expected a bound provider proxy');
  f.config.openaiBaseUrl = `http://127.0.0.1:${address.port}/v1`;
  const head = await f.repo.headSha();
  f.jobs.start();
  const job = f.jobs.submit({ userId: f.editor.id, source: 'mcp', input: 'Save the authorized note' });
  try {
    await pending.promise;
    expect(await readFile(join(f.config.dataDir, 'worktrees', job.id, 'wiki/race.md'), 'utf8')).toBe('Initially authorized model edit');
    expect(await f.repo.readFile('wiki/race.md')).toBeNull();
    f.acl.create({ prefix: 'wiki/race.md', subjectType: 'everyone', subject: '', access: 'read' }, f.admin);
  } finally {
    release.resolve();
  }
  const result = await f.completed(job.id);
  expect(result).toMatchObject({ status: 'failed', error: expect.stringContaining('Write denied by current folder permissions') });
  expect(await f.repo.headSha()).toBe(head);
  expect(await f.repo.readFile('wiki/race.md')).toBeNull();
});

it('keeps imported raw storage internal but rejects integration without requester source access', async () => {
  const f = await fixture();
  await f.writer.apply({ userId: f.editor.id, source: 'import', baseSha: await f.repo.headSha(), ops: [{ op: 'put', path: 'raw/source.md', content: 'HIDDEN_IMPORT_SOURCE', create: true }] });
  const head = await f.repo.headSha();
  f.jobs.start();
  const result = await f.completed(f.jobs.submit({ userId: f.editor.id, source: 'import', input: 'Read raw/source.md and integrate.', sourcePaths: ['raw/source.md'] }).id);
  expect(result.status).toBe('failed');
  expect(await f.repo.headSha()).toBe(head);
  expect(f.fake.requests.filter(request => request.path.endsWith('/responses'))).toEqual([]);
  expect(await f.jobs.visible(f.editor, result)).toMatchObject({ input: '', summary: null, commits: [] });
});

it('rejects sources revoked during generation and fails when the requester disappears', async () => {
  const f = await fixture();
  const agent = f.module.get(AgentService);
  const head = await f.repo.headSha();
  vi.spyOn(agent, 'runWrite').mockImplementationOnce(async (_job, wt, author, user) => {
    const read = agent.worktreeTools(wt, author, user).find(tool => tool.name === 'read_file')!;
    const source = JSON.parse(await read.run({ path: 'wiki/public.md' })) as { content: string };
    await wt.write('wiki/copied.md', source.content);
    f.acl.create({ prefix: 'wiki/public.md', subjectType: 'everyone', subject: '', access: 'none' }, f.admin);
    return { summary: 'Durable public fact.' };
  });
  f.jobs.start();
  const revoked = await f.completed(f.jobs.submit({ userId: f.editor.id, source: 'chat', input: 'Copy knowledge' }).id);
  expect(revoked).toMatchObject({ status: 'failed', error: expect.stringContaining('Source access denied') });
  expect(await f.repo.headSha()).toBe(head);
  expect(await f.repo.readFile('wiki/copied.md')).toBeNull();
  expect(await f.jobs.visible(f.editor, revoked)).toMatchObject({ input: '', summary: null, commits: [] });
  vi.spyOn(agent, 'runWrite').mockImplementationOnce(async (_job, wt) => {
    await wt.write('wiki/deleted-requester.md', 'must not land');
    f.users.delete(f.editor.id);
    return { summary: 'Deleted requester' };
  });
  f.jobs.start();
  const missing = await f.completed(f.jobs.submit({ userId: f.editor.id, source: 'mcp', input: 'Save' }).id);
  expect(missing).toMatchObject({ status: 'failed', error: expect.stringContaining('no longer exists') });
  expect(await f.repo.headSha()).toBe(head);
});

it('restricts unresolved commit metadata for ordinary readers but preserves it for admins', async () => {
  const f = await fixture();
  const submitted = f.jobs.submit({ userId: f.editor.id, source: 'mcp', input: 'Unresolved commit input', sourcePaths: ['wiki/public.md'] });
  const repository = f.module.get(WriteJobsRepository);
  const missingSha = '0000000000000000000000000000000000000000';
  repository.markMerging(submitted.id, 'Unresolved commit summary', [missingSha]);
  repository.recordMerge(submitted.id, [missingSha], missingSha);
  repository.markFailed(submitted.id, 'Original failure details', new Date().toISOString());
  const job = f.jobs.get(submitted.id)!;

  const ordinary = await f.jobs.projectVisibility(f.editor, job);
  expect(ordinary.restricted).toBe(true);
  expect(ordinary.job).toMatchObject({
    input: '', summary: null, commits: [], conflicts: [], mergeSha: null,
    error: 'Job details are unavailable under current folder permissions.',
  });
  expect(ordinary.sourcePaths).toEqual(['wiki/public.md']);

  const admin = await f.jobs.projectVisibility(f.admin, job);
  expect(admin.restricted).toBe(false);
  expect(admin.job).toBe(job);
  expect(admin.sourcePaths).toEqual(['wiki/public.md']);
  expect(await f.jobs.visible(f.admin, job)).toBe(job);
});

it('rejects a stale job projection when its reader policy changes during Git inspection', async () => {
  const f = await fixture();
  const written = await f.apply([{ op: 'put', path: 'wiki/public.md', content: 'Job projection content' }]);
  const pending = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const changedPaths = f.repo.changedPaths.bind(f.repo);
  vi.spyOn(f.repo, 'changedPaths').mockImplementationOnce(async (...args) => {
    const result = await changedPaths(...args);
    pending.resolve();
    await release.promise;
    return result;
  });
  const projection = f.jobs.visible(f.editor, f.jobs.get(written.jobId)!);
  await pending.promise;
  f.acl.create({ prefix: 'wiki/public.md', subjectType: 'everyone', subject: '', access: 'none' }, f.admin);
  release.resolve();
  await expect(projection).rejects.toMatchObject({ status: 404, code: 'not_found' });
});

it('redacts merge job content when only another parent delta touches restricted paths', async () => {
  const f = await fixture();
  const left = await f.repo.createWorktree('private-merge-parent');
  const right = await f.repo.createWorktree('public-merge-parent');
  const author = { name: 'Admin', email: f.admin.email };
  try {
    await left.write('wiki/private/secret.md', 'Private branch revision');
    await left.commit('Private branch intent', author);
    await right.write('wiki/public.md', 'Public branch revision');
    await right.commit('Public branch intent', author);
    await right.fastForwardMain();
    expect((await left.mergeMain()).ok).toBe(true);
    const mergeSha = await left.fastForwardMain();
    expect((await f.repo.show(mergeSha)).files).toEqual([{ status: 'M', path: 'wiki/public.md' }]);
    const job = f.jobs.submit({ userId: f.editor.id, source: 'mcp', input: 'HIDDEN_MERGE_INPUT' });
    const repository = f.module.get(WriteJobsRepository);
    repository.markMerging(job.id, 'HIDDEN_MERGE_SUMMARY', [mergeSha]);
    repository.recordMerge(job.id, [mergeSha], mergeSha);
    repository.markSucceeded(job.id, new Date().toISOString());
    const projection = await f.jobs.visible(f.editor, f.jobs.get(job.id)!);
    expect(projection).toMatchObject({ input: '', summary: null, commits: [], conflicts: [], mergeSha: null });
    expect(await f.jobs.visible(f.admin, f.jobs.get(job.id)!)).toMatchObject({ input: 'HIDDEN_MERGE_INPUT', summary: 'HIDDEN_MERGE_SUMMARY', commits: [mergeSha] });
  } finally {
    await left.dispose();
    await right.dispose();
  }
});

it('persists and logs the unrestricted dreaming ACL warning in its public run record', async () => {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const f = await fixture([{ name: 'write_file', arguments: { path: `journal/${date}.md`, content: '# Reviewed changes\n' } }, 'Reviewed changes.']);
  const run = await f.module.get(DreamingService).runOnce();
  expect(run.status).toBe('succeeded');
  expect(run.summary).toContain('Semantic paraphrase or copying across ACL boundaries cannot be guaranteed detectable');
  expect(f.module.get(DreamRunsRepository).get(run.id)?.summary).toBe(run.summary);
  expect(f.module.get(AuditService).list({ action: 'dreaming.acl_warning', limit: 10 }).events).toEqual([expect.objectContaining({ target: run.id, actorId: null, outcome: 'warning' })]);
  expect(f.warning).toHaveBeenCalledWith({ runId: run.id }, expect.stringContaining('ACL warning'));
});
