import { describe, expect, it } from 'vitest';
import type { KnowledgeRepo } from '../knowledge/repo.js';
import type { CatalogGraph, CatalogService } from '../rag/catalog.service.js';
import type { ComparisonService, DuplicateNotes } from '../rag/comparison.service.js';
import { collectStructureSignals, restrictStructureSignals, selectDreamMode, type StructureSignals } from './structure-signals.js';

function emptySignals(overrides: Partial<StructureSignals> = {}): StructureSignals {
  return {
    duplicates: [], orphans: [], unresolved: [], ambiguous: [], oversizedFolders: [], oversizedNotes: [],
    tinyNotes: [], missingHubs: [], ...overrides,
  };
}

function fixture(notes: Record<string, string>, graph: CatalogGraph = { nodes: [], edges: [] }, duplicates: DuplicateNotes[] = []) {
  const repo = {
    diffNames: async (fromSha: string | null) => fromSha === null
      ? Object.keys(notes).map((path) => ({ path, status: 'A' }))
      : [],
    readFile: async (path: string) => notes[path] ?? null,
  } as unknown as KnowledgeRepo;
  const catalog = { graph: () => graph } as unknown as CatalogService;
  const comparison = { duplicates: async () => duplicates } as unknown as ComparisonService;
  return collectStructureSignals(repo, catalog, comparison, 'captured-sha');
}

const sweepFolders = [
  { path: 'wiki/z/', files: ['wiki/z/note.md'] },
  { path: 'wiki/a/', files: ['wiki/a/note.md'] },
  { path: 'wiki/', files: ['wiki/index.md'] },
];

const duplicate: StructureSignals['duplicates'][number] = {
  left: 'wiki/a.md', right: 'wiki/b.md', score: 1, reason: 'exact',
};

describe('dream mode selection', () => {
  it.each<Partial<StructureSignals>>([
    { duplicates: [duplicate] },
    { orphans: Array.from({ length: 5 }, (_, index) => `wiki/${index}.md`) },
    { oversizedFolders: [{ path: 'wiki/', count: 31, files: ['wiki/index.md'] }] },
    { ambiguous: [{ path: 'wiki/a.md', target: 'shared', candidates: ['wiki/x/shared.md', 'wiki/y/shared.md'] }] },
    { unresolved: Array.from({ length: 5 }, (_, index) => ({ path: 'wiki/a.md', target: `missing-${index}` })) },
    { missingHubs: [{ tag: 'topic', count: 5, paths: ['wiki/a.md'] }] },
  ])('prioritizes structural repair over local changes and sweeps for %j', (signals) => {
    expect(selectDreamMode(emptySignals(signals), true, sweepFolders, new Map())).toEqual({ mode: 'structural', focus: null });
    expect(selectDreamMode(emptySignals(signals), false, sweepFolders, new Map())).toEqual({ mode: 'structural', focus: null });
  });

  it('does not promote below-threshold orphans, unresolved links or note sizes to structural mode', () => {
    const signals = emptySignals({
      orphans: ['wiki/a.md', 'wiki/b.md', 'wiki/c.md', 'wiki/d.md'],
      unresolved: Array.from({ length: 4 }, (_, index) => ({ path: 'wiki/a.md', target: `missing-${index}` })),
      oversizedNotes: [{ path: 'wiki/a.md', chars: 20_001 }],
      tinyNotes: [{ path: 'wiki/b.md', chars: 199 }],
    });
    expect(selectDreamMode(signals, true, sweepFolders, new Map())).toEqual({ mode: 'local', focus: null });
    expect(selectDreamMode(signals, false, sweepFolders, new Map())).toEqual({ mode: 'sweep', focus: 'wiki/' });
  });

  it('rotates never-swept folders first, then oldest successful sweep with path tie breaks', () => {
    const lastSweeps = new Map([['wiki/', '2026-10-01T00:00:00Z']]);
    expect(selectDreamMode(emptySignals(), false, sweepFolders, lastSweeps)).toEqual({ mode: 'sweep', focus: 'wiki/a/' });
    lastSweeps.set('wiki/a/', '2026-10-03T00:00:00Z');
    expect(selectDreamMode(emptySignals(), false, sweepFolders, lastSweeps)).toEqual({ mode: 'sweep', focus: 'wiki/z/' });
    lastSweeps.set('wiki/z/', '2026-10-01T00:00:00Z');
    expect(selectDreamMode(emptySignals(), false, sweepFolders, lastSweeps)).toEqual({ mode: 'sweep', focus: 'wiki/' });
    lastSweeps.set('wiki/', '2026-10-04T00:00:00Z');
    expect(selectDreamMode(emptySignals(), false, sweepFolders, lastSweeps)).toEqual({ mode: 'sweep', focus: 'wiki/z/' });
  });

  it('skips folders with no direct wiki markdown but still processes local changes', () => {
    const folders = [
      { path: 'raw/', files: ['raw/source.md'] },
      { path: 'wiki/empty/', files: [] },
      { path: 'wiki/ancestor/', files: ['wiki/ancestor/nested/note.md'] },
    ];
    expect(selectDreamMode(emptySignals(), false, folders, new Map())).toEqual({ mode: null, focus: null });
    expect(selectDreamMode(emptySignals(), true, folders, new Map())).toEqual({ mode: 'local', focus: null });
  });
});

