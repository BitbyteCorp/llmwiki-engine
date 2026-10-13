import { type CanActivate, type ExecutionContext, type INestApplication, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpAuthGuard } from '../auth/guards/mcp-auth.guard.js';
import type { Role, User } from '../auth/users.types.js';
import { configureApp } from '../common/http/configure-app.js';
import { parseApiId } from '../common/ids.js';
import { LOGGER } from '../common/tokens.js';
import type { WriteJob } from '../jobs/write-job.types.js';
import { WriteJobsService } from '../jobs/write-jobs.service.js';
import { KnowledgeRepo } from '../knowledge/repo.js';
import { SearchService } from '../rag/search.service.js';
import { McpController } from './mcp.controller.js';
import { CatalogService } from '../rag/catalog.service.js';
import { ComparisonService } from '../rag/comparison.service.js';
import { IngestService } from '../ingest/ingest.service.js';
import { McpService } from './mcp.service.js';
import { AclService } from '../acl/acl.service.js';
import { AuditService } from '../audit/audit.service.js';
import { UsersService } from '../auth/users.service.js';
import { UsersRepository } from '../auth/users.repository.js';
import { openDb, runMigrations, type Db } from '../db/index.js';

const mcpAuthGuard: CanActivate = {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request & { user: User }>();
    const identity = /^Bearer (admin|editor|viewer):([1-9]\d*)$/.exec(req.get('authorization') ?? '');
    if (!identity) {
      throw new UnauthorizedException({ error: 'Bearer authentication required' });
    }
    const id = Number(identity[2]);
    req.user = {
      id, role: identity[1] as Role, email: `user-${id}@example.test`, name: `User ${id}`,
      createdAt: '2026-01-01T00:00:00.000Z', lastLoginAt: null, hasPassword: false,
    };
    return true;
  },
};

const clients: Client[] = [];
const transports: StreamableHTTPClientTransport[] = [];
const apps: INestApplication[] = [];
const databases: Db[] = [];
const firstWriteId = parseApiId('00000000-0000-4000-8000-000000000001')!;
const secondWriteId = parseApiId('00000000-0000-4000-8000-000000000002')!;
const otherJobId = parseApiId('00000000-0000-4000-8000-000000000010')!;
const missingJobId = parseApiId('00000000-0000-4000-8000-000000000011')!;

function makeJob(id: string, userId: number, input: string): WriteJob {
  return {
    id, userId, kind: 'agent', source: 'mcp', client: null, conflicts: [], input, status: 'queued', summary: null, commits: [],
    mergeSha: null, error: null, createdAt: '2026-01-02T03:04:05.000Z',
    startedAt: null, finishedAt: null,
  };
}

