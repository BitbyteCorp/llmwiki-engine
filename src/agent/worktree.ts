import { z } from 'zod';
import type { Worktree } from '../knowledge/repo.js';
import type { SearchService } from '../rag/search.service.js';
import type { AgentTool } from './agent.types.js';
import type { AclService, AclUser } from '../acl/acl.service.js';
import { pageContent, PAGE_MAX_CHARS, PAGE_MAX_LINES, type ContentPage } from './output.js';

export const LIST_MAX_FILES = 500;
export const SEARCH_MAX_RESULTS = 30;
export const readPageArgs = {
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(PAGE_MAX_LINES).optional(),
  charOffset: z.number().int().min(0).optional(),
};
export const readPageParameters = {
  offset: { type: 'integer', minimum: 0, description: '0-based line offset.' },
  limit: { type: 'integer', minimum: 1, maximum: PAGE_MAX_LINES, default: PAGE_MAX_LINES },
  charOffset: { type: 'integer', minimum: 0, description: 'Character offset within the offset line; use nextCharOffset to continue a long line.' },
};

const pathArgs = z.object({ path: z.string().min(1) }).strict();
const readArgs = z.object({ path: z.string().min(1), ...readPageArgs }).strict();
const searchArgs = z.object({ query: z.string().trim().min(1), limit: z.number().int().min(1).max(SEARCH_MAX_RESULTS).optional() }).strict();
const listArgs = z.object({ prefix: z.string().optional(), offset: z.number().int().min(0).default(0) }).strict();
const writeArgs = z.object({ path: z.string().min(1), content: z.string() }).strict();
const moveArgs = z.object({ from: z.string().min(1), to: z.string().min(1) }).strict();
const commitArgs = z.object({ message: z.string().trim().min(1) }).strict();

export type WorktreeReadObserver = (path: string, source: string, page: ContentPage, options: { offset?: number; charOffset?: number }) => void;

export function makeWorktreeTools(
  search: SearchService,
  wt: Worktree,
  author: { name: string; email: string },
  acl: AclService,
  user?: AclUser,
  onRead?: WorktreeReadObserver,
): AgentTool[] {
  return [
    {
      name: 'search',
      description: 'Search the main knowledge index before creating a note. Results describe main, not unmerged worktree edits; read_file reads this worktree.',
      parameters: {
        type: 'object', properties: { query: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: SEARCH_MAX_RESULTS } },
        required: ['query'], additionalProperties: false,
      },
      async run(args: unknown, signal?: AbortSignal) {
        const { query, limit } = searchArgs.parse(args);
        const hits = await search.search(query, { limit: limit ?? SEARCH_MAX_RESULTS, user }, signal);
        if (user) wt.onPhase?.('editing', { sourcePaths: hits.map(hit => hit.path) });
        return JSON.stringify(hits);
      },
    },
    {
      name: 'list_files',
      description: 'List up to 500 Markdown files in the confined worktree, within a 12000-character serialized path budget. Continue at nextOffset with the same prefix, or narrow prefix to a folder.',
      parameters: { type: 'object', properties: { prefix: { type: 'string' }, offset: { type: 'integer', minimum: 0, default: 0 } }, required: [], additionalProperties: false },
      async run(args: unknown) {
        const { prefix, offset } = listArgs.parse(args);
        const files = await wt.list(prefix);
        const visible = user ? acl.filterPaths(user, files) : files;
        const page: string[] = [];
        let serializedChars = 2;
        for (let index = offset; index < visible.length && page.length < LIST_MAX_FILES; index++) {
          const cost = JSON.stringify(visible[index]).length + (page.length ? 1 : 0);
          if (page.length && serializedChars + cost > PAGE_MAX_CHARS) break;
          page.push(visible[index]);
          serializedChars += cost;
        }
        if (user) wt.onPhase?.('editing', { sourcePaths: page });
        const nextOffset = offset + page.length < visible.length ? offset + page.length : null;
        return JSON.stringify({
          files: page, totalFiles: visible.length, nextOffset, truncated: nextOffset !== null,
          ...(nextOffset !== null ? { continuation: `Continue list_files with offset=${nextOffset} and the same prefix, or narrow prefix to a folder.` } : {}),
        });
      },
    },
    {
      name: 'read_file',
      description: 'Read a page of a worktree file: content,totalLines,nextOffset,truncated. Offset is 0-based; default/max 300 lines and max 12000 characters. Continue with nextOffset and nextCharOffset (if present). Pages preserve line endings. Assemble all needed pages before replacing via write_file. Missing content is null; empty content is an empty string.',
      parameters: { type: 'object', properties: { path: { type: 'string', minLength: 1 }, ...readPageParameters }, required: ['path'], additionalProperties: false },
      async run(args: unknown) {
        const { path, offset, limit, charOffset } = readArgs.parse(args);
        if (user) acl.assertRead(user, path);
        if (user) wt.onPhase?.('editing', { sourcePath: path });
        const content = await wt.read(path);
        if (content === null) return JSON.stringify({ path, content: null, totalLines: 0, nextOffset: null, truncated: false });
        const page = pageContent(content, offset, limit, charOffset);
        onRead?.(path, content, page, { offset, charOffset });
        return JSON.stringify({ path, ...page });
      },
    },
    {
      name: 'write_file',
      description: 'Create or replace a repository-relative file in this worktree. Supply the complete content; an empty string creates an empty file.',
      parameters: {
        type: 'object', properties: { path: { type: 'string', minLength: 1 }, content: { type: 'string' } },
        required: ['path', 'content'], additionalProperties: false,
      },
      async run(args: unknown) {
        const { path, content } = writeArgs.parse(args);
        if (user) acl.assertWrite(user, path);
        await wt.write(path, content);
        return JSON.stringify({ path, written: true });
      },
    },
    {
      name: 'delete_file',
      description: 'Delete a repository-relative file from this worktree. Do not delete immutable raw sources.',
      parameters: { type: 'object', properties: { path: { type: 'string', minLength: 1 } }, required: ['path'], additionalProperties: false },
      async run(args: unknown) {
        const { path } = pathArgs.parse(args);
        if (user) acl.assertWrite(user, path);
        await wt.remove(path);
        return JSON.stringify({ path, deleted: true });
      },
    },
    {
      name: 'move_file',
      description: 'Move a file between repository-relative paths inside this worktree. Do not move immutable raw sources.',
      parameters: {
        type: 'object', properties: { from: { type: 'string', minLength: 1 }, to: { type: 'string', minLength: 1 } },
        required: ['from', 'to'], additionalProperties: false,
      },
      async run(args: unknown) {
        const { from, to } = moveArgs.parse(args);
        if (user) {
          acl.assertWrite(user, from);
          acl.assertWrite(user, to);
        }
        await wt.move(from, to);
        return JSON.stringify({ from, to, moved: true });
      },
    },
    {
      name: 'commit',
      description: 'Commit a reviewed logical unit of worktree changes. The requester is the author; the configured Dony bot is the committer. A null SHA means no changes.',
      parameters: { type: 'object', properties: { message: { type: 'string', minLength: 1 } }, required: ['message'], additionalProperties: false },
      async run(args: unknown) {
        const { message } = commitArgs.parse(args);
        return JSON.stringify({ sha: await wt.commit(message, author) });
      },
    },
  ];
}
