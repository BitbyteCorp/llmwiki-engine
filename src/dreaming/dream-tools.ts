import { posix } from 'node:path';
import { z } from 'zod';
import { matchesAclPrefix, type AclService } from '../acl/acl.service.js';
import type { AgentTool } from '../agent/agent.types.js';
import { repoPath } from '../knowledge/repo.js';
import { wikilinkTargets } from '../rag/chunking.js';
import { NoteTargetResolver } from '../rag/link-resolver.js';

export const MAX_STRUCTURAL_CHANGES = 20;

export interface StructuralChange {
  kind: 'move' | 'delete';
  from: string;
  to?: string;
}

export interface GuardedDreamTools {
  tools: AgentTool[];
  changes(): StructuralChange[];
}

const fileArgs = z.object({ path: z.string().min(1) });
const moveArgs = z.object({ from: z.string().min(1), to: z.string().min(1) });

function assertMutable(path: string, structural: boolean): void {
  const key = path.toLowerCase();
  if (key === 'raw' || key.startsWith('raw/') || (structural && (
    key === 'journal' || key.startsWith('journal/') ||
    key === 'index.md' || key === 'memory.md' || key === 'agents.md'
  ))) {
    throw new Error(`Dreaming cannot mutate protected path: ${path}`);
  }
}

export function guardDreamTools(
  tools: AgentTool[],
  acl: Pick<AclService, 'list'>,
  limit = MAX_STRUCTURAL_CHANGES,
): GuardedDreamTools {
  const changes: StructuralChange[] = [];
  let pending = 0;
  return {
    tools: tools.map((tool) => {
      if (tool.name !== 'move_file' && tool.name !== 'delete_file' && tool.name !== 'write_file') return tool;
      return {
        ...tool,
        async run(args: unknown, signal?: AbortSignal) {
          let change: StructuralChange | undefined;
          if (tool.name === 'move_file') {
            const parsed = moveArgs.parse(args);
            const from = repoPath(parsed.from);
            const to = repoPath(parsed.to);
            assertMutable(from, true);
            assertMutable(to, true);
            if (acl.list().some((rule) => matchesAclPrefix(rule.prefix, from) !== matchesAclPrefix(rule.prefix, to))) {
              throw new Error(`Dreaming cannot move across ACL rule sets: ${from} -> ${to}`);
            }
            change = { kind: 'move', from, to };
          } else {
            const path = repoPath(fileArgs.parse(args).path);
            assertMutable(path, tool.name === 'delete_file');
            if (tool.name === 'delete_file') change = { kind: 'delete', from: path };
          }
          if (!change) return tool.run(args, signal);
          if (changes.length + pending >= limit) {
            throw new Error(`Dreaming structural change cap (${limit}) is reached. List remaining candidates in the journal instead.`);
          }
          // Reserve a slot before awaiting the mutation so concurrent calls share the same cap.
          pending++;
          try {
            const result = await tool.run(args, signal);
            changes.push(change);
            return result;
          } finally {
            pending--;
          }
        },
      };
    }),
    changes: () => changes.map((change) => ({ ...change })),
  };
}

export function unresolvedLinkTargets(
  paths: string[],
  notes: Iterable<{ path: string; content: string }>,
): Set<string> {
  const noteResolver = new NoteTargetResolver(paths.filter((path) => /\.md$/i.test(path)));
  const fileResolver = new NoteTargetResolver(paths);
  const unresolved = new Set<string>();
  for (const note of notes) {
    for (const target of wikilinkTargets(note.content)) {
      const extension = posix.extname(target.text).toLowerCase();
      const resolver = extension && extension !== '.md' ? fileResolver : noteResolver;
      if (resolver.resolve(target.name).path === null) unresolved.add(target.text);
    }
  }
  return unresolved;
}