async function fixture() {
  const db = openDb(':memory:');
  runMigrations(db);
  databases.push(db);
  const acl = new AclService(db, new UsersService(new UsersRepository(db)), new AuditService(db));
  const notes = new Map([
    ['index.md', '# Knowledge index\n\n- [[wiki/engine]]\n- [[wiki/backups]]\n'],
    ['wiki/engine.md', '# Engine\n\nThe engine keeps durable shared knowledge.\n'],
    ['wiki/backups.md', '# Backups\n\nThe main branch is backed up daily.\n'],
    ['journal/2026-01-01.md', '# Journal\n\nInitial knowledge import.\n'],
  ]);
  const storedJobs = new Map<string, WriteJob>([
    [otherJobId, {
      ...makeJob(otherJobId, 22, 'Record the backup schedule.'),
      status: 'succeeded', summary: 'Documented daily backups.', commits: ['commit-a'],
      mergeSha: 'merge-a', startedAt: '2026-01-02T03:04:06.000Z', finishedAt: '2026-01-02T03:04:07.000Z',
    }],
  ]);
  const repo = {
    headSha: vi.fn(async () => 'main-sha'),
    readFile: vi.fn(async (path: string) => notes.get(path) ?? null),
    listFiles: vi.fn(async (prefix?: string) => [...notes.keys()].filter((path) => path.startsWith(prefix ?? ''))),
  };
  const search = {
    search: vi.fn(async (query: string, options?: { limit?: number }) => {
      const hits = [
        {
          path: 'wiki/engine.md', title: 'Engine', heading: 'Shared knowledge',
          snippet: 'The engine keeps durable shared knowledge.', score: 0.9,
          kind: 'wiki' as const, related: ['wiki/backups.md'],
          type: 'guide', description: 'Shared engine knowledge.',
        },
        {
          path: 'wiki/backups.md', title: 'Backups', heading: 'Schedule',
          snippet: 'The main branch is backed up daily.', score: 0.6,
          kind: 'wiki' as const, related: ['wiki/engine.md'],
          type: null, description: null,
        },
      ];
      return query === 'engine' ? hits.slice(0, options?.limit ?? hits.length) : [];
    }),
  };
  const jobs = {
    submit: vi.fn(({ userId, input }: { userId: number; input: string }) => {
      const id = parseApiId(`00000000-0000-4000-8000-${storedJobs.size.toString(16).padStart(12, '0')}`)!;
      const job = makeJob(id, userId, input);
      storedJobs.set(job.id, job);
      return job;
    }),
    get: vi.fn((id: string) => storedJobs.get(id) ?? null),
    visible: async (_user: User, job: WriteJob) => job,
  };
  const module = await Test.createTestingModule({
    controllers: [McpController],
    providers: [
      McpService,
      { provide: AclService, useValue: acl },
      { provide: KnowledgeRepo, useValue: repo },
      { provide: SearchService, useValue: search },
      { provide: WriteJobsService, useValue: jobs },
      { provide: CatalogService, useValue: {} },
      { provide: ComparisonService, useValue: {} },
      { provide: IngestService, useValue: {} },
      { provide: LOGGER, useValue: { error: vi.fn() } },
    ],
  })
    .overrideGuard(McpAuthGuard)
    .useValue(mcpAuthGuard)
    .compile();
  const app = module.createNestApplication({ logger: false });
  apps.push(app);
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const url = new URL('/mcp', await app.getUrl());

  async function connect(role: Role = 'viewer', userId = 11) {
    const client = new Client({ name: 'mcp-protocol-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${role}:${userId}` } },
    });
    clients.push(client);
    transports.push(transport);
    await client.connect(transport);
    return { client, transport };
  }

  return { url, connect, repo, search, jobs, notes };
}

afterEach(async () => {
  try {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  } finally {
    try {
      await Promise.all(transports.splice(0).map((transport) => transport.close()));
    } finally {
      await Promise.all(apps.splice(0).map((app) => app.close()));
      for (const db of databases.splice(0)) db.close();
    }
  }
});

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
}

function text(result: CallToolResult): string {
  return result.content.filter((entry) => entry.type === 'text').map((entry) => entry.text).join('\n');
}

function expectPayload(result: CallToolResult, expected: Record<string, unknown>) {
  expect(result.isError).not.toBe(true);
  expect(JSON.parse(text(result))).toEqual(expected);
  expect(result.structuredContent).toEqual(expected);
}

function expectToolError(result: CallToolResult) {
  expect(result.isError).toBe(true);
  expect(text(result)).toMatch(/\S/);
}

