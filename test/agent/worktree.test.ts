import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import matter from 'gray-matter';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { AclService } from '../../src/acl/acl.service.js';
import type { AgentService } from '../../src/agent/agent.service.js';
import type { AgentTool, RunAgentOptions } from '../../src/agent/agent.types.js';
import { PAGE_MAX_CHARS, type ContentPage } from '../../src/agent/output.js';
import { makeWorktreeTools } from '../../src/agent/worktree.js';
import { resolveConflicts } from '../../src/agent/writes.js';
import { loadConfig } from '../../src/config.js';
import { KnowledgeRepo } from '../../src/knowledge/repo.js';
import type { SearchService } from '../../src/rag/search.service.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { UsersService } from '../../src/auth/users.service.js';
import { UsersRepository } from '../../src/auth/users.repository.js';
import { openDb, runMigrations } from '../../src/db/index.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
const author = { name: 'Paging tester', email: 'paging@example.test' };
const acl = {} as AclService;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'worktree-paging-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: directory });
  const repo = await KnowledgeRepo.open(config, pino({ level: 'silent' }));
  const wt = await repo.createWorktree('paging');
  cleanup.push(() => wt.dispose());
  const search = { search: async () => [] } as unknown as SearchService;
  const tools = makeWorktreeTools(search, wt, author, acl);
  return { repo, wt, tools, search };
}

async function invoke<T>(tools: AgentTool[], name: string, args: Record<string, unknown>): Promise<T> {
  return JSON.parse(await tools.find((tool) => tool.name === name)!.run(args)) as T;
}

