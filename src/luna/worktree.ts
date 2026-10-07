import { z } from 'zod';
import type { Worktree } from '../knowledge/repo.js';
import type { SearchService } from '../rag/search.service.js';
import type { AgentTool } from './luna.types.js';
import type { AclService, AclUser } from '../acl/acl.service.js';

const pathArgs = z.object({ path: z.string().min(1) }).strict();
const searchArgs = z.object({ query: z.string().trim().min(1), limit: z.number().int().min(1).max(100).optional() }).strict();
const listArgs = z.object({ prefix: z.string().optional() }).strict();
const writeArgs = z.object({ path: z.string().min(1), content: z.string() }).strict();
const moveArgs = z.object({ from: z.string().min(1), to: z.string().min(1) }).strict();
const commitArgs = z.object({ message: z.string().trim().min(1) }).strict();

export function makeWorktreeTools(
  search: SearchService,
  wt: Worktree,
  author: { name: string; email: string },
  acl: AclService,
  user?: AclUser,
): AgentTool[] {
  return [
    {
      name: 'search',
      description: 'Search the main knowledge index before creating a note. Results describe main, not unmerged worktree edits; read_file reads this worktree.',
      parameters: {
        type: 'object', properties: { query: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
        required: ['query'], additionalProperties: false,
      },
      async run(args: unknown) {
        const { query, limit } = searchArgs.parse(args);
        const hits = await search.search(query, { limit, user });
        if (user) wt.onPhase?.('editing', { sourcePaths: hits.map(hit => hit.path) });
        return JSON.stringify(hits);
      },
    },
    {
      name: 'list_files',
      description: 'List Markdown files in the confined worktree, optionally beneath a repository-relative prefix.',
      parameters: { type: 'object', properties: { prefix: { type: 'string' } }, required: [], additionalProperties: false },
      async run(args: unknown) {
        const { prefix } = listArgs.parse(args);
        const files = await wt.list(prefix);
        const visible = user ? acl.filterPaths(user, files) : files;
        if (user) wt.onPhase?.('editing', { sourcePaths: visible });
        return JSON.stringify(visible);
      },
    },
    {
      name: 'read_file',
      description: 'Read a repository-relative file from this worktree. JSON content is null when absent and an empty string when empty.',
      parameters: { type: 'object', properties: { path: { type: 'string', minLength: 1 } }, required: ['path'], additionalProperties: false },
      async run(args: unknown) {
        const { path } = pathArgs.parse(args);
        if (user) acl.assertRead(user, path);
        if (user) wt.onPhase?.('editing', { sourcePath: path });
        return JSON.stringify({ path, content: await wt.read(path) });
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
      description: 'Commit a reviewed logical unit of worktree changes. The requester is the author; the configured Luna bot is the committer. A null SHA means no changes.',
      parameters: { type: 'object', properties: { message: { type: 'string', minLength: 1 } }, required: ['message'], additionalProperties: false },
      async run(args: unknown) {
        const { message } = commitArgs.parse(args);
        return JSON.stringify({ sha: await wt.commit(message, author) });
      },
    },
  ];
}
