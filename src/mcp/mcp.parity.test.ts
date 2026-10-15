import 'reflect-metadata';
import { Test, type TestingModule } from '@nestjs/testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AuditModule } from '../audit/audit.module.js';
import { AclModule } from '../acl/acl.module.js';
import { UsersService } from '../auth/users.service.js';
import type { User } from '../auth/users.types.js';
import { CommonModule } from '../common/common.module.js';
import { apiIdToLegacyUuid, parseApiId } from '../common/ids.js';
import { CONFIG, DB, LOGGER } from '../common/tokens.js';
import { loadConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { EventsModule } from '../events/events.module.js';
import { KnowledgeRepo } from '../knowledge/repo.js';
import { NOTE_TYPES } from '../knowledge/note-metadata.js';
import { IngestService } from '../ingest/ingest.service.js';
import { OpsModule } from '../ops/ops.module.js';
import { IndexerService } from '../rag/indexer.service.js';
import { McpModule } from './mcp.module.js';
import { McpService } from './mcp.service.js';

const modules: TestingModule[] = [];
const clients: Client[] = [];
const dirs: string[] = [];
const author = { name: 'Wiki Editor', email: 'editor@example.test' };
const oldContent = '---\ntitle: Engine\ntype: concept\ndescription: Durable summary for versioned memory.\naliases: ["영속 엔진", "지식"]\ntags: [platform]\n---\n# Engine\n\n## Durable Knowledge\nEngine knowledge is shared. [[wiki/neighbor]] [[missing]]\n';
const parityJobId = parseApiId('11223344-5566-4788-99aa-bbccddeeff00')!;
const missingJobId = parseApiId('11223344-5566-4788-99aa-bbccddeeff01')!;

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-parity-'));
  dirs.push(dir);
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: dir, EMBEDDING_DIMENSIONS: '2' });
  const module = await Test.createTestingModule({ imports: [CommonModule, EventsModule, AuditModule, AclModule, OpsModule, McpModule] })
    .overrideProvider(CONFIG).useValue(config)
    .overrideProvider(LOGGER).useValue(pino({ level: 'silent' }))
    .compile();
  modules.push(module);
  await module.init();
  const users = module.get(UsersService);
  const editor = await users.create({ ...author, role: 'editor' });
  const viewer = await users.create({ email: 'viewer@example.test', role: 'viewer' });
  const admin = await users.create({ email: 'admin@example.test', role: 'admin' });
  const repo = module.get(KnowledgeRepo);
  const seed = await repo.createWorktree('seed-parity');
  await seed.write('index.md', '# Index\n\n[[wiki/engine]]\n');
  await seed.write('wiki/old.md', oldContent);
  await seed.write('wiki/neighbor.md', '# Neighbor\n\nEngine knowledge neighbor. [[wiki/engine]]\n');
  await seed.write('journal/other.md', '# Other\n\nEngine knowledge outside the platform folder.\n');
  await seed.write('wiki/100% literal #한글.md', '# Literal path\n');
  const initial = (await seed.commit('Add engine knowledge', author))!;
  await seed.fastForwardMain();
  await seed.dispose();
  const rename = await repo.createWorktree('rename-parity');
  await rename.move('wiki/old.md', 'wiki/engine.md');
  const renamed = (await rename.commit('Rename engine note', author))!;
  await rename.fastForwardMain();
  await rename.dispose();
  const edit = await repo.createWorktree('edit-parity');
  await edit.write('wiki/engine.md', oldContent.replace('is shared.', 'is shared and versioned.'));
  edit.setCommitMetadata({ jobId: parityJobId, source: 'mcp', requester: author.email });
  const latest = (await edit.commit('Explain versioning', author))!;
  await edit.fastForwardMain();
  await edit.dispose();
  const indexer = module.get(IndexerService);
  await indexer.syncToHead();
  async function connect(user: User = viewer, clientName?: string) {
    const server = await module.get(McpService).createServer(user, clientName);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'parity-client', version: '1.0.0' });
    clients.push(client);
    await client.connect(clientTransport);
    return client;
  }
  return { module, repo, initial, renamed, latest, connect, editor, viewer, admin, indexer, config };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  await Promise.all(modules.splice(0).map(module => module.close()));
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
}