describe('paged worktree tools', () => {
  it('reads long lines and all following pages, then preserves the entire file on replacement', async () => {
    const { wt, tools } = await fixture();
    const path = 'wiki/long.md';
    const original = '# Long\n' + '\\"\u0000'.repeat(12_000) + '\n' + 'fact\n'.repeat(801);
    await wt.write(path, original);
    let offset: number | null = 0;
    let charOffset = 0;
    let reconstructed = '';
    for (let pages = 0; offset !== null; pages++) {
      if (pages > 100) throw new Error('Paging failed to advance');
      const page = await invoke<ContentPage>(tools, 'read_file', { path, offset, charOffset });
      reconstructed += page.content;
      offset = page.nextOffset;
      charOffset = page.nextCharOffset ?? 0;
    }
    expect(reconstructed).toBe(original);
    await invoke(tools, 'write_file', { path, content: reconstructed + 'New fact.\n' });
    expect(await wt.read(path)).toBe(original + 'New fact.\n');
    expect(await invoke(tools, 'read_file', { path: 'wiki/missing.md' })).toEqual({ path: 'wiki/missing.md', content: null, totalLines: 0, nextOffset: null, truncated: false });
    await wt.write('wiki/empty.md', '');
    expect(await invoke(tools, 'read_file', { path: 'wiki/empty.md' })).toEqual({ path: 'wiki/empty.md', content: '', totalLines: 0, nextOffset: null, truncated: false });
  });

  it('pages listings within the requested folder and explains continuation', async () => {
    const { wt, tools } = await fixture();
    const paths = Array.from({ length: 503 }, (_, index) => `wiki/paged/${String(index).padStart(3, '0')}.md`);
    await Promise.all(paths.map((path) => wt.write(path, '# Note\n')));
    await wt.write('wiki/outside.md', '# Outside\n');
    type Listing = { files: string[]; totalFiles: number; nextOffset: number | null; truncated: boolean; continuation?: string };
    const first = await invoke<Listing>(tools, 'list_files', { prefix: 'wiki/paged/' });
    expect(first.files).toEqual(paths.slice(0, 500));
    expect(first).toMatchObject({ totalFiles: 503, nextOffset: 500, truncated: true });
    const last = await invoke<Listing>(tools, 'list_files', { prefix: 'wiki/paged/', offset: first.nextOffset });
    expect(last).toEqual({ files: paths.slice(500), totalFiles: 503, nextOffset: null, truncated: false });
    expect(first.files.concat(last.files)).toEqual(paths);
  });

  it('keeps long-path listings within the serialized page budget and preserves every path across pages', async () => {
    const { wt, tools } = await fixture();
    const directory = `wiki/long-paths/${'a'.repeat(200)}/${'b'.repeat(200)}/${'c'.repeat(200)}/`;
    const paths = Array.from({ length: 100 }, (_, index) => `${directory}note-${String(index).padStart(3, '0')}.md`);
    await Promise.all(paths.map((path) => wt.write(path, '# Note\n')));
    const list = tools.find((tool) => tool.name === 'list_files')!;
    const retrieved: string[] = [];
    let offset: number | null = 0;
    let pages = 0;
    while (offset !== null) {
      const serialized = await list.run({ prefix: 'wiki/long-paths/', offset });
      expect(serialized.length).toBeLessThanOrEqual(16_000);
      const page = z.object({
        files: z.array(z.string()), nextOffset: z.number().nullable(),
        truncated: z.boolean(), continuation: z.string().optional(),
      }).parse(JSON.parse(serialized));
      expect(JSON.stringify(page.files).length).toBeLessThanOrEqual(12_000);
      retrieved.push(...page.files);
      offset = page.nextOffset;
      if (++pages > 100) throw new Error('Listing failed to advance');
    }
    expect(retrieved).toEqual(paths);
    expect(pages).toBeGreaterThan(1);
  });

  it('accepts a 300-line read and rejects requests above the read or search limits', async () => {
    const { tools, wt } = await fixture();
    await wt.write('wiki/boundary.md', 'fact\n'.repeat(301));
    expect(await invoke<ContentPage>(tools, 'read_file', { path: 'wiki/boundary.md', limit: 300 }))
      .toMatchObject({ content: 'fact\n'.repeat(300), totalLines: 301, nextOffset: 300, truncated: true });
    await expect(invoke(tools, 'search', { query: 'notes', limit: 31 })).rejects.toThrow();
    await expect(invoke(tools, 'read_file', { path: 'wiki/boundary.md', limit: 301 })).rejects.toThrow();
  });

  it('pages every conflict revision and preserves both tail changes in a real git merge', async () => {
    const { wt: seed, repo, search } = await fixture();
    const path = 'wiki/conflict.md';
    const prefix = '# 지식\r\n' + '🧠\\"\t'.repeat(5_000) + '\r\n' + 'kept fact\r\n'.repeat(801);
    const base = prefix + 'original intent\n';
    const workBranch = prefix + 'work intent\nwork tail knowledge\n';
    const main = prefix + 'main intent\nmain tail knowledge\n';
    await seed.write(path, base);
    await seed.commit('Seed conflict note', author);
    await seed.fastForwardMain();
    const committedBase = (await repo.readFile(path))!;
    const wt = await repo.createWorktree('conflict-work');
    cleanup.push(() => wt.dispose());
    const concurrent = await repo.createWorktree('conflict-main');
    cleanup.push(() => concurrent.dispose());
    await wt.write(path, workBranch);
    await wt.commit('Add work tail knowledge', author);
    const committedWorkBranch = (await wt.read(path))!;
    await concurrent.write(path, main);
    await concurrent.commit('Add main tail knowledge', author);
    await concurrent.fastForwardMain();
    const committedMain = (await repo.readFile(path))!;
    expect(await wt.mergeMain()).toEqual({ ok: false, conflicts: [path] });
    const conflicted = await wt.read(path);
    expect(conflicted).toContain('<<<<<<<');
    const resolved = prefix + 'work intent\nwork tail knowledge\nmain intent\nmain tail knowledge\n';
    const agent = {
      baseInstructions: async () => '',
      worktreeTools: () => makeWorktreeTools(search, wt, author, acl),
      runAgent: async (options: RunAgentOptions) => {
        const input = JSON.parse(options.input as string) as { files: Array<Record<string, ContentPage>> };
        const file = input.files[0];
        for (const [version, expected] of Object.entries({
          base: committedBase, workBranch: committedWorkBranch, main: committedMain, conflicted,
        })) {
          let page = file[version];
          expect(page.truncated).toBe(true);
          expect(JSON.stringify(page.content).length).toBeLessThanOrEqual(PAGE_MAX_CHARS);
          expect(page.content).not.toContain('tail knowledge');
          let reconstructed = page.content;
          while (page.nextOffset !== null) {
            page = await invoke<ContentPage>(options.tools as AgentTool[],
              version === 'conflicted' ? 'read_file' : 'read_conflict_version',
              { path, ...(version === 'conflicted' ? {} : { version }), offset: page.nextOffset, charOffset: page.nextCharOffset ?? 0 });
            expect(JSON.stringify(page.content).length).toBeLessThanOrEqual(PAGE_MAX_CHARS);
            expect(page.content.isWellFormed()).toBe(true);
            reconstructed += page.content;
          }
          expect(reconstructed).toBe(expected);
        }
        await invoke(options.tools as AgentTool[], 'write_file', { path, content: resolved });
        expect(await invoke<ContentPage>(options.tools as AgentTool[], 'read_conflict_version',
          // Commit autofill adds five frontmatter lines before the work tail.
          { path, version: 'workBranch', offset: 808 })).toMatchObject({ content: 'work intent\nwork tail knowledge\n' });
        return { text: 'Resolved', toolCalls: 3 };
      },
    } as unknown as AgentService;
    await resolveConflicts(agent, repo, acl, wt, [path]);
    await wt.finishMerge(author);
    await wt.fastForwardMain();
    expect(matter((await repo.readFile(path))!).content).toBe(resolved);
  });

  it('distinguishes missing and empty revisions, caps injected lines, and validates revision paging scope', async () => {
    const { wt, search } = await fixture();
    const path = 'wiki/conflict.md';
    const revisions = { base: null, workBranch: '', main: 'fact\n'.repeat(301) };
    const repo = {
      readFile: async (_path: string, ref: string) => ref === wt.baseSha ? revisions.base : ref === wt.branch ? revisions.workBranch : revisions.main,
      log: async () => [],
    } as unknown as KnowledgeRepo;
    await wt.write(path, '<<<<<<< HEAD\n=======\nfact\n>>>>>>> main\n');
    const agent = {
      baseInstructions: async () => '',
      worktreeTools: () => makeWorktreeTools(search, wt, author, acl),
      runAgent: async (options: RunAgentOptions) => {
        const file = JSON.parse(options.input as string).files[0];
        expect(file.base).toBeNull();
        expect(file.workBranch).toEqual({ content: '', totalLines: 0, nextOffset: null, truncated: false });
        expect(file.main).toEqual({ content: 'fact\n'.repeat(300), totalLines: 301, nextOffset: 300, truncated: true });
        const tools = options.tools as AgentTool[];
        expect(await invoke(tools, 'read_conflict_version', { path, version: 'base' }))
          .toEqual({ path, version: 'base', content: null, totalLines: 0, nextOffset: null, truncated: false });
        expect(await invoke(tools, 'read_conflict_version', { path, version: 'workBranch' }))
          .toEqual({ path, version: 'workBranch', content: '', totalLines: 0, nextOffset: null, truncated: false });
        expect(await invoke(tools, 'read_conflict_version', { path, version: 'main', offset: 300, limit: 300 }))
          .toMatchObject({ content: 'fact\n', nextOffset: null, truncated: false });
        for (const args of [
          { path: 'wiki/private.md', version: 'main' }, { path, version: 'other' },
          { path, version: 'main', limit: 301 }, { path, version: 'main', offset: -1 },
          { path, version: 'main', charOffset: -1 }, { path, version: 'main', content: 'overwrite' },
        ]) await expect(invoke(tools, 'read_conflict_version', args)).rejects.toThrow();
        await invoke(tools, 'write_file', { path, content: revisions.main });
        return { text: 'Resolved', toolCalls: 1 };
      },
    } as unknown as AgentService;
    await resolveConflicts(agent, repo, acl, wt, [path]);
    expect(await wt.read(path)).toBe(revisions.main);
  });

  it('rechecks read ACLs for captured revision pages when access is revoked mid-resolution', async () => {
    const { wt, repo, search } = await fixture();
    const db = openDb(':memory:');
    runMigrations(db);
    cleanup.push(async () => db.close());
    const users = new UsersService(new UsersRepository(db));
    const admin = await users.create({ email: 'admin@conflict.test', role: 'admin' });
    const editor = await users.create({ email: 'editor@conflict.test', role: 'editor' });
    const acl = new AclService(db, users, new AuditService(db));
    const path = 'wiki/conflict.md';
    await wt.write(path, '<<<<<<< HEAD\nwork\n=======\nmain\n>>>>>>> main\n');
    const original = await wt.read(path);
    const agent = {
      baseInstructions: async () => '',
      worktreeTools: () => makeWorktreeTools(search, wt, author, acl, editor),
      runAgent: async (options: RunAgentOptions) => {
        const tools = options.tools as AgentTool[];
        acl.create({ prefix: path, subjectType: 'everyone', subject: '', access: 'none' }, admin);
        for (const version of ['base', 'workBranch', 'main']) {
          await expect(invoke(tools, 'read_conflict_version', { path, version })).rejects.toMatchObject({ status: 404 });
        }
        await expect(invoke(tools, 'read_file', { path })).rejects.toMatchObject({ status: 404 });
        await expect(invoke(tools, 'write_file', { path, content: 'unauthorized' })).rejects.toMatchObject({ status: 404 });
        expect(await wt.read(path)).toBe(original);
        acl.create({ prefix: path, subjectType: 'everyone', subject: '', access: 'write' }, admin);
        await invoke(tools, 'write_file', { path, content: 'work and main\n' });
        return { text: 'Resolved', toolCalls: 1 };
      },
    } as unknown as AgentService;
    await resolveConflicts(agent, repo, acl, wt, [path], undefined, editor);
    expect(await wt.read(path)).toBe('work and main\n');

    await wt.write(path, original!);
    let attempts = 0;
    agent.runAgent = async () => {
      attempts++;
      acl.create({ prefix: path, subjectType: 'everyone', subject: '', access: 'none' }, admin);
      return { text: 'Unresolved', toolCalls: 0 };
    };
    await expect(resolveConflicts(agent, repo, acl, wt, [path], undefined, editor)).rejects.toMatchObject({ status: 404 });
    expect(attempts).toBe(1);
    expect(await wt.read(path)).toBe(original);
  });
});