describe('structural signal collection', () => {
  it('uses strict size boundaries, excludes frontmatter from tiny bodies and counts only direct markdown', async () => {
    const notes: Record<string, string> = {
      'wiki/sizes/exact-large.md': 'x'.repeat(20_000),
      'wiki/sizes/oversized.md': 'x'.repeat(20_001),
      'wiki/sizes/exact-tiny.md': 'x'.repeat(200),
      'wiki/sizes/tiny.md': `---\ntitle: ${'x'.repeat(500)}\n---\n${'x'.repeat(199)}`,
      'wiki/sizes/empty.md': '---\ntitle: Empty\n---\n',
      'wiki/big/image.png': 'not markdown',
      'wiki-extra/oversized.md': 'x'.repeat(20_001),
      'raw/oversized.md': 'x'.repeat(20_001),
      'index.md': 'root index',
      'wiki/index.md': 'wiki index',
    };
    for (let index = 0; index < 30; index++) notes[`wiki/exact/${String(index).padStart(2, '0')}.md`] = 'x'.repeat(200);
    for (let index = 0; index < 31; index++) notes[`wiki/big/${String(index).padStart(2, '0')}.md`] = 'x'.repeat(200);
    notes['wiki/exact/nested/note.md'] = 'x'.repeat(200);
    const { signals, folders } = await fixture(notes);
    expect(signals.oversizedNotes).toEqual([{ path: 'wiki/sizes/oversized.md', chars: 20_001 }]);
    expect(signals.tinyNotes).toEqual([
      { path: 'wiki/index.md', chars: 10 },
      { path: 'wiki/sizes/empty.md', chars: 0 },
      { path: 'wiki/sizes/tiny.md', chars: 199 },
    ]);
    expect(signals.oversizedFolders).toEqual([{
      path: 'wiki/big/', count: 31,
      files: Array.from({ length: 20 }, (_, index) => `wiki/big/${String(index).padStart(2, '0')}.md`),
    }]);
    expect(folders.map(({ path, files }) => [path, files.length])).toEqual([
      ['wiki/', 1], ['wiki/big/', 31], ['wiki/exact/', 30], ['wiki/exact/nested/', 1], ['wiki/sizes/', 5],
    ]);
  });

  it('includes index and empty orphans and resolves original target spelling, aliases, folders and ambiguity', async () => {
    const notes = {
      'wiki/source.md': '[[Missing.MD#section|alias]] [[missing|again]] [[Shared#heading]] [[wiki/a/Shared.md]] [[raw/reference]]',
      'wiki/a/Shared.md': 'A',
      'wiki/b/shared.md': 'B',
      'wiki/index.md': '[[source]]',
      'wiki/empty.md': '',
      'raw/reference.md': 'Reference',
    };
    const graph: CatalogGraph = {
      nodes: [],
      edges: [
        { from: 'wiki/source.md', to: 'wiki/a/Shared.md' },
        { from: 'wiki/index.md', to: 'wiki/source.md' },
        { from: 'raw/reference.md', to: 'wiki/b/shared.md' },
      ],
    };
    const { signals } = await fixture(notes, graph);
    expect(signals.orphans).toEqual(['wiki/empty.md', 'wiki/index.md']);
    expect(signals.unresolved).toEqual([{ path: 'wiki/source.md', target: 'Missing.MD' }]);
    expect(signals.ambiguous).toEqual([{
      path: 'wiki/source.md', target: 'Shared', candidates: ['wiki/a/Shared.md', 'wiki/b/shared.md'],
    }]);
  });

  it('resolves existing asset embeds across the full repository inventory', async () => {
    const { signals } = await fixture({
      'wiki/source.md': '![[ASSETS/IMAGE.PNG|image]] ![[image.png]] ![[source.pdf#page=2]] ![[diagram.svg]]',
      'assets/image.png': 'image',
      'raw/import/source.pdf': 'pdf',
      'diagram.svg': 'svg',
    });
    expect(signals.unresolved).toEqual([]);
    expect(signals.ambiguous).toEqual([]);
  });

  it('collects unresolved links from uppercase markdown source notes', async () => {
    const { signals, folders } = await fixture({
      'wiki/source.MD': '[[Missing]]',
    });
    expect(signals.unresolved).toEqual([{ path: 'wiki/source.MD', target: 'Missing' }]);
    expect(folders).toEqual([{ path: 'wiki/', files: ['wiki/source.MD'] }]);
  });

  it('retains matching asset paths for ambiguous embeds without misclassifying qualified embeds', async () => {
    const { signals } = await fixture({
      'wiki/source.md': '![[image.png]] ![[assets/image.png]]',
      'assets/image.png': 'image',
      'image.png': 'another image',
    });
    expect(signals.unresolved).toEqual([]);
    expect(signals.ambiguous).toEqual([{
      path: 'wiki/source.md', target: 'image.png', candidates: ['assets/image.png', 'image.png'],
    }]);
  });

  it('resolves markdown and extensionless targets only against notes, including dotted note names', async () => {
    const { signals } = await fixture({
      'wiki/source.md': '[[assets/Topic]] [[Topic.md]] [[wiki/Topic.v2.md]]',
      'assets/Topic': 'not a note',
      'wiki/Topic.v2.md': 'note',
      'wiki/Topic.v2': 'not a note',
    });
    expect(signals.unresolved).toEqual([
      { path: 'wiki/source.md', target: 'assets/Topic' },
      { path: 'wiki/source.md', target: 'Topic.md' },
    ]);
    expect(signals.ambiguous).toEqual([]);
  });

  it.each([
    [4, 0, false], [5, 2, true], [5, 3, false], [6, 3, false], [7, 3, true], [7, 4, false],
  ])('requires a hub for %i tagged notes with %i distinct linked notes: %s', async (count, linked, missing) => {
    const paths = Array.from({ length: count }, (_, index) => `wiki/topic/${index}.md`);
    const notes = Object.fromEntries([...paths.map((path) => [path, 'Body']), ['wiki/hub.md', 'Hub'], ['raw/hub.md', 'Raw hub']]);
    const graph: CatalogGraph = {
      nodes: paths.map((path) => ({ path, title: path, tags: ['topic', 'topic'] })),
      edges: [
        ...paths.slice(0, linked).flatMap((to) => [{ from: 'wiki/hub.md', to }, { from: 'wiki/hub.md', to }]),
        ...paths.map((to) => ({ from: 'raw/hub.md', to })),
      ],
    };
    const { signals } = await fixture(notes, graph);
    expect(signals.missingHubs).toEqual(missing ? [{ tag: 'topic', count, paths }] : []);
  });

  it('keeps comparison reason and score only for wiki pairs', async () => {
    const pair = (left: string, right: string, reason: DuplicateNotes['reason'], score: number): DuplicateNotes => ({
      left: { path: left, title: left }, right: { path: right, title: right }, reason, score, passages: [],
    });
    const { signals } = await fixture({ 'wiki/a.md': 'A', 'wiki/b.md': 'B', 'raw/a.md': 'A' }, undefined, [
      pair('wiki/a.md', 'raw/a.md', 'exact', 1), pair('wiki/a.md', 'wiki/b.md', 'semantic', 0.99),
    ]);
    expect(signals.duplicates).toEqual([{ left: 'wiki/a.md', right: 'wiki/b.md', reason: 'semantic', score: 0.99 }]);
  });

  it('caps every signal list and nested path sample while retaining the complete sweep inventory', async () => {
    const notes: Record<string, string> = {};
    const nodes: CatalogGraph['nodes'] = [];
    const tags = Array.from({ length: 25 }, (_, index) => `tag-${String(index).padStart(2, '0')}`);
    for (let index = 0; index < 25; index++) {
      const folder = `wiki/${String(index).padStart(2, '0')}/`;
      for (let file = 0; file < 31; file++) notes[`${folder}${String(file).padStart(2, '0')}.md`] = 'Body';
      const path = `${folder}shared.md`;
      notes[path] = `[[shared]] ${Array.from({ length: 25 }, (_, target) => `[[missing-${target}]]`).join(' ')} ${'x'.repeat(20_001)}`;
      nodes.push({ path, title: path, tags });
    }
    const { signals, folders } = await fixture(notes, { nodes, edges: [] });
    expect(signals.orphans).toEqual(Array.from({ length: 20 }, (_, index) => `wiki/00/${String(index).padStart(2, '0')}.md`));
    expect(signals.oversizedFolders).toHaveLength(20);
    expect(signals.oversizedFolders[0]).toMatchObject({ path: 'wiki/00/', count: 32, files: signals.orphans });
    expect(signals.oversizedNotes.map(({ path }) => path)).toEqual(Array.from({ length: 20 }, (_, index) => `wiki/${String(index).padStart(2, '0')}/shared.md`));
    expect(signals.tinyNotes.map(({ path }) => path)).toEqual(signals.orphans);
    expect(signals.unresolved).toEqual(Array.from({ length: 20 }, (_, target) => ({ path: 'wiki/00/shared.md', target: `missing-${target}` })));
    expect(signals.ambiguous).toHaveLength(20);
    expect(signals.ambiguous[0]!.candidates).toEqual(signals.oversizedNotes.map(({ path }) => path));
    expect(signals.missingHubs).toHaveLength(20);
    expect(signals.missingHubs[0]).toEqual({ tag: 'tag-00', count: 25, paths: signals.ambiguous[0]!.candidates });
    expect(folders.map(({ path }) => path)).toEqual(Array.from({ length: 25 }, (_, index) => `wiki/${String(index).padStart(2, '0')}/`));
    expect(selectDreamMode(emptySignals(), false, folders, new Map(folders.slice(0, 24).map(({ path }) => [path, '2026-10-01']))))
      .toEqual({ mode: 'sweep', focus: 'wiki/24/' });
  });
});

