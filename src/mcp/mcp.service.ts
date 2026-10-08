import { Injectable } from '@nestjs/common';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { User } from '../auth/users.types.js';
import { KnowledgeRepo } from '../knowledge/repo.js';
import { SearchService } from '../rag/search.service.js';
import { WriteJobsService } from '../jobs/write-jobs.service.js';
import matter from 'gray-matter';
import { CatalogService } from '../rag/catalog.service.js';
import { ComparisonService } from '../rag/comparison.service.js';
import { IngestService } from '../ingest/ingest.service.js';
import { AclService } from '../acl/acl.service.js';
import { visibleBlame, visibleCommit, visibleCompare, visibleLog } from '../api/acl-history.js';
import { idSchema } from '../common/ids.js';

const maxPatchChars = 32_000;
const readOnly = { readOnlyHint: true, openWorldHint: false };
const pathSchema = z.string().min(1).describe('Repository-relative note path, for example wiki/topic.md.');
const refSchema = z.string().min(1).describe('Git commit or ref; defaults to main where optional.');
const limitSchema = z.number().int().min(1).max(100).optional();
const dateSchema = z.union([z.string().date(), z.string().datetime({ offset: true })]).optional();

function boundedPatch<T extends { patch: string }>(data: T): T & { truncated: boolean } {
  return { ...data, patch: data.patch.slice(0, maxPatchChars), truncated: data.patch.length > maxPatchChars };
}

const instructions = `
Use this wiki as shared, durable knowledge. Search before answering when existing
decisions, procedures, or domain knowledge could inform the answer. Read relevant
notes in full before relying on snippets; list_notes without a prefix includes
index.md to help you find the wiki's entry points.

Proactively use write to preserve useful, reusable discoveries, decisions,
procedures, and source material rather than waiting for an explicit request to
save them. Submit natural-language instructions or source content: Dony decides
how to integrate it with existing notes. Writing is asynchronous; retain the
jobId and use get_write_status to verify success before claiming it was saved.

Never write secrets, credentials, tokens, personal information, or live chat
state, temporary conversation context, or transient task progress. Only save
durable knowledge appropriate for sharing with all wiki readers.
`.trim();

