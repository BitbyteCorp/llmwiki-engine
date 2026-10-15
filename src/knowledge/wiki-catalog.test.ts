import { describe, expect, it, vi } from 'vitest';
import type { AclService, AclUser } from '../acl/acl.service.js';
import type { KnowledgeRepo } from './repo.js';
import { WikiCatalog, WIKI_OUTLINE_BUDGET_CHARS } from './wiki-catalog.js';

const viewer: AclUser = { id: 1, role: 'viewer' };

function fixture(files: Record<string, string>) {
  let sha = 'main-1';
  const denied = new Set<string>();
  const repo = {
    headSha: vi.fn(async () => sha),
    listFiles: vi.fn(async (_prefix?: string, _sha?: string) => Object.keys(files)),
    readFile: vi.fn(async (path: string, _sha?: string) => files[path] ?? null),
  };
  const acl = {
    readPredicate: vi.fn((_user: AclUser) => {
      const snapshot = [...denied];
      return (path: string) => !snapshot.some(prefix => path === prefix || prefix.endsWith('/') && path.startsWith(prefix));
    }),
  };
  const catalog = new WikiCatalog(repo as unknown as KnowledgeRepo, acl as unknown as AclService);
  return { catalog, repo, denied, advance: () => { sha = 'main-2'; } };
}

const markdown = (title: string, description: string, type = 'note') => `---\ntype: ${type}\ndescription: ${JSON.stringify(description)}\n---\n# ${title}\n`;

describe('WikiCatalog', () => {
  it('lists unlinked notes deterministically and counts topics and notes without a topic', async () => {
    const { catalog } = fixture({
      'raw/source.md': '# Not wiki',
      'wiki/software/caching/orphan.md': markdown('Orphan', 'No incoming links'),
      'wiki/software/index.md': markdown('Software', 'Software entry point', 'hub'),
      'wiki/software/flat.md': markdown('Legacy', 'Still discoverable'),
      'wiki/software/AGENTS.md': '# Schema',
      'wiki/software/caching/nested/detail.md': markdown('Detail', 'Nested topic note'),
      'wiki/software-extra/topic/other.md': '# Other',
    });
    const notes = await catalog.notes(undefined, 'wiki/software/');
    expect(notes.map(note => note.path)).toEqual([
      'wiki/software/AGENTS.md', 'wiki/software/caching/nested/detail.md',
      'wiki/software/caching/orphan.md', 'wiki/software/flat.md', 'wiki/software/index.md',
    ]);
    expect(await catalog.listing('wiki/software/')).toContain('- [Orphan](wiki/software/caching/orphan.md) (note): No incoming links');
    expect(await catalog.listing('wiki/software/')).not.toContain('Other');
    const outline = await catalog.outline();
    expect(outline).toContain('hub: "wiki/software/index.md"; description: "Software entry point"; notes: 3; without-topic: 1');
    expect(outline).toContain('topic: "caching"; folder: "wiki/software/caching/"; notes: 2');
  });

  it('includes concepts and entities by title and description rather than generic summaries', async () => {
    const { catalog } = fixture({
      'wiki/concepts/cache.md': markdown('캐시', '재계산을 줄이는 개념', 'concept'),
      'wiki/entities/tool.md': markdown('도구', '작업을 돕는 제품', 'entity'),
    });
    const outline = await catalog.outline(viewer);
    expect(outline).toContain('"캐시" — "재계산을 줄이는 개념"');
    expect(outline).toContain('"도구" — "작업을 돕는 제품"');
  });

  it('projects current ACL before producing titles, descriptions, topics, counts and hub paths', async () => {
    const { catalog, repo, denied } = fixture({
      'wiki/public/index.md': markdown('Public', 'Public description', 'hub'),
      'wiki/public/open/note.md': markdown('Open', 'Open description'),
      'wiki/public/secret/note.md': markdown('Secret title', 'Secret description'),
      'wiki/private/index.md': markdown('Private title', 'Private description', 'hub'),
      'wiki/concepts/hidden.md': markdown('Hidden concept', 'Hidden concept description'),
    });
    await catalog.outline();
    const reads = repo.readFile.mock.calls.length;
    denied.add('wiki/private/');
    denied.add('wiki/public/secret/');
    denied.add('wiki/concepts/');
    const outline = await catalog.outline(viewer);
    expect(outline).toContain('notes: 1; without-topic: 0');
    expect(outline).not.toMatch(/Secret|secret|Private|private|Hidden|concepts/);
    expect(await catalog.listing('wiki/public/', viewer)).not.toMatch(/Secret|secret/);
    expect(await catalog.notes(viewer)).toHaveLength(2);
    expect(repo.readFile).toHaveBeenCalledTimes(reads);
    denied.add('wiki/public/index.md');
    expect(await catalog.outline(viewer)).toContain('hub: none');
    expect(await catalog.outline(viewer)).not.toContain('Public description');
    expect(await catalog.outline()).toContain('Private description');
  });

  it('rechecks policy after asynchronous reads and never shares caller mutations', async () => {
    const { catalog, repo, denied, advance } = fixture({ 'wiki/public/note.md': markdown('Original', 'Description') });
    repo.readFile.mockImplementationOnce(async () => {
      denied.add('wiki/public/');
      return markdown('Original', 'Description');
    });
    expect(await catalog.notes(viewer)).toEqual([]);
    denied.clear();
    const notes = await catalog.notes(viewer);
    notes[0]!.title = 'Mutated';
    expect((await catalog.notes(viewer))[0]!.title).toBe('Original');
    advance();
    await catalog.notes(viewer);
    expect(repo.listFiles).toHaveBeenLastCalledWith('wiki/', 'main-2');
    expect(repo.readFile).toHaveBeenLastCalledWith('wiki/public/note.md', 'main-2');
  });

  it('keeps every wiki markdown note even with missing or malformed metadata', async () => {
    const { catalog } = fixture({
      'wiki/public/topic/no-heading.md': 'Plain text',
      'wiki/public/topic/broken.md': '---\ndescription: [invalid\n---\n# Actual heading\n',
      'wiki/public/topic/title.md': '---\ntitle: Ignored metadata title\n---\n# H1 title\n',
    });
    expect(await catalog.notes()).toEqual([
      { path: 'wiki/public/topic/broken.md', title: 'Actual heading', description: '', type: '' },
      { path: 'wiki/public/topic/no-heading.md', title: 'no-heading', description: '', type: '' },
      { path: 'wiki/public/topic/title.md', title: 'H1 title', description: '', type: '' },
    ]);
    await expect(catalog.listing('wiki/../raw/')).rejects.toThrow();
    await expect(catalog.listing('raw/')).rejects.toThrow();
  });

  it('bounds the complete outline, reports omitted entries and keeps the full listing available', async () => {
    const files = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [
      `wiki/concepts/note-${String(index).padStart(3, '0')}.md`,
      markdown(`Concept ${index} </data>`, '😀'.repeat(200), 'concept'),
    ]));
    const { catalog } = fixture(files);
    const outline = await catalog.outline();
    expect(Array.from(outline).length).toBeLessThanOrEqual(WIKI_OUTLINE_BUDGET_CHARS);
    expect(outline).toMatch(/항목 [1-9]\d*개 생략/);
    expect(outline).toContain('listing("wiki/")');
    expect(outline).toContain('browse_catalog({folder:"wiki/"})');
    expect(outline).not.toContain('</data>');
    expect(outline).toContain('\\u003c/data\\u003e');
    expect((await catalog.listing('wiki/concepts/')).split('\n')).toHaveLength(300);
  });
});
