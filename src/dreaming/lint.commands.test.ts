import 'reflect-metadata';
import { mkdtemp, mkdir, lstat, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { git } from '../export/git.js';
import pino from 'pino';
import { loadConfig } from '../config.js';
import { openDb, runMigrations } from '../db/index.js';
import { KnowledgeRepo } from '../knowledge/repo.js';
import { IndexerService } from '../rag/indexer.service.js';
import { registerLintCommands } from './lint.commands.js';

const directories: string[] = [];
const originalExitCode = process.exitCode;
afterEach(async () => {
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function command(): Command {
  const program = new Command().exitOverride();
  registerLintCommands(program);
  return program;
}

async function fixture(notes: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'llmwiki-lint-test-'));
  directories.push(root);
  const dataDir = join(root, 'data');
  const repo = join(dataDir, 'knowledge');
  await mkdir(repo, { recursive: true });
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'Lint Test']);
  await git(repo, ['config', 'user.email', 'lint@example.test']);
  for (const [path, markdown] of Object.entries(notes)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), markdown);
  }
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '--allow-empty', '-m', 'Committed lint fixture']);
  const headSha = (await git(repo, ['rev-parse', 'main'])).trim();
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('DATA_DIR', dataDir);
  // A configured key must not cause lint to contact an embedding provider.
  vi.stubEnv('OPENAI_API_KEY', 'lint-must-not-use-this-key');
  vi.stubEnv('OPENAI_BASE_URL', 'http://127.0.0.1:1');
  return { root, dataDir, repo, headSha };
}

/** Observe files and metadata, including Git refs/index/worktrees; ignore access times changed by reads. */
async function snapshot(root: string): Promise<Record<string, unknown>> {
  const entries: Record<string, unknown> = {};
  async function visit(path: string, relative: string): Promise<void> {
    const info = await lstat(path);
    entries[relative] = {
      mode: info.mode, mtime: info.mtimeMs, ctime: info.ctimeMs,
      ...(info.isSymbolicLink() ? { link: await readlink(path) }
        : info.isFile() ? { bytes: (await readFile(path)).toString('base64') } : {}),
    };
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), `${relative}/${name}`);
    }
  }
  await visit(root, '');
  return entries;
}

async function indexCatalog(dataDir: string): Promise<void> {
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: dataDir });
  const log = pino({ level: 'silent' });
  const repo = await KnowledgeRepo.attachReadOnly(config, log);
  const db = openDb(join(dataDir, 'llmwiki.db'));
  try {
    runMigrations(db);
    await new IndexerService(config, db, log, repo).syncToHead();
    // An offline fixture avoids SQLite WAL sidecar lifecycle changing the filesystem snapshot.
    db.pragma('journal_mode = DELETE');
  } finally {
    db.close();
  }
}