function result(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

@Injectable()
export class McpService {
  constructor(
    private readonly search: SearchService,
    private readonly repo: KnowledgeRepo,
    private readonly jobs: WriteJobsService,
    private readonly catalog: CatalogService,
    private readonly comparison: ComparisonService,
    private readonly ingest: IngestService,
    private readonly acl: AclService,
  ) {}

  createServer(user: User, client?: string): McpServer {
    const server = new McpServer(
      { name: 'llmwiki-engine', version: '0.1.0' },
      { instructions },
    );

    server.registerTool('search', {
      description: 'Search shared wiki knowledge using hybrid keyword and semantic search. Read relevant notes with read_note before using the results as authoritative context.',
      inputSchema: {
        query: z.string().trim().min(1).describe('Question or keywords to search for.'),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum number of hits, from 1 to 100.'),
        folder: z.string().optional(),
        tags: z.array(z.string().min(1)).optional(),
        from: dateSchema,
        to: dateSchema,
        author: z.string().min(1).optional(),
        kinds: z.array(z.enum(['wiki', 'journal', 'raw', 'other'])).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, async ({ query, limit, ...filters }) => result({
      hits: await this.search.search(query, { limit, ...filters, user }),
    }));

    server.registerTool('read_note', {
      description: 'Read full Markdown and frontmatter at a pinned Git revision. Use a repository-relative path from search or list_notes; omit ref for current main.',
      inputSchema: { path: pathSchema, ref: refSchema.optional() },
      annotations: readOnly,
    }, async ({ path, ref }) => {
      this.acl.assertRead(user, path);
      const resolved = ref ? await this.repo.resolveRef(ref) : await this.repo.headSha();
      const content = await this.repo.readFile(path, resolved);
      if (content === null) return toolError('Note not found.');
      const parsed = matter(content);
      return result({ path, content, frontmatter: parsed.data, body: parsed.content, updatedSha: resolved, ref: resolved });
    });

    server.registerTool('list_notes', {
      description: 'List tracked Markdown notes on main, optionally restricted by a repository-relative prefix. Without a prefix, also return index.md content as the wiki entry point.',
      inputSchema: { prefix: z.string().optional().describe('Optional path prefix, for example wiki/.') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, async ({ prefix }) => {
      const files = this.acl.filterPaths(user, await this.repo.listFiles(prefix || undefined));
      if (prefix) return result({ files });
      return result({ files, index: this.acl.canRead(user, 'index.md') ? await this.repo.readFile('index.md') : null });
    });

    server.registerTool('note_history', {
      description: 'List commits affecting a note. follow defaults to true to include history before renames; before is a commit cursor.',
      inputSchema: { path: pathSchema, follow: z.boolean().optional(), limit: limitSchema, before: refSchema.optional() },
      annotations: readOnly,
    }, async ({ path, follow, limit, before }) => {
      this.acl.assertRead(user, path);
      return result({ commits: await visibleLog(this.repo, this.acl, user, { path, follow: follow ?? true, limit, beforeSha: before }) });
    });

    server.registerTool('get_commit', {
      description: 'Read commit metadata, changed files, and a bounded patch against the selected one-based parent (default 1).',
      inputSchema: { sha: refSchema, parent: z.number().int().min(1).optional() },
      annotations: readOnly,
    }, async ({ sha, parent }) => {
      const commit = await visibleCommit(this.repo, this.acl, user, sha, parent);
      return commit ? result(boundedPatch(commit)) : toolError('Commit not found.');
    });

    server.registerTool('compare', {
      description: 'Compare two Git revisions, optionally for one note. The patch is bounded to 32,000 characters; truncated indicates omitted content.',
      inputSchema: { base: refSchema, head: refSchema, path: pathSchema.optional() },
      annotations: readOnly,
    }, async ({ base, head, path }) => result(boundedPatch(await visibleCompare(this.repo, this.acl, user, base, head, path))));

    server.registerTool('blame', {
      description: 'Read line ranges and their originating commits at a Git revision, with job/source provenance when available.',
      inputSchema: { path: pathSchema, ref: refSchema.optional() },
      annotations: readOnly,
    }, async ({ path, ref }) => {
      this.acl.assertRead(user, path);
      const resolved = ref ? await this.repo.resolveRef(ref) : await this.repo.headSha();
      if (await this.repo.readFile(path, resolved) === null) return toolError('Note not found.');
      return result(await visibleBlame(this.repo, this.acl, user, path, resolved));
    });

    server.registerTool('note_links', {
      description: 'Read outgoing links, backlinks, and unresolved wiki links for a note.',
      inputSchema: { path: pathSchema },
      annotations: readOnly,
    }, async ({ path }) => {
      this.acl.assertRead(user, path);
      if (await this.repo.readFile(path) === null) return toolError('Note not found.');
      return result({ ...this.catalog.links(path, user) });
    });

    server.registerTool('similar_notes', {
      description: 'Find semantically similar notes using indexed embeddings. Missing or incompatible vectors return no neighbors.',
      inputSchema: { path: pathSchema, limit: limitSchema },
      annotations: readOnly,
    }, async ({ path, limit }) => {
      this.acl.assertRead(user, path);
      if (await this.repo.readFile(path) === null) return toolError('Note not found.');
      return result({ notes: await this.comparison.similar(path, limit, user) });
    });

    server.registerTool('ingest_source', {
      description: 'Editor/admin only. Import a URL, uploaded PDF/file/export, or text through the shared ingestion pipeline. Returns importId and asynchronous jobId; poll get_write_status before claiming completion.',
      inputSchema: {
        kind: z.enum(['url', 'pdf', 'text', 'obsidian', 'notion', 'file']),
        url: z.string().url().optional(),
        uploadId: idSchema.optional(),
        text: z.string().refine(value => value.trim().length > 0, 'Text must not be blank.').optional(),
        filename: z.string().min(1).optional(),
        instructions: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, async (input) => {
      if (user.role !== 'editor' && user.role !== 'admin') {
        return toolError('Writing requires the editor or admin role.');
      }
      return result(await this.ingest.ingest({ userId: user.id, ...input }));
    });

    server.registerTool('write', {
      description: 'Editor/admin only. Submit durable knowledge, source material, or natural-language editing instructions for Dony to integrate into the wiki. This is asynchronous: returns jobId and queued status, not a completed write. Poll get_write_status until succeeded or failed. Never submit secrets, personal information, or live chat state.',
      inputSchema: {
        content: z.string().refine(value => value.trim().length > 0, 'Content must not be blank.')
          .describe('Durable knowledge or instructions to integrate; preserve source text and relevant context.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, ({ content }) => {
      if (user.role !== 'editor' && user.role !== 'admin') {
        return toolError('Writing requires the editor or admin role.');
      }
      const job = this.jobs.submit({ userId: user.id, input: content, source: 'mcp', client });
      return result({ jobId: job.id, status: job.status });
    });

    server.registerTool('get_write_status', {
      description: 'Read an asynchronous write job, including its status, summary, commits, and error. You may view your own jobs; admins may view any job. Poll the jobId returned by write to confirm completion.',
      inputSchema: { jobId: idSchema.describe('Job identifier returned by write.') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, async ({ jobId }) => {
      const job = this.jobs.get(jobId);
      if (!job || (user.role !== 'admin' && job.userId !== user.id)) {
        return toolError('Write job not found.');
      }
      return result({ job: await this.jobs.visible(user, job) });
    });

    server.registerResource('index', 'llmwiki://index', {
      description: 'Tracked Markdown note tree on main.', mimeType: 'application/json',
    }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ files: this.acl.filterPaths(user, await this.repo.listFiles()) }) }],
    }));

    server.registerResource('note', new ResourceTemplate('llmwiki://notes/{+path}', {
      list: async () => ({
        resources: this.acl.filterPaths(user, await this.repo.listFiles()).map(path => ({
          name: path, uri: `llmwiki://notes/${path.split('/').map(encodeURIComponent).join('/')}`, mimeType: 'text/markdown',
        })),
      }),
    }), { description: 'Full Markdown note on main.', mimeType: 'text/markdown' }, async (uri, variables) => {
      const raw = variables.path;
      if (typeof raw !== 'string') throw new Error('A note path is required.');
      this.acl.assertRead(user, decodeURIComponent(raw));
      const content = await this.repo.readFile(decodeURIComponent(raw));
      if (content === null) throw new Error('Note not found.');
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: content }] };
    });

    server.registerPrompt('research_topic', {
      description: 'Research a topic using shared knowledge and cited full notes.',
      argsSchema: { topic: z.string().min(1) },
    }, ({ topic }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: `Research this topic: ${topic}\nUse search with relevant filters, read_note for full sources, and note_links or similar_notes to explore context. Cite note paths and heading anchors. Distinguish sourced knowledge from inference and identify gaps.` } }],
    }));

    server.registerPrompt('capture_knowledge', {
      description: 'Capture durable, shareable knowledge through Dony.',
      argsSchema: { content: z.string().min(1) },
    }, ({ content }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: `Preserve this reusable knowledge:\n${content}\nFirst search and read relevant existing notes. Exclude secrets, credentials, personal information, and transient chat state. If you have editor/admin permission, submit source material and context via write (or ingest_source for an import), then poll get_write_status before claiming it was saved. Dony decides how to integrate it.` } }],
    }));

    server.registerPrompt('review_note_history', {
      description: 'Review a note across renames and revisions.',
      argsSchema: { path: z.string().min(1) },
    }, ({ path }) => {
      this.acl.assertRead(user, path);
      return { messages: [{ role: 'user', content: { type: 'text', text: `Review the history of note ${path}. Use note_history with follow=true, get_commit with the appropriate parent, compare, and blame. Read historical content with read_note ref. Explain substantive changes and provenance; account for truncated patches rather than assuming they are complete.` } }] };
    });

    return server;
  }
}
