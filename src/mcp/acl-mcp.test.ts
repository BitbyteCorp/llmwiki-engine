import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, expect, it } from 'vitest';
import { AclModule } from '../acl/acl.module.js';
import { AclService } from '../acl/acl.service.js';
import { UsersService } from '../auth/users.service.js';
import type { User } from '../auth/users.types.js';
import { CommonModule } from '../common/common.module.js';
import { CONFIG, LOGGER } from '../common/tokens.js';
import { loadConfig } from '../config.js';
import { EventsModule } from '../events/events.module.js';
import { KnowledgeRepo } from '../knowledge/repo.js';
import { NoteWriterService } from '../jobs/note-writer.service.js';
import { WriteJobsService } from '../jobs/write-jobs.service.js';
import { OpsModule } from '../ops/ops.module.js';
import { McpModule } from './mcp.module.js';
import { McpService } from './mcp.service.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
async function fixture() {
  // The shared test fixture is outside the production TypeScript root; static imports fail rootDir validation.
  const { startFakeOpenAI }: { startFakeOpenAI(): Promise<{ url: string; close(): Promise<void> }> } = await import(new URL('../../test/fake-openai.ts', import.meta.url).href);
  const dir = await mkdtemp(join(tmpdir(), 'acl-mcp-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const fake = await startFakeOpenAI();
  cleanup.push(() => fake.close());
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: dir, OPENAI_API_KEY: 'test', OPENAI_BASE_URL: fake.url, EMBEDDING_DIMENSIONS: '2' });
  const module = await Test.createTestingModule({ imports: [CommonModule, EventsModule, AclModule, McpModule, OpsModule] })
    .overrideProvider(CONFIG).useValue(config).overrideProvider(LOGGER).useValue(pino({ level: 'silent' })).compile();
  cleanup.push(() => module.close());
  await module.init();
  const users = module.get(UsersService);
  const admin = users.create({ email: 'admin@mcp-acl.test', role: 'admin' });
  const viewer = users.create({ email: 'viewer@mcp-acl.test', role: 'viewer' });
  const editor = users.create({ email: 'editor@mcp-acl.test', role: 'editor' });
  const acl = module.get(AclService);
  acl.create({ prefix: 'wiki/private/', subjectType: 'everyone', subject: '', access: 'none' }, admin);
  acl.create({ prefix: 'index.md', subjectType: 'everyone', subject: '', access: 'none' }, admin);
  acl.create({ prefix: 'raw/', subjectType: 'everyone', subject: '', access: 'none' }, admin);
  const repo = module.get(KnowledgeRepo);
  const writer = module.get(NoteWriterService);
  const base = await repo.headSha();
  const mixed = await writer.apply({ userId: admin.id, source: 'web', baseSha: base, message: 'SECRET_COMMIT_MESSAGE', ops: [
    { op: 'put', path: 'index.md', content: '# HIDDEN_INDEX\n' },
    { op: 'put', path: 'wiki/public.md', content: '# Public\nDurable public fact.\n' },
    { op: 'put', path: 'wiki/neighbor.md', content: '# Neighbor\nDurable public related fact. [[wiki/public]]\n' },
    { op: 'put', path: 'wiki/private/secret.md', content: '# Private\nHIDDEN_PAYLOAD. Durable hidden fact. [[wiki/public]]\n' },
  ] });
  async function connect(user: User) {
    const server = module.get(McpService).createServer(user);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'acl-consumer', version: '1.0.0' });
    await client.connect(clientTransport);
    cleanup.push(() => client.close());
    return client;
  }
  return { module, admin, viewer, editor, acl, repo, writer, base, mixed, connect };
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
}