describe('structural signal scopes', () => {
  const signals = emptySignals({
    duplicates: [
      { ...duplicate, left: 'wiki/a/note.md', right: 'wiki/b/note.md' },
      { ...duplicate, left: 'wiki/c/one.md', right: 'wiki/c/two.md' },
    ],
    orphans: ['wiki/a/note.md', 'wiki/a/nested/note.md', 'wiki/b/note.md'],
    unresolved: [
      { path: 'wiki/a/note.md', target: 'missing' },
      { path: 'wiki/b/note.md', target: 'wiki/a/Removed.MD' },
      { path: 'wiki/c/one.md', target: 'other-missing' },
    ],
    ambiguous: [{ path: 'wiki/b/note.md', target: 'note', candidates: ['wiki/a/note.md', 'wiki/b/note.md'] }],
    oversizedFolders: [{ path: 'wiki/a/', count: 31, files: ['wiki/a/first.md'] }, { path: 'wiki/b/', count: 32, files: ['wiki/b/note.md'] }],
    oversizedNotes: [{ path: 'wiki/a/note.md', chars: 20_001 }, { path: 'wiki/b/note.md', chars: 20_001 }],
    tinyNotes: [{ path: 'wiki/a/nested/note.md', chars: 10 }, { path: 'wiki/b/note.md', chars: 10 }],
    missingHubs: [{ tag: 'topic', count: 5, paths: ['wiki/a/note.md', 'wiki/b/note.md'] }, { tag: 'other', count: 5, paths: ['wiki/c/one.md'] }],
  });

  it('retains repairs touching changed paths, including deleted targets and folder samples beyond the cap', () => {
    const scoped = restrictStructureSignals(signals, ['wiki/a/note.md', 'wiki/a/removed.md', 'wiki/a/last.md']);
    expect(scoped).toEqual({
      duplicates: [signals.duplicates[0]], orphans: ['wiki/a/note.md'],
      unresolved: signals.unresolved.slice(0, 2), ambiguous: signals.ambiguous,
      oversizedFolders: [signals.oversizedFolders[0]], oversizedNotes: [signals.oversizedNotes[0]], tinyNotes: [],
      missingHubs: [signals.missingHubs[0]],
    });
    expect(restrictStructureSignals(signals, [], [])).toEqual(emptySignals());
  });

  it('scopes sweeps to a single direct folder, not its descendants, without dropping related counterparts', () => {
    expect(restrictStructureSignals(signals, [], ['wiki/a/'])).toEqual({
      duplicates: [signals.duplicates[0]], orphans: ['wiki/a/note.md'],
      unresolved: signals.unresolved.slice(0, 2), ambiguous: signals.ambiguous,
      oversizedFolders: [signals.oversizedFolders[0]], oversizedNotes: [signals.oversizedNotes[0]], tinyNotes: [],
      missingHubs: [signals.missingHubs[0]],
    });
    expect(signals.orphans).toEqual(['wiki/a/note.md', 'wiki/a/nested/note.md', 'wiki/b/note.md']);
  });
});
