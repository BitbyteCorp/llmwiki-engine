import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import type { AclService } from '../../src/acl/acl.service.js';
import type { AgentService } from '../../src/agent/agent.service.js';
import type { AgentTool, RunAgentOptions } from '../../src/agent/agent.types.js';
import type { ContentPage } from '../../src/agent/output.js';
import { makeWorktreeTools } from '../../src/agent/worktree.js';
import { resolveConflicts } from '../../src/agent/writes.js';
import { loadConfig } from '../../src/config.js';
import { KnowledgeRepo } from '../../src/knowledge/repo.js';
import type { SearchService } from '../../src/rag/search.service.js';

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

  it('allows conflict tools to read continuation pages without shrinking injected revision context', async () => {
    const { wt, repo, search } = await fixture();
    const path = 'wiki/conflict.md';
    const original = 'kept fact\n'.repeat(801) + '<<<<<<< HEAD\nwork\n=======\nmain\n>>>>>>> main\n';
    await wt.write(path, original);
    let observedSnapshot = '';
    const agent = {
      baseInstructions: async () => '',
      worktreeTools: () => makeWorktreeTools(search, wt, author, acl),
      runAgent: async (options: RunAgentOptions) => {
        const input = z.object({ files: z.array(z.object({ conflicted: z.string() })) }).parse(JSON.parse(options.input as string));
        observedSnapshot = input.files[0].conflicted;
        let reconstructed = '';
        let offset: number | null = 0;
        let charOffset = 0;
        do {
          const page = await invoke<ContentPage>(options.tools as AgentTool[], 'read_file', { path, offset, charOffset });
          reconstructed += page.content;
          offset = page.nextOffset;
          charOffset = page.nextCharOffset ?? 0;
        } while (offset !== null);
        const resolved = reconstructed.replace('<<<<<<< HEAD\nwork\n=======\nmain\n>>>>>>> main\n', 'work and main\n');
        await invoke(options.tools as AgentTool[], 'write_file', { path, content: resolved });
        return { text: 'Resolved', toolCalls: 3 };
      },
    } as unknown as AgentService;
    await resolveConflicts(agent, repo, acl, wt, [path]);
    expect(observedSnapshot).toBe(original);
    expect(await wt.read(path)).toBe('kept fact\n'.repeat(801) + 'work and main\n');
  });
});
