import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterEach, expect, it, vi } from 'vitest';
import { AclService } from '../acl/acl.service.js';
import { AuditService } from '../audit/audit.service.js';
import { UsersRepository } from '../auth/users.repository.js';
import { UsersService } from '../auth/users.service.js';
import { loadConfig } from '../config.js';
import { openDb, runMigrations } from '../db/index.js';
import { KnowledgeRepo } from '../knowledge/repo.js';
import type { SearchService } from '../rag/search.service.js';
import type { AgentService } from './agent.service.js';
import type { RunAgentOptions } from './agent.types.js';
import { repairNoteMetadata } from './metadata-repair.js';
import { makeWorktreeTools } from './worktree.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('restricts its one bounded run to reading and writing reported notes, even when the caller has broader ACLs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wiki-metadata-repair-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const db = openDb(':memory:');
  runMigrations(db);
  cleanups.push(async () => { db.close(); });
  db.prepare("INSERT INTO users(id,email,name,role,created_at) VALUES (1,'editor@example.test','Editor','editor','2026-01-01')").run();
  const users = new UsersService(new UsersRepository(db));
  const user = users.getById(1)!;
  const acl = new AclService(db, users, new AuditService(db));
  const repo = await KnowledgeRepo.open(loadConfig({ NODE_ENV: 'test', DATA_DIR: dir }), pino({ level: 'silent' }));
  const wt = await repo.createWorktree('restricted-repair');
  cleanups.push(() => wt.dispose());
  await wt.write('wiki/invalid.md', '# Useful fact\nPreserve the body.\n');
  await wt.write('wiki/other.md', '# Other knowledge\nDo not change.\n');
  const author = { name: 'Editor', email: 'editor@example.test' };
  const issues = [{ path: 'wiki/invalid.md', issues: [{ field: 'type', message: 'Required metadata is missing' }] }];
  const onUsage = vi.fn();
  const baseInstructions = vi.fn(async () => 'Base writing rules');
  const worktreeTools = vi.fn((...args: Parameters<AgentService['worktreeTools']>) => makeWorktreeTools({} as SearchService, args[0], args[1], acl, args[2]));
  const runAgent = vi.fn(async (options: RunAgentOptions) => {
    expect(options).toMatchObject({ lane: 'write', maxTurns: 8, input: JSON.stringify({ notes: issues }) });
    expect(options.tools.map(tool => tool.name)).toEqual(['read_file', 'write_file']);
    const read = options.tools.find(tool => tool.name === 'read_file')!;
    const write = options.tools.find(tool => tool.name === 'write_file')!;
    expect(write.parameters).toMatchObject({ properties: { path: { enum: ['wiki/invalid.md'] } }, additionalProperties: false });
    for (const path of ['wiki/other.md', 'wiki/new.md', 'wiki/../wiki/other.md', 'raw/source.md', 'wiki/invalid.md/../other.md']) {
      expect(() => write.run({ path, content: 'Forbidden edit' })).toThrow('Only notes with reported metadata issues may be accessed');
      expect(() => read.run({ path })).toThrow('Only notes with reported metadata issues may be accessed');
    }
    expect(JSON.parse(String(await read.run({ path: 'wiki/invalid.md', offset: 0, limit: 1 })))).toMatchObject({
      content: '# Useful fact\n', nextOffset: 1, truncated: true,
    });
    expect(JSON.parse(String(await read.run({ path: 'wiki/invalid.md', offset: 1 })))).toMatchObject({ content: 'Preserve the body.\n' });
    await write.run({ path: 'wiki/invalid.md', content: '---\ntype: note\n---\n# Useful fact\nPreserve the body.\n' });
    options.onUsage?.({ inputTokens: 11, cachedInputTokens: 3, outputTokens: 4, reasoningTokens: 1 });
    return { text: 'Metadata repaired', toolCalls: 3 };
  });
  const agent = { baseInstructions, worktreeTools, runAgent } as unknown as AgentService;
  await repairNoteMetadata(agent, wt, issues, author, user, { onUsage });
  expect(runAgent).toHaveBeenCalledTimes(1);
  expect(worktreeTools).toHaveBeenCalledWith(wt, author, user);
  expect(baseInstructions).toHaveBeenCalledWith(user, expect.any(Function));
  expect(onUsage).toHaveBeenCalledWith({ inputTokens: 11, cachedInputTokens: 3, outputTokens: 4, reasoningTokens: 1 });
  expect(await wt.read('wiki/other.md')).toBe('# Other knowledge\nDo not change.\n');
  expect(await wt.read('wiki/new.md')).toBeNull();
  expect(await wt.read('wiki/invalid.md')).toBe('---\ntype: note\n---\n# Useful fact\nPreserve the body.\n');
});