it('protects all read tools, resources and path prompts and redacts mixed Git metadata and patches', async () => {
  const f = await fixture();
  const client = await f.connect(f.viewer);
  const admin = await f.connect(f.admin);
  for (const name of ['read_note', 'note_history', 'blame', 'note_links', 'similar_notes']) {
    const denied = await call(client, name, { path: 'wiki/private/secret.md' });
    expect(denied.isError, name).toBe(true);
    expect(JSON.stringify(denied)).not.toContain('HIDDEN_PAYLOAD');
    const allowed = await call(admin, name, { path: 'wiki/private/secret.md' });
    expect(allowed.isError, name).not.toBe(true);
  }
  const listed = await call(client, 'list_notes');
  expect(listed.structuredContent).toMatchObject({ index: null });
  expect(listed.structuredContent?.files).toContain('wiki/public.md');
  expect(JSON.stringify(listed)).not.toContain('wiki/private/secret.md');
  const search = await call(client, 'search', { query: 'Durable', limit: 1 });
  expect((search.structuredContent?.hits as Array<{ path: string }>).map(hit => hit.path)).toHaveLength(1);
  expect(JSON.stringify(search)).not.toContain('wiki/private/secret.md');
  expect(JSON.stringify(await call(client, 'search', { query: 'HIDDEN_PAYLOAD' }))).not.toContain('HIDDEN_PAYLOAD');
  expect(JSON.stringify(await call(client, 'similar_notes', { path: 'wiki/public.md' }))).not.toContain('wiki/private/secret.md');
  expect(JSON.stringify(await call(client, 'note_links', { path: 'wiki/public.md' }))).not.toContain('wiki/private/secret.md');
  for (const response of [
    await call(client, 'get_commit', { sha: f.mixed.mergeSha }),
    await call(client, 'compare', { base: f.base, head: f.mixed.mergeSha }),
    await call(client, 'note_history', { path: 'wiki/public.md' }),
    await call(client, 'blame', { path: 'wiki/public.md' }),
  ]) {
    expect(JSON.stringify(response)).not.toContain('wiki/private/secret.md');
    expect(JSON.stringify(response)).not.toContain('HIDDEN_PAYLOAD');
    expect(JSON.stringify(response)).not.toContain('SECRET_COMMIT_MESSAGE');
  }
  expect((await call(client, 'get_commit', { sha: f.mixed.mergeSha })).structuredContent?.patch).toContain('Durable public fact');
  expect(JSON.stringify(await call(admin, 'get_commit', { sha: f.mixed.mergeSha }))).toContain('HIDDEN_PAYLOAD');
  const resources = await client.listResources();
  expect(resources.resources.some(resource => resource.name === 'wiki/public.md')).toBe(true);
  expect(JSON.stringify(resources)).not.toContain('wiki/private/secret.md');
  const tree = await client.readResource({ uri: 'llmwiki://index' });
  expect(JSON.stringify(tree)).not.toContain('wiki/private/secret.md');
  await expect(client.readResource({ uri: 'llmwiki://notes/wiki/private/secret.md' })).rejects.toThrow();
  expect((await admin.readResource({ uri: 'llmwiki://notes/wiki/private/secret.md' })).contents[0]).toMatchObject({ text: expect.stringContaining('HIDDEN_PAYLOAD') });
  await expect(client.getPrompt({ name: 'review_note_history', arguments: { path: 'wiki/private/secret.md' } })).rejects.toThrow();
  expect((await client.getPrompt({ name: 'review_note_history', arguments: { path: 'wiki/public.md' } })).messages[0]?.content).toMatchObject({ text: expect.stringContaining('wiki/public.md') });
  expect((await client.getPrompt({ name: 'research_topic', arguments: { topic: 'Durable public fact' } })).messages[0]?.content).toMatchObject({ text: expect.stringContaining('Durable public fact') });
  expect((await client.getPrompt({ name: 'capture_knowledge', arguments: { content: 'Public knowledge' } })).messages[0]?.content).toMatchObject({ text: expect.stringContaining('Public knowledge') });
});

it('uses token user for write/ingest and hides job sources, commits, conflicts and content after ACL changes', async () => {
  const f = await fixture();
  const viewer = await f.connect(f.viewer);
  const editor = await f.connect(f.editor);
  expect((await call(viewer, 'write', { content: 'Save knowledge' })).isError).toBe(true);
  expect((await call(viewer, 'ingest_source', { kind: 'text', text: 'Source knowledge' })).isError).toBe(true);
  const queued = await call(editor, 'write', { content: 'Allowed task' });
  expect(queued.structuredContent).toMatchObject({ status: 'queued' });
  const queuedId = queued.structuredContent?.jobId as string;
  expect((await call(editor, 'get_write_status', { jobId: queuedId })).structuredContent?.job).toMatchObject({ userId: f.editor.id, input: 'Allowed task' });
  expect((await call(viewer, 'get_write_status', { jobId: queuedId })).isError).toBe(true);
  const grant = f.acl.create({ prefix: 'wiki/private/', subjectType: 'user', subject: String(f.editor.id), access: 'write' }, f.admin);
  const written = await f.writer.apply({ userId: f.editor.id, source: 'web', baseSha: await f.repo.headSha(), message: 'HIDDEN_JOB_SUMMARY', ops: [{ op: 'put', path: 'wiki/private/secret.md', content: 'HIDDEN_JOB_CONTENT' }] });
  f.module.get(WriteJobsService).phase(written.jobId, 'resolving_conflict', { sourcePath: 'wiki/private/secret.md', files: ['wiki/private/secret.md'] });
  f.acl.delete(grant.id, f.admin);
  const status = await call(editor, 'get_write_status', { jobId: written.jobId });
  expect(status.structuredContent?.job).toMatchObject({ input: '', summary: null, commits: [], conflicts: [], mergeSha: null });
  expect(JSON.stringify(status)).not.toContain('wiki/private/secret.md');
  expect(JSON.stringify(status)).not.toContain('HIDDEN_JOB_CONTENT');
  const imported = await call(editor, 'ingest_source', { kind: 'text', text: 'Restricted raw imported source', filename: 'source.md' });
  expect(imported.isError).not.toBe(true);
  const importId = imported.structuredContent?.jobId as string;
  const importStatus = await call(editor, 'get_write_status', { jobId: importId });
  expect(importStatus.structuredContent?.job).toMatchObject({ userId: f.editor.id, input: '', commits: [], summary: null });
  expect(JSON.stringify(importStatus)).not.toContain('raw/');
});