describe('read-only CLI lint', () => {
  it('prints human-readable findings and exits 1 without changing repository, DB or abandoned worktrees', async () => {
    const { dataDir, repo, headSha } = await fixture({
      'index.md': '# Knowledge\n',
      'wiki/health/note.md': '# Note\n\n[[Missing]]\n',
      'wiki/loose.md': '# Unclassified\n',
    });
    const active = join(dataDir, 'worktrees', 'unfinished');
    await mkdir(dirname(active), { recursive: true });
    await git(repo, ['worktree', 'add', '-b', 'work/unfinished', active, 'main']);
    await writeFile(join(active, 'wiki/loose.md'), '# Unfinished edits\n');
    const stale = join(dataDir, 'worktrees', 'stale');
    await git(repo, ['worktree', 'add', '-b', 'work/stale', stale, 'main']);
    await rm(stale, { recursive: true });
    await indexCatalog(dataDir);
    await writeFile(join(repo, 'wiki/loose.md'), '# Dirty disk edit [[DiskOnly]]\n');
    const before = await snapshot(dataDir);
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    await command().parseAsync(['node', 'test', 'lint']);

    const output = logged.mock.calls.map(([value]) => String(value)).join('\n');
    expect(output).toContain(headSha);
    expect(output).toContain('Missing domain hubs (1)');
    expect(output).toContain('wiki/health/index.md');
    expect(output).toContain('Unclassified notes (1)');
    expect(output).toContain('wiki/loose.md');
    expect(output).toContain('Unresolved wikilinks (1)');
    expect(output).toContain('Missing');
    expect(output).toContain('Invalid note metadata (2; showing 2)');
    expect(output).toContain('description: 필수 속성이 없다');
    expect(output).toContain('tags: 필수 속성이 없다');
    expect(output).not.toContain('author: 필수 속성이 없다');
    expect(output).not.toContain('DiskOnly');
    expect(output).toContain('Exit 1 when any findings are present, including advisory signals; exit 0 otherwise.');
    expect(process.exitCode).toBe(1);
    expect(await snapshot(dataDir)).toEqual(before);
  });

  it('prints JSON for committed main rather than the checked-out branch or dirty files', async () => {
    const { dataDir, repo, headSha } = await fixture({
      'index.md': '[[wiki/health/index]]\n',
      'wiki/health/index.md': '# Health\n\n[[wiki/health/note]]',
      'wiki/health/note.md': '# Note\n\n[[Missing]]',
    });
    await indexCatalog(dataDir);
    await git(repo, ['checkout', '-b', 'other']);
    await writeFile(join(repo, 'wiki/health/note.md'), '# Other branch [[OtherMissing]]');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'Other branch content']);
    await writeFile(join(repo, 'wiki/health/index.md'), '# Dirty hub');
    const before = await snapshot(dataDir);
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    await command().parseAsync(['node', 'test', 'lint', '--json']);

    expect(JSON.parse(String(logged.mock.calls[0]?.[0]))).toMatchObject({
      headSha, indexedSha: headSha, catalog: 'current',
      signals: {
        missingDomainHubs: [], unlinkedDomainHubs: [], unclassifiedNotes: [],
        unresolved: [{ path: 'wiki/health/note.md', target: 'Missing' }],
        duplicates: [], orphans: [], missingHubs: [],
        invalidMetadataCount: 2,
        invalidMetadata: [
          { path: 'wiki/health/index.md', issues: [
            { field: 'type', message: '필수 속성이 없다' },
            { field: 'aliases', message: '필수 속성이 없다' },
            { field: 'description', message: '필수 속성이 없다' },
            { field: 'tags', message: '필수 속성이 없다' },
          ] },
          { path: 'wiki/health/note.md', issues: [
            { field: 'type', message: '필수 속성이 없다' },
            { field: 'aliases', message: '필수 속성이 없다' },
            { field: 'description', message: '필수 속성이 없다' },
            { field: 'tags', message: '필수 속성이 없다' },
          ] },
        ],
      },
    });
    expect(await snapshot(dataDir)).toEqual(before);
  });

  it('reports index-backed checks as unavailable without creating a missing database', async () => {
    const { dataDir, headSha } = await fixture({
      'index.md': '# Knowledge',
      'wiki/health/note.md': '# Note [[Missing]]',
      'wiki/loose.md': '# Loose',
    });
    const before = await snapshot(dataDir);
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    await command().parseAsync(['node', 'test', 'lint', '--json']);

    expect(JSON.parse(String(logged.mock.calls[0]?.[0]))).toMatchObject({
      headSha, indexedSha: null, catalog: 'unavailable',
      signals: {
        missingDomainHubs: ['wiki/health/index.md'], unclassifiedNotes: ['wiki/loose.md'],
        unresolved: [{ path: 'wiki/health/note.md', target: 'Missing' }],
        duplicates: null, orphans: ['wiki/health/note.md', 'wiki/loose.md'], missingHubs: null,
        invalidMetadataCount: 2,
      },
    });
    expect(process.exitCode).toBe(1);
    expect(await snapshot(dataDir)).toEqual(before);
  });

  it.each([false, true])('keeps committed orphan checks when the existing database has no checkpoint (migrated: %s)', async (migrated) => {
    const { dataDir, headSha } = await fixture({ 'wiki/concepts/isolated.md': '# Isolated' });
    const db = openDb(join(dataDir, 'llmwiki.db'));
    try {
      if (migrated) runMigrations(db);
      db.pragma('journal_mode = DELETE');
    } finally {
      db.close();
    }
    const before = await snapshot(dataDir);
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    await command().parseAsync(['node', 'test', 'lint', '--json']);

    expect(JSON.parse(String(logged.mock.calls[0]?.[0]))).toMatchObject({
      headSha, indexedSha: null, catalog: 'unavailable',
      signals: { duplicates: null, missingHubs: null, orphans: ['wiki/concepts/isolated.md'] },
    });
    expect(process.exitCode).toBe(1);
    expect(await snapshot(dataDir)).toEqual(before);
  });

  it('reports placement and folder-name findings from committed paths without a catalog or mutations', async () => {
    const { dataDir } = await fixture({
      'wiki/donidoeji/index.md': '# Domain',
      'wiki/donidoeji/AGENTS.md': '# Schema',
      'wiki/donidoeji/메모.md': '# Shallow',
      'wiki/donidoeji/crm/정상.md': '# Topic note',
      'wiki/donidoeji/crm/rewards/mobile/너무 깊은 노트.md': '# Deep',
      'wiki/돈이돼지 batch18/a/가져온 노트.md': '# Invalid folders',
      'wiki/donidoeji/2026-10/기간 노트.md': '# Date folder',
      'wiki/concepts/정본.md': '# Shared',
      'wiki/entities/people/인물.md': '# Shared topic',
      'wiki/미분류.md': '# Unclassified',
    });
    const before = await snapshot(dataDir);
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    await command().parseAsync(['node', 'test', 'lint', '--json']);

    const report = JSON.parse(String(logged.mock.calls[0]?.[0]));
    expect(report.catalog).toBe('unavailable');
    expect(report.signals.shallowDomainNotes).toEqual(['wiki/donidoeji/메모.md']);
    expect(report.signals.tooDeepNotes).toEqual(['wiki/donidoeji/crm/rewards/mobile/너무 깊은 노트.md']);
    expect(report.signals.unclassifiedNotes).toEqual(['wiki/미분류.md']);
    expect(report.signals.invalidFolderNames.map(({ path }: { path: string }) => path)).toEqual([
      'wiki/donidoeji/2026-10/', 'wiki/돈이돼지 batch18/', 'wiki/돈이돼지 batch18/a/',
    ]);
    expect(report.signals.invalidFolderNames).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'wiki/돈이돼지 batch18/', reason: expect.any(String) }),
    ]));

    await command().parseAsync(['node', 'test', 'lint']);

    const output = String(logged.mock.calls[1]?.[0]);
    expect(output).toContain('Shallow domain notes (1)');
    expect(output).toContain('Too-deep notes (1)');
    expect(output).toContain('Invalid folder names (3)');
    expect(output).toContain(`wiki/돈이돼지 batch18/: ${report.signals.invalidFolderNames[1].reason}`);
    expect(await snapshot(dataDir)).toEqual(before);
  });

  it('labels stale index findings while collecting path-backed signals from current main without reindexing', async () => {
    const { dataDir, repo, headSha: indexedSha } = await fixture({
      'index.md': '[[wiki/health/index]]',
      'wiki/health/index.md': '# Health [[wiki/health/note]]',
      'wiki/health/note.md': '# Note',
    });
    await indexCatalog(dataDir);
    await writeFile(join(repo, 'wiki/loose.md'), '# New unclassified note [[CurrentMissing]]');
    await writeFile(join(repo, 'wiki/health/index.md'), '# Health without its former note link');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'Advance main beyond index']);
    const headSha = (await git(repo, ['rev-parse', 'main'])).trim();
    const before = await snapshot(dataDir);
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    await command().parseAsync(['node', 'test', 'lint', '--json']);

    expect(JSON.parse(String(logged.mock.calls[0]?.[0]))).toMatchObject({
      headSha, indexedSha, catalog: 'stale',
      signals: {
        unclassifiedNotes: ['wiki/loose.md'],
        unresolved: [{ path: 'wiki/loose.md', target: 'CurrentMissing' }],
        duplicates: [], orphans: ['wiki/health/note.md', 'wiki/loose.md'], missingHubs: [],
      },
    });

    await command().parseAsync(['node', 'test', 'lint']);

    const output = String(logged.mock.calls[1]?.[0]);
    expect(output).toContain('Index-backed duplicate and tag-hub findings use the stale indexed SHA above.');
    expect(output).toContain('Orphan notes (2)');
    expect(output).toContain('Orphan, path, domain, wikilink, metadata and size findings always use the committed main SHA above.');
    expect(process.exitCode).toBe(1);
    expect(await snapshot(dataDir)).toEqual(before);
  });

  it('reports full metadata backlog and capped findings without needing a catalog', async () => {
    await fixture({
      ...Object.fromEntries(Array.from({ length: 25 }, (_, index) =>
        [`wiki/concepts/cache-${String(index).padStart(2, '0')}.md`, '# Cache'])),
      'wiki/concepts/valid.md': '---\ntype: concept\naliases: []\ndescription: "캐시 개념을 설명한다."\ntags: [cache]\n---\n# Cache',
    });
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    await command().parseAsync(['node', 'test', 'lint', '--json']);

    const report = JSON.parse(String(logged.mock.calls[0]?.[0]));
    expect(report.catalog).toBe('unavailable');
    expect(report.signals.invalidMetadataCount).toBe(25);
    expect(report.signals.invalidMetadata).toHaveLength(20);
    expect(report.signals.invalidMetadata[0]).toEqual({
      path: 'wiki/concepts/cache-00.md',
      issues: ['type', 'aliases', 'description', 'tags'].map((field) => ({ field, message: '필수 속성이 없다' })),
    });
    expect(report.signals.invalidMetadata.at(-1).path).toBe('wiki/concepts/cache-19.md');

    await command().parseAsync(['node', 'test', 'lint']);

    const output = String(logged.mock.calls[1]?.[0]);
    expect(output).toContain('Invalid note metadata (25; showing 20)');
    expect(output).toContain('wiki/concepts/cache-19.md');
    expect(output).not.toContain('wiki/concepts/cache-20.md');
    expect(output).not.toContain('wiki/concepts/valid.md');
  });

  it.each(['tinyNotes', 'oversizedNotes', 'orphans', 'unresolved'])(
    'exits 1 for advisory-only %s findings below structural thresholds', async (signal) => {
      const metadata = '---\ntype: concept\naliases: []\ndescription: "A reusable concept."\ntags: [knowledge]\n---\n';
      const body = 'Reusable knowledge. '.repeat(20);
      const notes: Record<string, string> = {
        'wiki/concepts/first.md': metadata + (signal === 'tinyNotes' ? '' : signal === 'oversizedNotes' ? body.repeat(60) : body)
          + (signal === 'orphans' ? '' : '\n[[wiki/concepts/second]]')
          + (signal === 'unresolved' ? '\n[[Missing]]' : ''),
      };
      if (signal !== 'orphans') notes['wiki/concepts/second.md'] = `${metadata}${body}\n[[wiki/concepts/first]]`;
      await fixture(notes);
      const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

      await command().parseAsync(['node', 'test', 'lint', '--json']);

      const { signals } = JSON.parse(String(logged.mock.calls[0]?.[0]));
      expect(signals[signal]).toHaveLength(1);
      expect(signals.invalidMetadataCount).toBe(0);
      expect(signals.missingDomainHubs).toEqual([]);
      expect(signals.unlinkedDomainHubs).toEqual([]);
      expect(signals.shallowDomainNotes).toEqual([]);
      expect(process.exitCode).toBe(1);
    },
  );

  it('exits 0 when available checks have no findings, even if catalog checks are unavailable', async () => {
    await fixture({ 'index.md': '# Knowledge' });
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.exitCode = undefined;

    await command().parseAsync(['node', 'test', 'lint', '--json']);

    const report = JSON.parse(String(logged.mock.calls[0]?.[0]));
    expect(report.catalog).toBe('unavailable');
    expect(report.signals.orphans).toEqual([]);
    expect(report.signals.duplicates).toBeNull();
    expect(report.signals.missingHubs).toBeNull();
    expect(process.exitCode).toBe(0);
  });

  it('rejects a missing knowledge repository without creating the configured DATA_DIR', async () => {
    const { root } = await fixture({});
    vi.stubEnv('DATA_DIR', join(root, 'missing-data'));
    const before = await snapshot(root);
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(command().parseAsync(['node', 'test', 'lint'])).rejects.toMatchObject({ code: 'ENOENT' });

    expect(logged).not.toHaveBeenCalled();
    expect(await snapshot(root)).toEqual(before);
  });

  it('rejects an unborn main without seeding or committing the repository', async () => {
    const { root } = await fixture({});
    const dataDir = join(root, 'unborn');
    const repo = join(dataDir, 'knowledge');
    await mkdir(repo, { recursive: true });
    await git(repo, ['init', '-b', 'main']);
    vi.stubEnv('DATA_DIR', dataDir);
    const before = await snapshot(dataDir);
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(command().parseAsync(['node', 'test', 'lint'])).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(logged).not.toHaveBeenCalled();
    expect(await snapshot(dataDir)).toEqual(before);
  });

  it('propagates database read errors without changing persistent data', async () => {
    const { dataDir } = await fixture({ 'wiki/loose.md': '# Note' });
    await writeFile(join(dataDir, 'llmwiki.db'), 'This is not a SQLite database');
    const before = await snapshot(dataDir);
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(command().parseAsync(['node', 'test', 'lint'])).rejects.toThrow(/not a database/);

    expect(logged).not.toHaveBeenCalled();
    expect(await snapshot(dataDir)).toEqual(before);
  });

  it('distinguishes unavailable index-backed checks from clean findings in human output', async () => {
    await fixture({ 'wiki/loose.md': '# Loose [[Missing]]' });
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    await command().parseAsync(['node', 'test', 'lint']);

    const output = String(logged.mock.calls[0]?.[0]);
    expect(output).toContain('Catalog: unavailable (indexed SHA: none)');
    expect(output).toContain('Duplicate candidates (unavailable)');
    expect(output).toContain('Orphan notes (1)');
    expect(output).toContain('Missing tag hubs (unavailable)');
    expect(output).toContain('Unclassified notes (1)');
    expect(output).toContain('Unresolved wikilinks (1)');
    expect(output).toContain('Index-backed duplicate and tag-hub checks are unavailable (not clean).');
    expect(process.exitCode).toBe(1);
  });

  it('preserves shared collector caps in JSON output', async () => {
    await fixture(Object.fromEntries(Array.from({ length: 25 }, (_, index) => [
      `wiki/domain-${String(index).padStart(2, '0')}/note.md`, `# Note ${index} [[Missing-${index}]]`,
    ])));
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    await command().parseAsync(['node', 'test', 'lint', '--json']);

    const report = JSON.parse(String(logged.mock.calls[0]?.[0]));
    expect(report.signals.missingDomainHubs).toHaveLength(20);
    expect(report.signals.unresolved).toHaveLength(20);
    expect(report.signals.tinyNotes).toHaveLength(20);
    expect(report.signals.orphans).toHaveLength(20);
    expect(report.signals.duplicates).toBeNull();
  });

  it('reports committed memory violations without a catalog and exits 1', async () => {
    const { repo } = await fixture({ 'MEMORY.md': '# Legacy memory' });
    await writeFile(join(repo, 'MEMORY.md'), '# Memory\n## 작업 관례\n## 진행 중\n## 참조\n');
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {});

    await command().parseAsync(['node', 'test', 'lint', '--json']);

    const { signals } = JSON.parse(String(logged.mock.calls[0]?.[0]));
    expect(signals.memoryIssues).toEqual([
      "MEMORY.md에 '## 작업 관례' 섹션이 필요하다.",
      "MEMORY.md에 '## 진행 중' 섹션이 필요하다.",
      "MEMORY.md에 '## 참조' 섹션이 필요하다.",
      "MEMORY.md의 2단계 섹션은 '## 작업 관례', '## 진행 중', '## 참조'만 이 순서로 한 번씩 둔다.",
    ]);
    expect(signals.orphans).toEqual([]);
    expect(signals.invalidMetadataCount).toBe(0);
    expect(process.exitCode).toBe(1);

    await command().parseAsync(['node', 'test', 'lint']);

    expect(String(logged.mock.calls[1]?.[0])).toContain('Memory issues (4)');
  });
});