describe('MCP knowledge parity', () => {
  it('discovers and reads resources for real encoded note paths and validates prompt arguments', async () => {
    const { connect, repo, latest } = await fixture();
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual([
      'blame', 'browse', 'compare', 'get_commit', 'get_write_status', 'ingest_source', 'list_notes',
      'note_history', 'note_links', 'read_note', 'search', 'similar_notes', 'write',
    ]);
    expect(tools.find(tool => tool.name === 'browse')?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    const { resources } = await client.listResources();
    expect(resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ uri: 'llmwiki://index', mimeType: 'application/json' }),
    ]));
    const literal = resources.find(resource => resource.name === 'wiki/100% literal #한글.md')!;
    expect(literal.uri).toBe('llmwiki://notes/wiki/100%25%20literal%20%23%ED%95%9C%EA%B8%80.md');
    const committedLiteral = await repo.readFile('wiki/100% literal #한글.md', latest);
    expect(committedLiteral).toContain('# Literal path\n');
    expect((await client.readResource({ uri: literal.uri })).contents).toEqual([
      { uri: literal.uri, mimeType: 'text/markdown', text: committedLiteral },
    ]);
    expect((await client.readResource({ uri: 'llmwiki://notes/index.md' })).contents[0]).toMatchObject({ text: '# Index\n\n[[wiki/engine]]\n' });
    const tree = await client.readResource({ uri: 'llmwiki://index' });
    const treeContent = tree.contents[0]!;
    if (!('text' in treeContent)) throw new Error('Expected text tree resource.');
    expect(JSON.parse(treeContent.text)).toMatchObject({ notes: expect.arrayContaining([
      { path: 'wiki/engine.md', title: 'Engine', description: 'Durable summary for versioned memory.', type: 'concept' },
    ]) });
    expect(JSON.parse(treeContent.text)).not.toHaveProperty('files');
    const browsed = await call(client, 'browse', { folder: 'wiki/' });
    expect(browsed.structuredContent).toMatchObject({ folder: 'wiki/', listing: expect.any(String) });
    expect(browsed.structuredContent?.listing).toContain('wiki/engine.md');
    expect(browsed.structuredContent?.listing).toContain('Durable summary for versioned memory.');
    expect(browsed.structuredContent?.listing).not.toContain('journal/other.md');
    expect((await call(client, 'browse')).isError).toBe(true);
    expect((await call(client, 'browse', { folder: 42 })).isError).toBe(true);
    expect((await client.listResourceTemplates()).resourceTemplates).toEqual([
      expect.objectContaining({ uriTemplate: 'llmwiki://notes/{+path}' }),
    ]);
    const { prompts } = await client.listPrompts();
    expect(prompts.map(prompt => prompt.name).sort()).toEqual(['capture_knowledge', 'research_topic', 'review_note_history']);
    await expect(client.getPrompt({ name: 'research_topic', arguments: {} })).rejects.toThrow();
    await expect(client.getPrompt({ name: 'capture_knowledge', arguments: {} })).rejects.toThrow();
    await expect(client.getPrompt({ name: 'review_note_history', arguments: {} })).rejects.toThrow();
    await expect(client.readResource({ uri: 'llmwiki://notes/wiki/missing.md' })).rejects.toThrow(/not found/i);
    await expect(client.readResource({ uri: 'llmwiki://notes/%2E%2E/secret.md' })).rejects.toThrow();
  });

  it('advertises and validates every metadata type and passes it to the shared search index', async () => {
    const { connect } = await fixture();
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.find(tool => tool.name === 'search')?.inputSchema.properties?.type)
      .toMatchObject({ enum: [...NOTE_TYPES] });
    for (const type of NOTE_TYPES) {
      const result = await call(client, 'search', { query: '영속 엔진', type });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent?.hits).toEqual(type === 'concept' ? [
        expect.objectContaining({ path: 'wiki/engine.md', type: 'concept',
          description: 'Durable summary for versioned memory.' }),
      ] : []);
    }
    for (const type of ['unknown', 'wiki', '', 'Concept', 'concept,entity', null, ['concept']]) {
      const result = await call(client, 'search', { query: 'Engine knowledge', type });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
    }
  });

  it('retrieves metadata-only translated aliases, short aliases and summaries over MCP', async () => {
    const { connect } = await fixture();
    const client = await connect();
    for (const query of ['영속 엔진', '지식', 'durable summary']) {
      const result = await call(client, 'search', { query, type: 'concept' });
      expect(result.structuredContent?.hits).toEqual([
        expect.objectContaining({ path: 'wiki/engine.md', type: 'concept',
          description: 'Durable summary for versioned memory.' }),
      ]);
    }
    const legacy = await call(client, 'search', { query: 'Engine knowledge', kinds: ['journal'] });
    expect(legacy.structuredContent?.hits).toEqual([
      expect.objectContaining({ path: 'journal/other.md', type: null, description: null }),
    ]);
  });

  it('follows renames, pins historical reads, compares revisions, and attributes blame', async () => {
    const { connect, repo, initial, renamed, latest } = await fixture();
    const client = await connect();
    const history = await call(client, 'note_history', { path: 'wiki/engine.md' });
    expect(z.array(z.object({ sha: z.string() })).parse(history.structuredContent?.commits).map(commit => commit.sha)).toEqual([latest, renamed, initial]);
    const unfollowed = await call(client, 'note_history', { path: 'wiki/engine.md', follow: false });
    expect(z.array(z.object({ sha: z.string() })).parse(unfollowed.structuredContent?.commits).map(commit => commit.sha)).toEqual([latest, renamed]);
    const page = await call(client, 'note_history', { path: 'wiki/engine.md', before: latest, limit: 1 });
    expect(z.array(z.object({ sha: z.string() })).parse(page.structuredContent?.commits).map(commit => commit.sha)).toEqual([renamed]);
    const old = await call(client, 'read_note', { path: 'wiki/old.md', ref: initial });
    expect(old.structuredContent).toMatchObject({ content: await repo.readFile('wiki/old.md', initial),
      frontmatter: { title: 'Engine', tags: ['platform'] }, ref: initial, updatedSha: initial });
    expect(old.structuredContent?.content).toContain('Engine knowledge is shared. [[wiki/neighbor]] [[missing]]');
    const compare = await call(client, 'compare', { base: renamed, head: latest, path: 'wiki/engine.md' });
    expect(compare.structuredContent).toMatchObject({ base: renamed, head: latest, truncated: false, files: [{ status: 'M', path: 'wiki/engine.md' }] });
    expect(compare.structuredContent?.patch).toContain('+Engine knowledge is shared and versioned.');
    const blame = await call(client, 'blame', { path: 'wiki/engine.md', ref: latest });
    expect(blame.structuredContent).toMatchObject({ ref: latest, ranges: expect.arrayContaining([
      expect.objectContaining({ sha: latest, authorName: author.name, jobId: parityJobId, source: 'mcp' }),
    ]) });
    expect((await call(client, 'read_note', { path: 'wiki/engine.md', ref: initial })).isError).toBe(true);
    expect((await call(client, 'get_commit', { sha: 'not-a-ref' })).isError).toBe(true);
    expect((await call(client, 'blame', { path: '../secret.md' })).isError).toBe(true);
  });

  it('selects a merge parent and bounds large patches without hiding file metadata', async () => {
    const { connect, repo } = await fixture();
    const left = await repo.createWorktree('left-parity');
    const right = await repo.createWorktree('right-parity');
    await left.write('wiki/left.md', '# Left\n');
    const leftSha = (await left.commit('Left change', author))!;
    await right.write('wiki/right.md', '# Right\n');
    const rightSha = (await right.commit('Right change', author))!;
    await left.fastForwardMain();
    await right.mergeMain();
    const mergeSha = await right.fastForwardMain();
    await left.dispose();
    await right.dispose();
    const client = await connect();
    const parent1 = await call(client, 'get_commit', { sha: mergeSha, parent: 1 });
    const parent2 = await call(client, 'get_commit', { sha: mergeSha, parent: 2 });
    expect(parent1.structuredContent).toMatchObject({ commit: { parents: [rightSha, leftSha] }, files: [{ status: 'A', path: 'wiki/left.md' }], truncated: false });
    expect(parent2.structuredContent).toMatchObject({ files: [{ status: 'A', path: 'wiki/right.md' }] });
    expect((await call(client, 'get_commit', { sha: mergeSha, parent: 3 })).isError).toBe(true);
    const big = await repo.createWorktree('big-parity');
    await big.write('wiki/large.md', '# Large\n' + 'A durable line of knowledge.\n'.repeat(2_000));
    const bigSha = (await big.commit('Large source', author))!;
    await big.fastForwardMain();
    await big.dispose();
    for (const output of [
      await call(client, 'get_commit', { sha: bigSha }),
      await call(client, 'compare', { base: mergeSha, head: bigSha }),
    ]) {
      expect(output.structuredContent).toMatchObject({ truncated: true, files: [{ status: 'A', path: 'wiki/large.md' }] });
      expect(z.string().parse(output.structuredContent?.patch).length).toBe(32_000);
    }
  });

  it('returns filtered anchored search, link context, and semantic neighbors from the shared index', async () => {
    const { connect, module, config, repo, latest } = await fixture();
    const db = module.get<Db>(DB);
    const chunks = db.prepare('SELECT id, path, content_hash FROM chunks WHERE path IN (?,?) AND ordinal = 0')
      .all('wiki/engine.md', 'wiki/neighbor.md') as Array<{ id: number; path: string; content_hash: string }>;
    for (const chunk of chunks) {
      const vector = Buffer.from(new Float32Array(chunk.path === 'wiki/engine.md' ? [1, 0] : [0.9, 0.1]).buffer);
      db.prepare('INSERT OR REPLACE INTO embedding_cache(content_hash,model,dimensions,embedding) VALUES (?,?,?,?)').run(chunk.content_hash, config.embeddingModel, 2, vector);
      db.prepare('INSERT OR REPLACE INTO chunk_vectors(chunk_id,embedding) VALUES (?,?)').run(BigInt(chunk.id), vector);
      db.prepare('UPDATE chunks SET vector_pending=0 WHERE id=?').run(chunk.id);
    }
    const client = await connect();
    const { commit } = await repo.show(latest);
    const day = commit.date.slice(0, 10);
    const search = await call(client, 'search', {
      query: 'Engine knowledge', type: 'concept', folder: 'wiki/', tags: ['platform'], from: day, to: day, author: author.email, kinds: ['wiki'],
    });
    expect(search.structuredContent?.hits).toEqual([
      expect.objectContaining({ path: 'wiki/engine.md', type: 'concept', description: 'Durable summary for versioned memory.',
        anchor: 'durable-knowledge', tags: ['platform'], excerpt: expect.stringContaining('Engine knowledge') }),
    ]);
    expect((await call(client, 'search', { query: 'Engine knowledge', tags: ['unmatched'] })).structuredContent).toEqual({ hits: [] });
    expect((await call(client, 'search', { query: 'Engine knowledge', author: 'unknown-author' })).structuredContent).toEqual({ hits: [] });
    expect((await call(client, 'search', { query: 'Engine knowledge', to: '2000-01-01' })).structuredContent).toEqual({ hits: [] });
    expect((await call(client, 'search', { query: 'Engine knowledge', from: 'invalid-date' })).isError).toBe(true);
    expect((await call(client, 'note_links', { path: 'wiki/engine.md' })).structuredContent).toEqual({
      outgoing: [{ path: 'wiki/neighbor.md', title: 'Neighbor' }],
      backlinks: [{ path: 'index.md', title: 'Index' }, { path: 'wiki/neighbor.md', title: 'Neighbor' }], unresolved: ['missing'],
    });
    expect((await call(client, 'similar_notes', { path: 'wiki/engine.md', limit: 1 })).structuredContent).toEqual({
      notes: [expect.objectContaining({ path: 'wiki/neighbor.md', title: 'Neighbor', score: expect.any(Number) })],
    });
    expect((await call(client, 'note_links', { path: 'wiki/missing.md' })).isError).toBe(true);
    expect((await call(client, 'similar_notes', { path: 'wiki/missing.md' })).isError).toBe(true);
  });

  it('enforces write/import permissions and job privacy while retaining authenticated client provenance', async () => {
    const { connect, editor, viewer, admin, module } = await fixture();
    const editorClient = await connect(editor, 'Trusted OAuth Client');
    const viewerClient = await connect(viewer);
    const adminClient = await connect(admin);
    expect((await call(viewerClient, 'write', { content: 'Viewer request' })).isError).toBe(true);
    expect((await call(viewerClient, 'ingest_source', { kind: 'text', text: 'Viewer source' })).isError).toBe(true);
    const written = await call(editorClient, 'write', { content: 'Record durable engine behavior.' });
    const jobId = z.string().parse(written.structuredContent?.jobId);
    const ownStatus = await call(editorClient, 'get_write_status', { jobId });
    expect(ownStatus.structuredContent).toMatchObject({
      job: { id: jobId, userId: editor.id, source: 'mcp', client: 'Trusted OAuth Client', status: 'queued' },
    });
    const legacyJobId = apiIdToLegacyUuid(jobId)!;
    const legacyStatus = await call(editorClient, 'get_write_status', { jobId: legacyJobId });
    expect(legacyStatus.isError).not.toBe(true);
    expect(legacyStatus.structuredContent).toEqual(ownStatus.structuredContent);
    const hidden = await call(viewerClient, 'get_write_status', { jobId });
    const missing = await call(viewerClient, 'get_write_status', { jobId: missingJobId });
    expect(hidden.isError).toBe(true);
    expect(hidden.content).toEqual(missing.content);
    const hiddenLegacy = await call(viewerClient, 'get_write_status', { jobId: legacyJobId });
    expect(hiddenLegacy.isError).toBe(true);
    expect(hiddenLegacy.content).toEqual(missing.content);
    expect((await call(adminClient, 'get_write_status', { jobId })).structuredContent).toMatchObject({ job: { id: jobId } });
    const imported = await call(editorClient, 'ingest_source', { kind: 'text', text: 'Imported source knowledge.', filename: 'source.txt' });
    expect(imported.isError).not.toBe(true);
    const importJobIds = z.array(z.string()).length(1).parse(imported.structuredContent?.jobIds);
    for (const jobId of importJobIds) {
      expect((await call(editorClient, 'get_write_status', { jobId })).structuredContent).toMatchObject({
        job: { userId: editor.id, source: 'import', status: 'queued', input: expect.stringContaining('raw/') },
      });
    }
    const importId = z.string().parse(imported.structuredContent?.importId);
    const source = module.get(IngestService).get(importId, editor.id);
    const original = source.rawPaths.find(path => path.endsWith('/original/source.txt'))!;
    expect((await call(editorClient, 'read_note', { path: original })).structuredContent).toMatchObject({ content: 'Imported source knowledge.' });
    expect((await call(editorClient, 'ingest_source', { kind: 'text' })).isError).toBe(true);
    expect((await call(editorClient, 'ingest_source', { kind: 'text', text: '   ' })).isError).toBe(true);
  });
});
