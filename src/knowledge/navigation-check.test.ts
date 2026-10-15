import { describe, expect, it } from 'vitest';
import { MEMORY_BUDGET_CHARS } from './memory.js';
import { navigationIssues } from './navigation-check.js';

function inspect(entries: Array<[string, string]>, changed: string[]) {
  return navigationIssues({ files: new Map(entries), changed });
}

const hub = 'wiki/growth/index.md';
const note = 'wiki/growth/strategy/experiments.md';
const linked: Array<[string, string]> = [
  ['index.md', `[[${hub}]]`],
  [hub, `실험을 설계할 때 [[${note}]]를 읽는다.`],
  [note, '# 실험'],
];

describe('navigationIssues', () => {
  it('reports a shallow domain note and its lack of inbound links', () => {
    const path = 'wiki/growth/x.md';
    const issues = inspect([...linked, [path, '# X']], [path]);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path, kind: 'shallow' }),
      expect.objectContaining({ path, kind: 'orphan' }),
    ]));
  });

  it('accepts a topic note linked from its domain hub without demanding full root reachability', () => {
    const path = 'wiki/concepts/experiment.md';
    expect(inspect([[path, '# 실험'], ['wiki/concepts/method.md', `[[${path}]]`]], [path])).toEqual([]);
    expect(inspect(linked, [note])).toEqual([]);
  });

  it('reports missing domain hubs and existing hubs missing from the root index', () => {
    expect(inspect([[note, '# 실험']], [note])).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: hub, kind: 'missing-hub' }),
    ]));
    expect(inspect(linked.map(([path, content]) => [path, path === 'index.md' ? '# 목차' : content]), [note]))
      .toEqual([expect.objectContaining({ path: hub, kind: 'hub-unlinked' })]);
    expect(inspect(linked.filter(([path]) => path !== hub), [hub]))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: hub, kind: 'missing-hub' })]));
  });

  it('does not report unchanged placement, orphan, link or domain problems elsewhere', () => {
    expect(inspect([...linked, ['wiki/other/shallow.md', '[[missing]]'], ['wiki/unclassified.md', '# Old']], [note]))
      .toEqual([]);
  });

  it('does not count self links or domain schema links as wiki-note inbound links', () => {
    const path = 'wiki/concepts/alone.md';
    expect(inspect([
      [path, `[[${path}]]`], ['wiki/growth/AGENTS.md', `[[${path}]]`],
    ], [path])).toEqual([expect.objectContaining({ path, kind: 'orphan' })]);
  });

  it('counts a root index link as a curated inbound path', () => {
    const path = 'wiki/concepts/featured.md';
    expect(inspect([[path, '# Featured'], ['index.md', `[[${path}]]`]], [path])).toEqual([]);
  });

  it('resolves aliases, attachments, embeds and qualified links using the shared resolver', () => {
    const path = 'wiki/concepts/linked.md';
    const entries: Array<[string, string]> = [
      [path, '[[별칭]] ![[assets/chart.png]] [[wiki/entities/tool#Usage|도구]] [[Missing]] [[Ambiguous]]'],
      ['wiki/concepts/source.md', `[[${path}]]`],
      ['wiki/entities/tool.md', '---\naliases: [별칭]\n---\n# Tool'],
      ['wiki/concepts/one.md', '---\naliases: [Ambiguous]\n---\n'],
      ['wiki/concepts/two.md', '---\naliases: [Ambiguous]\n---\n'],
      ['assets/chart.png', ''],
    ];
    const issues = inspect(entries, [path]);
    expect(issues).toHaveLength(2);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path, kind: 'broken-link', message: expect.stringContaining('Missing') }),
      expect.objectContaining({ path, kind: 'broken-link', message: expect.stringContaining('Ambiguous') }),
    ]));
  });

  it('reports placement depth, invalid ancestor names and unclassified notes only for changed paths', () => {
    const paths = ['wiki/unfiled.md', 'wiki/growth/strategy/topic/deeper/file.md', 'wiki/growth/Batch-1/file.md'];
    const issues = inspect(paths.map(path => [path, '# Note']), paths);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: paths[0], kind: 'unclassified' }),
      expect.objectContaining({ path: paths[1], kind: 'too-deep' }),
      expect.objectContaining({ path: 'wiki/growth/Batch-1/', kind: 'folder-name' }),
    ]));
  });

  it('reports memory budget violations only when memory changes', () => {
    const memory = `## 작업 관례\n${'가'.repeat(MEMORY_BUDGET_CHARS)}\n## 진행 중\n\n## 참조\n`;
    expect(inspect([['MEMORY.md', memory]], ['MEMORY.md']))
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'MEMORY.md', kind: 'memory' })]));
    expect(inspect([['MEMORY.md', memory]], [])).toEqual([]);
    expect(inspect([], ['MEMORY.md'])).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'memory' })]));
  });
});