describe('MCP Streamable HTTP protocol', () => {

  it('returns ranked search content and related notes, respecting an explicit limit', async () => {
    const { connect, search } = await fixture();
    const { client } = await connect();
    expectPayload(await call(client, 'search', { query: 'engine', limit: 1, type: 'guide' }), {
      hits: [{
        path: 'wiki/engine.md', title: 'Engine', heading: 'Shared knowledge',
        snippet: 'The engine keeps durable shared knowledge.', score: 0.9,
        kind: 'wiki', related: ['wiki/backups.md'],
        type: 'guide', description: 'Shared engine knowledge.',
      }],
    });
    expect(search.search).toHaveBeenCalledWith('engine', expect.objectContaining({ limit: 1, type: 'guide' }));
    expectPayload(await call(client, 'search', { query: 'no matching knowledge' }), { hits: [] });
  });

  it.each([0, 101, 1.5])('rejects invalid search limit %s before accessing search storage', async (limit) => {
    const { connect, search } = await fixture();
    const { client } = await connect();
    expectToolError(await call(client, 'search', { query: 'engine', limit }));
    expect(search.search).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'wiki', '', ['guide']])('rejects invalid search type %j before accessing search storage', async (type) => {
    const { connect, search } = await fixture();
    const { client } = await connect();
    expectToolError(await call(client, 'search', { query: 'engine', type }));
    expect(search.search).not.toHaveBeenCalled();
  });

  it.each(['', ' \n\t '])('rejects blank editor write content %j without enqueuing', async (content) => {
    const { connect, jobs } = await fixture();
    const { client } = await connect('editor', 11);
    expectToolError(await call(client, 'write', { content }));
    expect(jobs.submit).not.toHaveBeenCalled();
  });

  it('reads the full note with its repository-relative path', async () => {
    const { connect } = await fixture();
    const { client } = await connect();
    expectPayload(await call(client, 'read_note', { path: 'wiki/engine.md' }), {
      path: 'wiki/engine.md', content: '# Engine\n\nThe engine keeps durable shared knowledge.\n',
      frontmatter: {}, body: '# Engine\n\nThe engine keeps durable shared knowledge.\n', updatedSha: 'main-sha', ref: 'main-sha',
    });
  });

  it.each([undefined, ''])('lists all notes and includes the entry index for prefix %s', async (prefix) => {
    const { connect } = await fixture();
    const { client } = await connect();
    expectPayload(await call(client, 'list_notes', prefix === undefined ? {} : { prefix }), {
      files: ['index.md', 'wiki/engine.md', 'wiki/backups.md', 'journal/2026-01-01.md'],
      index: '# Knowledge index\n\n- [[wiki/engine]]\n- [[wiki/backups]]\n',
    });
  });

  it('lists only the requested prefix without adding an index payload', async () => {
    const { connect } = await fixture();
    const { client } = await connect();
    expectPayload(await call(client, 'list_notes', { prefix: 'wiki/' }), {
      files: ['wiki/engine.md', 'wiki/backups.md'],
    });
  });

  it('returns a null entry index when index.md does not exist', async () => {
    const { connect, notes } = await fixture();
    notes.delete('index.md');
    const { client } = await connect();
    expectPayload(await call(client, 'list_notes'), {
      files: ['wiki/engine.md', 'wiki/backups.md', 'journal/2026-01-01.md'], index: null,
    });
  });

  it('denies viewer writes without enqueuing a job', async () => {
    const { connect, jobs } = await fixture();
    const { client } = await connect('viewer', 11);
    expectToolError(await call(client, 'write', { content: 'Keep the backup policy.' }));
    expect(jobs.submit).not.toHaveBeenCalled();
  });

  it('enqueues an editor write and exposes the complete job to its owner', async () => {
    const { connect } = await fixture();
    const { client } = await connect('editor', 11);
    expectPayload(await call(client, 'write', { content: 'Record that backups run daily.' }), {
      jobId: firstWriteId, status: 'queued',
    });
    expectPayload(await call(client, 'get_write_status', { jobId: firstWriteId }), {
      job: {
        id: firstWriteId, userId: 11, kind: 'agent', source: 'mcp', client: null, conflicts: [], input: 'Record that backups run daily.',
        status: 'queued', summary: null, commits: [], mergeSha: null, error: null,
        createdAt: '2026-01-02T03:04:05.000Z', startedAt: null, finishedAt: null,
      },
    });
  });

  it('makes another owner\'s job indistinguishable from a missing job', async () => {
    const { connect } = await fixture();
    const { client } = await connect('editor', 11);
    const inaccessible = await call(client, 'get_write_status', { jobId: otherJobId });
    const missing = await call(client, 'get_write_status', { jobId: missingJobId });
    expectToolError(inaccessible);
    expectToolError(missing);
    expect(inaccessible.content).toEqual(missing.content);
    expect(inaccessible.structuredContent).toEqual(missing.structuredContent);
    expect(text(inaccessible)).not.toMatch(/Documented daily backups|Record the backup schedule|commit-a|merge-a/);
  });

  it('allows an admin to see another owner\'s completed job and to submit writes', async () => {
    const { connect } = await fixture();
    const { client } = await connect('admin', 1);
    expectPayload(await call(client, 'get_write_status', { jobId: otherJobId }), {
      job: {
        id: otherJobId, userId: 22, kind: 'agent', source: 'mcp', client: null, conflicts: [], input: 'Record the backup schedule.',
        status: 'succeeded', summary: 'Documented daily backups.', commits: ['commit-a'],
        mergeSha: 'merge-a', error: null, createdAt: '2026-01-02T03:04:05.000Z',
        startedAt: '2026-01-02T03:04:06.000Z', finishedAt: '2026-01-02T03:04:07.000Z',
      },
    });
    expectPayload(await call(client, 'write', { content: 'Document retention policy.' }), {
      jobId: firstWriteId, status: 'queued',
    });
  });

  it('reports a missing note as an MCP tool error without breaking subsequent reads', async () => {
    const { connect } = await fixture();
    const { client } = await connect();
    expectToolError(await call(client, 'read_note', { path: 'wiki/missing.md' }));
    expectPayload(await call(client, 'read_note', { path: 'wiki/backups.md' }), {
      path: 'wiki/backups.md', content: '# Backups\n\nThe main branch is backed up daily.\n',
      frontmatter: {}, body: '# Backups\n\nThe main branch is backed up daily.\n', updatedSha: 'main-sha', ref: 'main-sha',
    });
  });

  it('reports a service exception as an MCP tool error and remains usable', async () => {
    const { connect, search } = await fixture();
    const { client } = await connect();
    search.search.mockRejectedValueOnce(new Error('Search storage unavailable'));
    expectToolError(await call(client, 'search', { query: 'engine' }));
    expectPayload(await call(client, 'search', { query: 'no matching knowledge' }), { hits: [] });
  });

  it('rejects unauthenticated HTTP requests before exposing MCP or submitting writes', async () => {
    const { url, jobs } = await fixture();
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write', arguments: { content: 'Unauthorized write.' } } }),
    });
    expect(response.status).toBe(401);
    await response.arrayBuffer();
    expect(jobs.submit).not.toHaveBeenCalled();
  });

  it('keeps independent client identities and permissions isolated across interleaved requests', async () => {
    const { connect } = await fixture();
    const viewer = await connect('viewer', 12);
    const editor = await connect('editor', 11);
    expectPayload(await call(editor.client, 'write', { content: 'Remember the backup schedule.' }), {
      jobId: firstWriteId, status: 'queued',
    });
    expectToolError(await call(viewer.client, 'get_write_status', { jobId: firstWriteId }));
    expectToolError(await call(viewer.client, 'write', { content: 'Viewer must not enqueue this.' }));
    const ownJob = await call(editor.client, 'get_write_status', { jobId: firstWriteId });
    expect(ownJob.isError).not.toBe(true);
    expect(ownJob.structuredContent).toMatchObject({ job: { id: firstWriteId, userId: 11, input: 'Remember the backup schedule.' } });
    expectPayload(await call(editor.client, 'write', { content: 'Record restore procedures too.' }), {
      jobId: secondWriteId, status: 'queued',
    });
  });

  it.each(['GET', 'DELETE'])('rejects %s because the transport is stateless', async (method) => {
    const { url } = await fixture();
    const response = await fetch(url, {
      method, headers: { authorization: 'Bearer viewer:11', accept: 'application/json, text/event-stream' },
    });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    await response.arrayBuffer();
  });
});
