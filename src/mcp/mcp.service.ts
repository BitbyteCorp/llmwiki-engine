import { Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { User } from '../auth/users.types.js';
import { KnowledgeRepo } from '../knowledge/repo.js';
import { SearchService } from '../rag/search.service.js';
import { WriteJobsService } from '../jobs/write-jobs.service.js';

const instructions = `
Use this wiki as shared, durable knowledge. Search before answering when existing
decisions, procedures, or domain knowledge could inform the answer. Read relevant
notes in full before relying on snippets; list_notes without a prefix includes
index.md to help you find the wiki's entry points.

Proactively use write to preserve useful, reusable discoveries, decisions,
procedures, and source material rather than waiting for an explicit request to
save them. Submit natural-language instructions or source content: Luna decides
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
  ) {}

  createServer(user: User): McpServer {
    const server = new McpServer(
      { name: 'llmwiki-engine', version: '0.1.0' },
      { instructions },
    );

    server.registerTool('search', {
      description: 'Search shared wiki knowledge using hybrid keyword and semantic search. Read relevant notes with read_note before using the results as authoritative context.',
      inputSchema: {
        query: z.string().trim().min(1).describe('Question or keywords to search for.'),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum number of hits, from 1 to 100.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, async ({ query, limit }) => result({
      hits: await this.search.search(query, { limit }),
    }));

    server.registerTool('read_note', {
      description: 'Read the full Markdown content of a repository-relative note on main. Use the path returned by search or list_notes.',
      inputSchema: { path: z.string().min(1).describe('Repository-relative note path, for example wiki/topic.md.') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, async ({ path }) => {
      const content = await this.repo.readFile(path);
      return content === null ? toolError('Note not found.') : result({ path, content });
    });

    server.registerTool('list_notes', {
      description: 'List tracked Markdown notes on main, optionally restricted by a repository-relative prefix. Without a prefix, also return index.md content as the wiki entry point.',
      inputSchema: { prefix: z.string().optional().describe('Optional path prefix, for example wiki/.') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, async ({ prefix }) => {
      const files = await this.repo.listFiles(prefix || undefined);
      if (prefix) return result({ files });
      return result({ files, index: await this.repo.readFile('index.md') });
    });

    server.registerTool('write', {
      description: 'Editor/admin only. Submit durable knowledge, source material, or natural-language editing instructions for Luna to integrate into the wiki. This is asynchronous: returns jobId and queued status, not a completed write. Poll get_write_status until succeeded or failed. Never submit secrets, personal information, or live chat state.',
      inputSchema: {
        content: z.string().refine(value => value.trim().length > 0, 'Content must not be blank.')
          .describe('Durable knowledge or instructions to integrate; preserve source text and relevant context.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, ({ content }) => {
      if (user.role !== 'editor' && user.role !== 'admin') {
        return toolError('Writing requires the editor or admin role.');
      }
      const job = this.jobs.submit({ userId: user.id, input: content });
      return result({ jobId: job.id, status: job.status });
    });

    server.registerTool('get_write_status', {
      description: 'Read an asynchronous write job, including its status, summary, commits, and error. You may view your own jobs; admins may view any job. Poll the jobId returned by write to confirm completion.',
      inputSchema: { jobId: z.string().min(1).describe('Job identifier returned by write.') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    }, ({ jobId }) => {
      const job = this.jobs.get(jobId);
      if (!job || (user.role !== 'admin' && job.userId !== user.id)) {
        return toolError('Write job not found.');
      }
      return result({ job });
    });

    return server;
  }
}
