import { describe, expect, it } from 'vitest';
import type { KnowledgeRepo } from '../knowledge/repo.js';
import type { CatalogGraph, CatalogService } from '../rag/catalog.service.js';
import type { ComparisonService, DuplicateNotes } from '../rag/comparison.service.js';
import { collectStructureSignals, restrictStructureSignals, selectDreamMode, type StructureSignals } from './structure-signals.js';

function emptySignals(overrides: Partial<StructureSignals> = {}): StructureSignals {
  return {
    duplicates: [], orphans: [], unresolved: [], ambiguous: [], oversizedFolders: [], oversizedNotes: [],
    tinyNotes: [], missingHubs: [], missingDomainHubs: [], unlinkedDomainHubs: [], unclassifiedNotes: [],
    shallowDomainNotes: [], tooDeepNotes: [], invalidFolderNames: [],
    invalidMetadata: [], invalidMetadataCount: 0, memoryIssues: [], ...overrides,
  };
}

function fixture(notes: Record<string, string>, graph: CatalogGraph = { nodes: [], edges: [] }, duplicates: DuplicateNotes[] = []) {
  const repo = {
    diffNames: async (fromSha: string | null) => fromSha === null
      ? Object.keys(notes).map((path) => ({ path, status: 'A' }))
      : [],
    readFile: async (path: string) => {
      if (!/\.md$/i.test(path)) throw new Error(`Binary contents must not be read: ${path}`);
      return notes[path] ?? null;
    },
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
    { oversizedFolders: [{ path: 'wiki/', count: 16, files: ['wiki/index.md'] }] },
    { ambiguous: [{ path: 'wiki/a.md', target: 'shared', candidates: ['wiki/x/shared.md', 'wiki/y/shared.md'] }] },
    { unresolved: Array.from({ length: 5 }, (_, index) => ({ path: 'wiki/a.md', target: `missing-${index}` })) },
    { missingHubs: [{ tag: 'topic', count: 5, paths: ['wiki/a.md'] }] },
    { missingDomainHubs: ['wiki/engineering/index.md'] },
    { unlinkedDomainHubs: ['wiki/research/index.md'] },
    { unclassifiedNotes: ['wiki/loose.md'] },
    { shallowDomainNotes: ['wiki/engineering/cache.md'] },
    { tooDeepNotes: ['wiki/engineering/backend/cache/eviction/policy.md'] },
    { invalidFolderNames: [{ path: 'wiki/batch18/', reason: '배치 번호' }] },
    { invalidMetadataCount: 1, invalidMetadata: [{ path: 'wiki/concepts/cache.md', issues: [{ field: 'tags', message: '필수 속성이 없다' }] }] },
    { memoryIssues: ["MEMORY.md에 '## 참조' 섹션이 필요하다."] },
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
  const semanticMetadata = 'type: concept\naliases: []\ndescription: "캐시 개념을 설명한다."\ntags: [cache]';
  const validMetadata = `${semanticMetadata}\nauthor: [도니]\ndate created: 2026-10-01\ndate modified: 2026-10-10`;
  const metadataNote = (metadata: string) => `---\n${metadata}\n---\n# 캐시\n\n캐시 개념을 설명한다.`;

  it.each([
    { content: '# Legacy memory', count: 4 },
    { content: `# Memory\n## 작업 관례\n## 진행 중\n## 참조\n${'a'.repeat(4001)}`, count: 1 },
  ])('selects structural mode for committed memory violations without other input', async ({ content, count }) => {
    const { signals, folders } = await fixture({ 'MEMORY.md': content });
    expect(signals.memoryIssues).toHaveLength(count);
    expect(selectDreamMode(signals, false, folders, new Map())).toEqual({ mode: 'structural', focus: null });
    expect(restrictStructureSignals(signals, [], []).memoryIssues).toEqual(signals.memoryIssues);
    expect(restrictStructureSignals(signals, [], ['wiki/concepts/']).memoryIssues).toEqual(signals.memoryIssues);
  });

  it('keeps clean idle runs skipped with valid or absent memory', async () => {
    const snapshots: Record<string, string>[] = [{}, { 'MEMORY.md': '# Memory\n## 작업 관례\n## 진행 중\n## 참조\n' }];
    for (const notes of snapshots) {
      const { signals, folders } = await fixture(notes);
      expect(signals.memoryIssues).toEqual([]);
      expect(selectDreamMode(signals, false, folders, new Map())).toEqual({ mode: null, focus: null });
    }
  });

  it('resolves frontmatter aliases from the complete committed note snapshot', async () => {
    const { signals } = await fixture({
      'wiki/concepts/source.md': '[[CACHE TERM#Overview|Cache]] [[raw alias]]',
      'wiki/concepts/cache.md': metadataNote(semanticMetadata.replace('aliases: []', 'aliases: [" cache term ", "CACHE TERM"]')),
      'raw/reference.md': '---\naliases: ["raw alias"]\n---\n# Original reference',
    });
    expect(signals.unresolved).toEqual([]);
    expect(signals.ambiguous).toEqual([]);
  });

  it('derives orphan inbound links from other committed wiki notes rather than stale catalog edges', async () => {
    const { signals } = await fixture({
      'index.md': '[[wiki/engineering/index]] [[wiki/concepts/root-only]]',
      'wiki/engineering/index.md': '[[Canonical Term]]',
      'wiki/engineering/AGENTS.md': '[[wiki/concepts/schema-only]]',
      'wiki/concepts/linked.md': '---\naliases: ["Canonical Term"]\n---\nLinked',
      'wiki/concepts/root-only.md': 'Root-only inbound',
      'wiki/concepts/schema-only.md': 'Schema-only inbound',
      'wiki/concepts/self.md': '[[wiki/concepts/self]]',
      'wiki/concepts/stale.md': 'Catalog-only inbound',
      'wiki/concepts/cycle-one.md': '[[wiki/concepts/cycle-two]]',
      'wiki/concepts/cycle-two.md': '[[wiki/concepts/cycle-one]]',
      'raw/reference.md': '[[wiki/concepts/stale]]',
    }, { nodes: [], edges: [
      { from: 'wiki/engineering/index.md', to: 'wiki/concepts/stale.md' },
      { from: 'raw/reference.md', to: 'wiki/concepts/root-only.md' },
    ] });
    expect(signals.orphans).toEqual([
      'wiki/concepts/schema-only.md', 'wiki/concepts/self.md', 'wiki/concepts/stale.md',
    ]);
    expect(signals.unlinkedDomainHubs).toEqual([]);
  });

  it('reports ambiguous aliases with all candidate paths while retaining exact basename precedence', async () => {
    const { signals } = await fixture({
      'wiki/concepts/source.md': '[[Shared Alias|Display]] [[cache]]',
      'wiki/concepts/one.md': metadataNote(semanticMetadata.replace('aliases: []', 'aliases: ["shared alias", "cache"]')),
      'wiki/concepts/two.md': metadataNote(semanticMetadata.replace('aliases: []', 'aliases: ["shared alias"]')),
      'wiki/concepts/cache.md': metadataNote(semanticMetadata),
    });
    expect(signals.unresolved).toEqual([]);
    expect(signals.ambiguous).toEqual([{
      path: 'wiki/concepts/source.md', target: 'Shared Alias',
      candidates: ['wiki/concepts/one.md', 'wiki/concepts/two.md'],
    }]);
  });

  it('recognizes root hub links through unique aliases but not ambiguous hub aliases', async () => {
    const { signals } = await fixture({
      'index.md': '[[Engineering HQ]] [[Domain HQ]]',
      'wiki/engineering/index.md': '---\naliases: ["Engineering HQ"]\n---\n# Engineering',
      'wiki/research/index.md': '---\naliases: ["Domain HQ"]\n---\n# Research',
      'wiki/health/index.md': '---\naliases: ["Domain HQ"]\n---\n# Health',
    });
    expect(signals.missingDomainHubs).toEqual([]);
    expect(signals.unlinkedDomainHubs).toEqual(['wiki/health/index.md', 'wiki/research/index.md']);
  });

  it('does not use note aliases to resolve attachment targets or malformed alias frontmatter', async () => {
    const { signals } = await fixture({
      'wiki/concepts/source.md': '![[guide.pdf]] [[Broken Alias]]',
      'wiki/concepts/guide.md': '---\naliases: ["guide.pdf"]\n---\n# Guide',
      'wiki/concepts/broken.md': '---\naliases: [Broken Alias\n---\n# Invalid YAML',
    });
    expect(signals.unresolved).toEqual([
      { path: 'wiki/concepts/source.md', target: 'guide.pdf' },
      { path: 'wiki/concepts/source.md', target: 'Broken Alias' },
    ]);
    expect(signals.ambiguous).toEqual([]);
  });

  it('reports semantic metadata errors from wiki notes while excluding schemas and other roots', async () => {
    const { signals } = await fixture({
      'wiki/concepts/cache.md': metadataNote(`${validMetadata}\nupdated: 2026-10-01\nstatus: draft`),
      'wiki/entities/tool.md': metadataNote(validMetadata),
      'wiki/engineering/AGENTS.md': 'Schema without metadata',
      'wiki/concepts/AGENTS.md': 'Shared schema without metadata',
      'wiki/engineering/nested/AGENTS.md': 'Nested instructions without metadata',
      'raw/source.md': 'Source without metadata',
      'journal/2026-10-10.md': 'Journal without metadata',
      'index.md': 'Root without metadata',
    });
    expect(signals.invalidMetadataCount).toBe(2);
    expect(signals.invalidMetadata).toEqual([
      { path: 'wiki/concepts/cache.md', issues: [
        { field: 'status', message: '사용하지 않는 속성이다' },
        { field: 'updated', message: '사용하지 않는 속성이다' },
      ] },
      { path: 'wiki/entities/tool.md', issues: [{ field: 'type', message: '이 위치의 노트는 entity여야 한다' }] },
    ]);
  });

  it('ignores absent or invalid engine fields but keeps other errors on the same note', async () => {
    const { signals } = await fixture({
      'wiki/concepts/complete.md': metadataNote(`${validMetadata}\narxiv: "2601.00001"`),
      'wiki/concepts/missing-engine.md': metadataNote(semanticMetadata),
      'wiki/concepts/invalid-engine.md': metadataNote(`${semanticMetadata}\nauthor: bot\ndate created: wrong\ndate modified: yesterday`),
      'wiki/concepts/needs-tags.md': metadataNote('type: concept\naliases: []\ndescription: "태그가 없는 캐시 개념이다."'),
    });
    expect(signals.invalidMetadataCount).toBe(1);
    expect(signals.invalidMetadata).toEqual([
      { path: 'wiki/concepts/needs-tags.md', issues: [{ field: 'tags', message: '필수 속성이 없다' }] },
    ]);
  });

  it('has no metadata signal for valid notes or notes waiting only for engine autofill', async () => {
    const { signals } = await fixture({
      'wiki/concepts/complete.md': metadataNote(validMetadata),
      'wiki/concepts/engine-pending.md': metadataNote(semanticMetadata),
    });
    expect(signals.invalidMetadata).toEqual([]);
    expect(signals.invalidMetadataCount).toBe(0);
    expect(selectDreamMode(signals, true, [], new Map())).toEqual({ mode: 'local', focus: null });
  });

  it('reports malformed YAML without aborting size and link inspection', async () => {
    const { signals } = await fixture({
      'wiki/concepts/cache.md': '---\naliases: [broken\n---\n# Cache\n[[Missing]]',
    });
    expect(signals.invalidMetadata).toEqual([
      { path: 'wiki/concepts/cache.md', issues: [{ field: 'frontmatter', message: 'frontmatter YAML를 해석할 수 없다' }] },
    ]);
    expect(signals.invalidMetadataCount).toBe(1);
    expect(signals.unresolved).toEqual([{ path: 'wiki/concepts/cache.md', target: 'Missing' }]);
  });

  it('caps metadata candidates at twenty sorted paths while reporting the whole backlog', async () => {
    const notes = Object.fromEntries(Array.from({ length: 25 }, (_, index) =>
      [`wiki/concepts/${String(index).padStart(2, '0')}.md`, '# Legacy cache']));
    const { signals } = await fixture(notes);
    expect(signals.invalidMetadataCount).toBe(25);
    expect(signals.invalidMetadata.map(({ path }) => path)).toEqual(Object.keys(notes).slice(0, 20));
    expect(signals.invalidMetadata.every(({ issues }) => issues.map(({ field }) => field).join(',')
      === 'type,aliases,description,tags')).toBe(true);
  });

  it('finds missing domain hubs without treating shared folders or nested folders as domains', async () => {
    const { signals } = await fixture({
      'wiki/engineering/nested/guide.md': 'Guide',
      'wiki/research/AGENTS.md': 'Paper rules',
      'wiki/health/index.md': 'Health hub',
      'wiki/concepts/term.md': 'Term',
      'wiki/entities/tool.md': 'Tool',
      'index.md': '[[wiki/health/index]]',
    });
    expect(signals.missingDomainHubs).toEqual(['wiki/engineering/index.md', 'wiki/research/index.md']);
    expect(signals.unlinkedDomainHubs).toEqual([]);
    expect(signals.missingHubs).toEqual([]);
  });

  it('discovers schema-only domains without treating their schema as a note or sweep candidate', async () => {
    const { signals, folders } = await fixture({
      'AGENTS.md': 'Root schema',
      'wiki/research/AGENTS.md': 'Domain schema [[Missing example]]',
    });
    expect(signals).toEqual(emptySignals({ missingDomainHubs: ['wiki/research/index.md'] }));
    expect(folders).toEqual([]);
  });

  it('finds domain hubs absent from root index, even when another note links them, without duplicating orphans', async () => {
    const { signals } = await fixture({
      'index.md': '[[INDEX|ambiguous]] [[wiki/engineering/index]]',
      'wiki/engineering/index.md': 'Engineering hub',
      'wiki/research/index.md': 'Research hub',
      'wiki/research/note.md': '[[wiki/research/index]]',
    }, { nodes: [], edges: [{ from: 'wiki/research/note.md', to: 'wiki/research/index.md' }] });
    expect(signals.missingDomainHubs).toEqual([]);
    expect(signals.unlinkedDomainHubs).toEqual(['wiki/research/index.md']);
    expect(signals.orphans).toEqual(['wiki/research/note.md']);
  });

  it('resolves root hub wikilinks with aliases, headings and case-insensitive qualified paths', async () => {
    const { signals } = await fixture({
      'index.md': '[[WIKI/ENGINEERING/INDEX.MD#Overview|Engineering]] [[wiki/research/index|Research]]',
      'wiki/engineering/index.md': 'Engineering hub',
      'wiki/research/index.md': 'Research hub',
    });
    expect(signals.missingDomainHubs).toEqual([]);
    expect(signals.unlinkedDomainHubs).toEqual([]);
  });

  it('reports existing hubs when root index is absent', async () => {
    const { signals } = await fixture({ 'wiki/engineering/index.md': 'Engineering hub' });
    expect(signals.unlinkedDomainHubs).toEqual(['wiki/engineering/index.md']);
  });

  it('classifies only markdown directly under wiki, including legacy index and uppercase extensions', async () => {
    const { signals } = await fixture({
      'wiki/.gitkeep': '',
      'wiki/image.png': 'image',
      'wiki/legacy.MD': 'Legacy note',
      'wiki/index.md': 'Legacy index',
      'wiki/engineering/guide.md': 'Guide',
      'wiki/concepts/term.md': 'Term',
      'wiki/entities/tool.md': 'Tool',
      'raw/source.md': 'Source',
      'index.md': 'Root index',
    });
    expect(signals.unclassifiedNotes).toEqual(['wiki/index.md', 'wiki/legacy.MD']);
    const clean = await fixture({
      'wiki/.gitkeep': '',
      'wiki/concepts/term.md': 'Term',
      'wiki/entities/tool.md': 'Tool',
      'wiki/engineering/index.md': 'Hub',
      'index.md': '[[wiki/engineering/index]]',
    });
    expect(clean.signals.unclassifiedNotes).toEqual([]);
  });

  it('enforces subject depth while exempting domain hubs, schemas and flat shared notes', async () => {
    const { signals } = await fixture({
      'wiki/donidoeji/얕은 노트.MD': 'Shallow',
      'wiki/donidoeji/index.md': 'Hub',
      'wiki/donidoeji/AGENTS.md': 'Schema',
      'wiki/donidoeji/crm/기본 노트.md': 'Topic',
      'wiki/donidoeji/crm/rewards/허용 노트.md': 'Subtopic',
      'wiki/donidoeji/crm/rewards/mobile/깊은 노트.MD': 'Too deep',
      'wiki/concepts/평평한 정본.md': 'Shared',
      'wiki/concepts/cache/주제 정본.md': 'Shared topic',
      'wiki/concepts/cache/expiry/깊은 정본.md': 'Too deep shared',
      'wiki/entities/정본.md': 'Entity',
      'wiki/entities/people/인물.md': 'Entity topic',
      'wiki/entities/people/team/깊은 인물.md': 'Too deep entity',
      'wiki/미분류.md': 'Unclassified',
    });
    expect(signals.shallowDomainNotes).toEqual(['wiki/donidoeji/얕은 노트.MD']);
    expect(signals.tooDeepNotes).toEqual([
      'wiki/concepts/cache/expiry/깊은 정본.md',
      'wiki/donidoeji/crm/rewards/mobile/깊은 노트.MD',
      'wiki/entities/people/team/깊은 인물.md',
    ]);
    expect(signals.unclassifiedNotes).toEqual(['wiki/미분류.md']);
  });

  it('reports invalid folder names at every level, including attachment-only ancestors', async () => {
    const { signals } = await fixture({
      'wiki/돈이돼지 batch18/a/노트.md': 'Imported',
      'wiki/donidoeji/crm/사람이 읽는 제목.md': 'Valid',
      'wiki/donidoeji/2026/image.png': 'Attachment',
      'wiki/donidoeji/2026-10/note.md': 'Month',
      'wiki/donidoeji/2026-10-15/note.md': 'Date',
      'wiki/donidoeji/batch18/part-2/chunk3/note.md': 'Batch',
      'wiki/donidoeji/crm/Bad_Name/note.md': 'Invalid nested',
      'wiki/entities/people/a/image.png': 'Single-letter attachment folder',
      'raw/2026/a/source.md': 'Not wiki',
    });
    expect(signals.invalidFolderNames.map(({ path }) => path)).toEqual([
      'wiki/donidoeji/2026-10-15/', 'wiki/donidoeji/2026-10/', 'wiki/donidoeji/2026/',
      'wiki/donidoeji/batch18/', 'wiki/donidoeji/batch18/part-2/', 'wiki/donidoeji/batch18/part-2/chunk3/',
      'wiki/donidoeji/crm/Bad_Name/', 'wiki/entities/people/a/', 'wiki/돈이돼지 batch18/', 'wiki/돈이돼지 batch18/a/',
    ]);
    expect(signals.invalidFolderNames.every(({ reason }) => reason.length > 0)).toBe(true);
  });

  it('caps new depth and name signals at twenty sorted paths', async () => {
    const notes: Record<string, string> = {};
    for (let index = 0; index < 25; index++) {
      const number = String(index).padStart(2, '0');
      notes[`wiki/donidoeji/shallow-${number}.md`] = 'Shallow';
      notes[`wiki/donidoeji/crm/rewards/mobile/deep-${number}.md`] = 'Deep';
      notes[`wiki/donidoeji/batch${number}/note.md`] = 'Batch';
    }
    const { signals } = await fixture(notes);
    expect(signals.shallowDomainNotes).toEqual(Array.from({ length: 20 }, (_, index) =>
      `wiki/donidoeji/shallow-${String(index).padStart(2, '0')}.md`));
    expect(signals.tooDeepNotes).toEqual(Array.from({ length: 20 }, (_, index) =>
      `wiki/donidoeji/crm/rewards/mobile/deep-${String(index).padStart(2, '0')}.md`));
    expect(signals.invalidFolderNames.map(({ path }) => path)).toEqual(Array.from({ length: 20 }, (_, index) =>
      `wiki/donidoeji/batch${String(index).padStart(2, '0')}/`));
  });

  it('caps domain hygiene signals at twenty sorted paths', async () => {
    const notes: Record<string, string> = {};
    for (let index = 0; index < 25; index++) {
      const name = String(index).padStart(2, '0');
      notes[`wiki/missing-${name}/note.md`] = 'Note';
      notes[`wiki/unlinked-${name}/index.md`] = 'Hub';
      notes[`wiki/loose-${name}.md`] = 'Loose';
    }
    const { signals } = await fixture(notes);
    expect(signals.missingDomainHubs).toEqual(Array.from({ length: 20 }, (_, index) =>
      `wiki/missing-${String(index).padStart(2, '0')}/index.md`));
    expect(signals.unlinkedDomainHubs).toEqual(Array.from({ length: 20 }, (_, index) =>
      `wiki/unlinked-${String(index).padStart(2, '0')}/index.md`));
    expect(signals.unclassifiedNotes).toEqual(Array.from({ length: 20 }, (_, index) =>
      `wiki/loose-${String(index).padStart(2, '0')}.md`));
  });

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
    for (let index = 0; index < 15; index++) notes[`wiki/exact/${String(index).padStart(2, '0')}.md`] = 'x'.repeat(200);
    for (let index = 0; index < 16; index++) notes[`wiki/big/${String(index).padStart(2, '0')}.md`] = 'x'.repeat(200);
    notes['wiki/exact/nested/note.md'] = 'x'.repeat(200);
    const { signals, folders } = await fixture(notes);
    expect(signals.oversizedNotes).toEqual([{ path: 'wiki/sizes/oversized.md', chars: 20_001 }]);
    expect(signals.tinyNotes).toEqual([
      { path: 'wiki/index.md', chars: 10 },
      { path: 'wiki/sizes/empty.md', chars: 0 },
      { path: 'wiki/sizes/tiny.md', chars: 199 },
    ]);
    expect(signals.oversizedFolders).toEqual([{
      path: 'wiki/big/', count: 16,
      files: Array.from({ length: 16 }, (_, index) => `wiki/big/${String(index).padStart(2, '0')}.md`),
    }]);
    expect(folders.map(({ path, files }) => [path, files.length])).toEqual([
      ['wiki/', 1], ['wiki/big/', 16], ['wiki/exact/', 15], ['wiki/exact/nested/', 1], ['wiki/sizes/', 5],
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
    expect(signals.orphans).toEqual(['wiki/b/shared.md', 'wiki/empty.md', 'wiki/index.md']);
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
      missingDomainHubs: [], unlinkedDomainHubs: [], unclassifiedNotes: [],
      shallowDomainNotes: [], tooDeepNotes: [], invalidFolderNames: [],
      invalidMetadata: [], invalidMetadataCount: 0, memoryIssues: [],
    });
    expect(restrictStructureSignals(signals, [], [])).toEqual(emptySignals());
  });

  it('scopes sweeps to a single direct folder, not its descendants, without dropping related counterparts', () => {
    expect(restrictStructureSignals(signals, [], ['wiki/a/'])).toEqual({
      duplicates: [signals.duplicates[0]], orphans: ['wiki/a/note.md'],
      unresolved: signals.unresolved.slice(0, 2), ambiguous: signals.ambiguous,
      oversizedFolders: [signals.oversizedFolders[0]], oversizedNotes: [signals.oversizedNotes[0]], tinyNotes: [],
      missingHubs: [signals.missingHubs[0]],
      missingDomainHubs: [], unlinkedDomainHubs: [], unclassifiedNotes: [],
      shallowDomainNotes: [], tooDeepNotes: [], invalidFolderNames: [],
      invalidMetadata: [], invalidMetadataCount: 0, memoryIssues: [],
    });
    expect(signals.orphans).toEqual(['wiki/a/note.md', 'wiki/a/nested/note.md', 'wiki/b/note.md']);
  });

  it('scopes domain hygiene to the containing domain and root-index linkage edits', () => {
    const domains = emptySignals({
      missingDomainHubs: ['wiki/a/index.md', 'wiki/b/index.md'],
      unlinkedDomainHubs: ['wiki/a/index.md', 'wiki/c/index.md'],
      unclassifiedNotes: ['wiki/loose.md', 'wiki/other.md'],
    });
    expect(restrictStructureSignals(domains, ['wiki/a/nested/note.md'])).toEqual(emptySignals({
      missingDomainHubs: ['wiki/a/index.md'], unlinkedDomainHubs: ['wiki/a/index.md'],
    }));
    expect(restrictStructureSignals(domains, [], ['wiki/b/nested/'])).toEqual(emptySignals({
      missingDomainHubs: ['wiki/b/index.md'],
    }));
    expect(restrictStructureSignals(domains, ['index.md'])).toEqual(emptySignals({
      unlinkedDomainHubs: domains.unlinkedDomainHubs,
    }));
    expect(restrictStructureSignals(domains, ['wiki/loose.md'])).toEqual(emptySignals({
      unclassifiedNotes: ['wiki/loose.md'],
    }));
  });

  it('keeps only direct placement candidates and invalid ancestor folders for local and sweep scopes', () => {
    const placement = emptySignals({
      shallowDomainNotes: ['wiki/donidoeji/loose.md', 'wiki/health/loose.md'],
      tooDeepNotes: [
        'wiki/donidoeji/crm/rewards/mobile/note.md',
        'wiki/donidoeji/crm/rewards/mobile/nested/note.md',
        'wiki/health/habits/daily/morning/note.md',
      ],
      invalidFolderNames: [
        'wiki/돈이돼지 batch18/', 'wiki/돈이돼지 batch18/a/', 'wiki/돈이돼지 batch18/a/b/',
        'wiki/돈이돼지 batch18/b/', 'wiki/health/2026-10/',
      ].map((path) => ({ path, reason: 'Invalid folder' })),
    });
    expect(restrictStructureSignals(placement, ['wiki/donidoeji/loose.md'])).toEqual(emptySignals({
      shallowDomainNotes: ['wiki/donidoeji/loose.md'],
    }));
    expect(restrictStructureSignals(placement, [], ['wiki/donidoeji/crm/rewards/mobile/'])).toEqual(emptySignals({
      tooDeepNotes: ['wiki/donidoeji/crm/rewards/mobile/note.md'],
    }));
    const expected = emptySignals({ invalidFolderNames: placement.invalidFolderNames.slice(0, 2) });
    expect(restrictStructureSignals(placement, ['wiki/돈이돼지 batch18/a/note.md'])).toEqual(expected);
    expect(restrictStructureSignals(placement, [], ['wiki/돈이돼지 batch18/a/'])).toEqual(expected);
    expect(restrictStructureSignals(placement, [], ['wiki/돈이돼지 batch18/'])).toEqual(emptySignals({
      invalidFolderNames: [placement.invalidFolderNames[0]!],
    }));
    expect(restrictStructureSignals(placement, ['index.md'])).toEqual(emptySignals());
  });

  it('scopes metadata candidates to direct notes but preserves the inspected-main backlog count', () => {
    const metadata = emptySignals({
      invalidMetadataCount: 25,
      invalidMetadata: ['wiki/a/note.md', 'wiki/a/nested/note.md', 'wiki/b/note.md'].map((path) =>
        ({ path, issues: [{ field: 'tags', message: '필수 속성이 없다' }] })),
    });
    expect(restrictStructureSignals(metadata, [], ['wiki/a/'])).toEqual(emptySignals({
      invalidMetadata: [metadata.invalidMetadata[0]!], invalidMetadataCount: 25,
    }));
    expect(restrictStructureSignals(metadata, ['wiki/b/note.md'])).toEqual(emptySignals({
      invalidMetadata: [metadata.invalidMetadata[2]!], invalidMetadataCount: 25,
    }));
  });
});
