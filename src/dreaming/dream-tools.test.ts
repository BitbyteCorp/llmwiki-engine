import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AclService } from '../acl/acl.service.js';
import type { AclRule } from '../acl/acl.types.js';
import type { AgentTool } from '../agent/agent.types.js';
import { repoPath } from '../knowledge/repo.js';
import { guardDreamTools, unresolvedLinkTargets } from './dream-tools.js';

const writeArgs = z.object({ path: z.string(), content: z.string() });
const deleteArgs = z.object({ path: z.string() });
const moveArgs = z.object({ from: z.string(), to: z.string() });

function fixture(
  initial: Record<string, string>,
  prefixes: readonly string[] = [],
  limit?: number,
  beforeStructuralChange: () => Promise<void> = async () => {},
) {
  const files = new Map(Object.entries(initial));
  const rules: AclRule[] = prefixes.map((prefix, index) => ({
    id: index + 1, prefix, subjectType: 'everyone', subject: '', access: 'read',
    createdBy: 1, createdAt: '2026-10-01T00:00:00.000Z',
  }));
  const acl: Pick<AclService, 'list'> = { list: () => rules };
  const tools: AgentTool[] = [
    {
      name: 'write_file', description: 'Replace a note', parameters: {},
      async run(args) {
        const { path, content } = writeArgs.parse(args);
        files.set(repoPath(path), content);
        return 'written';
      },
    },
    {
      name: 'delete_file', description: 'Delete a note', parameters: {},
      async run(args) {
        const path = repoPath(deleteArgs.parse(args).path);
        await beforeStructuralChange();
        if (!files.delete(path)) throw new Error(`Missing source: ${path}`);
        return 'deleted';
      },
    },
    {
      name: 'move_file', description: 'Move a note', parameters: {},
      async run(args) {
        const input = moveArgs.parse(args);
        const from = repoPath(input.from);
        const to = repoPath(input.to);
        await beforeStructuralChange();
        const content = files.get(from);
        if (content === undefined) throw new Error(`Missing source: ${from}`);
        if (files.has(to)) throw new Error(`Destination exists: ${to}`);
        files.set(to, content);
        files.delete(from);
        return 'moved';
      },
    },
  ];
  const guarded = guardDreamTools(tools, acl, limit);
  const run = (name: string, args: unknown) => guarded.tools.find((tool) => tool.name === name)!.run(args);
  return { files, changes: guarded.changes, run };
}

describe('dream structural guards', () => {
  it.each([
    ['folder boundary', ['wiki/private/'], 'wiki/private/a.md', 'wiki/public/a.md'],
    ['nested boundary with identical access', ['/', 'wiki/', 'wiki/private/'], 'wiki/private/a.md', 'wiki/a.md'],
    ['exact file boundary', ['wiki/a.md'], 'wiki/a.md', 'wiki/b.md'],
    ['folder prefix boundary', ['wiki/private/'], 'wiki/private/a.md', 'wiki/private-other/a.md'],
    ['file prefix boundary', ['wiki/a.md'], 'wiki/a.md', 'wiki/a.md.backup'],
    ['case-sensitive ACL boundary', ['wiki/private/'], 'wiki/private/a.md', 'Wiki/private/a.md'],
  ] as const)('rejects a move across the %s', async (_label, prefixes, from, to) => {
    const f = fixture({ [from]: 'restricted knowledge' }, prefixes);
    await expect(f.run('move_file', { from, to })).rejects.toThrow(/ACL|boundar|zone/i);
    expect([...f.files]).toEqual([[from, 'restricted knowledge']]);
    expect(f.changes()).toEqual([]);
  });

  it.each([
    ['unrestricted notes', [], 'wiki/a.md', 'archive/a.md'],
    ['root ACL', ['/'], 'wiki/a.md', 'archive/a.md'],
    ['same nested zone', ['/', 'wiki/', 'wiki/private/'], 'wiki/private/a.md', 'wiki/private/deeper/a.md'],
    ['outside an exact file rule', ['wiki/special.md'], 'wiki/special.md.backup', 'wiki/ordinary.md'],
    ['outside a folder prefix', ['wiki/private/'], 'wiki/private-other/a.md', 'wiki/public/a.md'],
    ['case-sensitive unmatched folders', ['wiki/private/'], 'Wiki/private/a.md', 'wiki/public/a.md'],
  ] as const)('allows a move between %s', async (_label, prefixes, from, to) => {
    const f = fixture({ [from]: 'retained knowledge' }, prefixes);
    await f.run('move_file', { from, to });
    expect([...f.files]).toEqual([[to, 'retained knowledge']]);
    expect(f.changes()).toEqual([{ kind: 'move', from, to }]);
  });

  it.each([
    'index.md', 'INDEX.MD', 'MEMORY.md', 'memory.MD', 'AGENTS.md', 'agents.MD',
    'wiki/health/AGENTS.md', 'wiki/health/agents.MD', './wiki//health/./AGENTS.md',
    './WiKi//HeAlTh/./aGeNtS.Md',
    'journal/day.md', './JoUrNaL//day.md', 'journal', 'JOURNAL',
    'raw/source.md', './raw//x.md', 'RAW/source.md', 'raw', 'RAW',
  ])('preserves protected structural path %s as source, destination, and deletion target', async (path) => {
    const canonical = repoPath(path);
    const source = fixture({ [canonical]: 'protected', 'wiki/a.md': 'ordinary' });
    await expect(source.run('move_file', { from: path, to: 'wiki/moved.md' })).rejects.toThrow(/protect|immutable|reserved/i);
    await expect(source.run('delete_file', { path })).rejects.toThrow(/protect|immutable|reserved/i);
    expect([...source.files]).toEqual([[canonical, 'protected'], ['wiki/a.md', 'ordinary']]);
    expect(source.changes()).toEqual([]);

    const destination = fixture({ 'wiki/a.md': 'ordinary' });
    await expect(destination.run('move_file', { from: 'wiki/a.md', to: path })).rejects.toThrow(/protect|immutable|reserved/i);
    expect([...destination.files]).toEqual([['wiki/a.md', 'ordinary']]);
    expect(destination.changes()).toEqual([]);
  });

  it.each([
    'wiki/health/note.md', './WiKi//HeAlTh/./ordinary.MD',
    'wiki/AGENTS.md', 'wiki/health/nested/AGENTS.md',
    'wiki/concepts/AGENTS.md', 'wiki/entities/AGENTS.md', 'WiKi/CoNcEpTs/agents.MD',
    'WiKi/EnTiTiEs/agents.MD', 'wiki/health/AGENTS.md.backup', 'archive/health/AGENTS.md',
  ])('permits ordinary or non-domain-schema path %s as source, destination, and deletion target', async (path) => {
    const canonical = repoPath(path);
    const source = fixture({ [canonical]: 'ordinary' });
    await expect(source.run('move_file', { from: path, to: 'archive/moved.md' })).resolves.toBe('moved');
    expect([...source.files]).toEqual([['archive/moved.md', 'ordinary']]);
    expect(source.changes()).toEqual([{ kind: 'move', from: canonical, to: 'archive/moved.md' }]);

    const destination = fixture({ 'archive/source.md': 'ordinary' });
    await expect(destination.run('move_file', { from: 'archive/source.md', to: path })).resolves.toBe('moved');
    expect([...destination.files]).toEqual([[canonical, 'ordinary']]);
    await expect(destination.run('delete_file', { path })).resolves.toBe('deleted');
    expect([...destination.files]).toEqual([]);
    expect(destination.changes()).toEqual([
      { kind: 'move', from: 'archive/source.md', to: canonical },
      { kind: 'delete', from: canonical },
    ]);
  });

  it.each([
    'AGENTS.md', './aGeNtS.Md', 'wiki/health/AGENTS.md',
    './WiKi//HeAlTh/./aGeNtS.Md',
  ])('allows schema content writes to %s just as for root AGENTS.md', async (path) => {
    const canonical = repoPath(path);
    const f = fixture({ [canonical]: 'original schema' });
    await expect(f.run('write_file', { path, content: 'updated schema' })).resolves.toBe('written');
    expect([...f.files]).toEqual([[canonical, 'updated schema']]);
    expect(f.changes()).toEqual([]);
  });

  it.each(['raw/source.md', './raw//x.md', 'RaW/source.md', 'raw', 'RAW'])('rejects writing immutable raw path %s', async (path) => {
    const canonical = repoPath(path);
    const f = fixture({ [canonical]: 'original source' });
    await expect(f.run('write_file', { path, content: 'replacement' })).rejects.toThrow(/protect|immutable|raw/i);
    expect(f.files.get(canonical)).toBe('original source');
    expect(f.changes()).toEqual([]);
  });

  it.each(['../raw/x.md', 'wiki/../raw/x.md', 'raw/../wiki/x.md', 'wiki\\x.md', '/wiki/x.md', '.git/config'])('rejects invalid repository path %s without changing notes', async (path) => {
    const f = fixture({ 'wiki/a.md': 'original' });
    for (const [name, args] of [
      ['write_file', { path, content: 'replacement' }],
      ['delete_file', { path }],
      ['move_file', { from: path, to: 'wiki/b.md' }],
      ['move_file', { from: 'wiki/a.md', to: path }],
    ] as const) {
      await expect(f.run(name, args)).rejects.toThrow();
    }
    expect([...f.files]).toEqual([['wiki/a.md', 'original']]);
    expect(f.changes()).toEqual([]);
  });

  it('allows writing index, memory, and journal while permitting structural changes to wiki index notes', async () => {
    const f = fixture({ 'wiki/index.md': 'nested index' });
    for (const path of ['index.md', 'MEMORY.md', 'journal/2026-10-08.md']) {
      await f.run('write_file', { path, content: `updated ${path}` });
      expect(f.files.get(path)).toBe(`updated ${path}`);
    }
    await f.run('move_file', { from: 'wiki/index.md', to: 'archive/index.md' });
    await f.run('delete_file', { path: 'archive/index.md' });
    expect(f.files.has('wiki/index.md')).toBe(false);
    expect(f.files.has('archive/index.md')).toBe(false);
    expect(f.changes()).toEqual([
      { kind: 'move', from: 'wiki/index.md', to: 'archive/index.md' },
      { kind: 'delete', from: 'archive/index.md' },
    ]);
  });

  it('shares the twenty-change cap between moves and deletes but still permits journal and content edits', async () => {
    const initial = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`wiki/${index}.md`, `note ${index}`]));
    const f = fixture(initial);
    for (let index = 0; index < 20; index++) {
      if (index % 2 === 0) await f.run('delete_file', { path: `wiki/${index}.md` });
      else await f.run('move_file', { from: `wiki/${index}.md`, to: `archive/${index}.md` });
    }
    expect(f.changes()).toHaveLength(20);
    await expect(f.run('delete_file', { path: 'wiki/20.md' })).rejects.toThrow(/(?=.*(?:20|limit|cap))(?=.*journal)/i);
    expect(f.files.get('wiki/20.md')).toBe('note 20');
    for (const path of ['index.md', 'MEMORY.md', 'journal/2026-10-08.md', 'wiki/20.md']) {
      await f.run('write_file', { path, content: 'reviewed after cap' });
      expect(f.files.get(path)).toBe('reviewed after cap');
    }
    expect(f.changes()).toHaveLength(20);
  });

  it('counts only successful structural changes, including failures from the underlying tools', async () => {
    const f = fixture({ 'wiki/a.md': 'note', 'wiki/occupied.md': 'other' }, ['private/'], 1);
    await expect(f.run('move_file', { from: 'wiki/a.md', to: 'private/a.md' })).rejects.toThrow();
    await expect(f.run('delete_file', { path: 'MEMORY.md' })).rejects.toThrow();
    await expect(f.run('delete_file', { path: 'wiki/missing.md' })).rejects.toThrow(/missing/i);
    await expect(f.run('move_file', { from: 'wiki/missing.md', to: 'wiki/new.md' })).rejects.toThrow(/missing/i);
    await expect(f.run('move_file', { from: 'wiki/a.md', to: 'wiki/occupied.md' })).rejects.toThrow(/exists/i);
    expect(f.changes()).toEqual([]);
    await f.run('move_file', { from: 'wiki/a.md', to: 'wiki/new.md' });
    expect(f.files.get('wiki/new.md')).toBe('note');
    expect(f.files.get('wiki/occupied.md')).toBe('other');
    expect(f.changes()).toEqual([{ kind: 'move', from: 'wiki/a.md', to: 'wiki/new.md' }]);
    await expect(f.run('delete_file', { path: 'wiki/new.md' })).rejects.toThrow(/journal/i);
  });

  it.each([false, true])('reserves pending changes and releases the slot after failure=%s', async (fails) => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const f = fixture({ 'wiki/a.md': 'a', 'wiki/b.md': 'b' }, [], 1, async () => {
      entered();
      await gate;
    });
    const pending = f.run('move_file', { from: fails ? 'wiki/missing.md' : 'wiki/a.md', to: 'wiki/new.md' });
    await started;
    expect(f.changes()).toEqual([]);
    await expect(f.run('delete_file', { path: 'wiki/b.md' })).rejects.toThrow(/journal/i);
    expect(f.files.get('wiki/b.md')).toBe('b');
    release();
    if (fails) {
      await expect(pending).rejects.toThrow(/missing/i);
      await f.run('delete_file', { path: 'wiki/b.md' });
      expect(f.changes()).toEqual([{ kind: 'delete', from: 'wiki/b.md' }]);
    } else {
      await pending;
      expect(f.files.get('wiki/new.md')).toBe('a');
      expect(f.changes()).toEqual([{ kind: 'move', from: 'wiki/a.md', to: 'wiki/new.md' }]);
      await expect(f.run('delete_file', { path: 'wiki/b.md' })).rejects.toThrow(/journal/i);
    }
  });

  it('returns isolated change snapshots with canonical repository paths', async () => {
    const f = fixture({ 'wiki/a.md': 'a', 'wiki/remove.md': 'remove' });
    await f.run('move_file', { from: './wiki//a.md', to: 'archive/./a.md' });
    await f.run('delete_file', { path: './wiki//remove.md' });
    const snapshot = f.changes();
    snapshot[0]!.from = 'corrupted.md';
    snapshot[0]!.to = 'corrupted-destination.md';
    snapshot.pop();
    snapshot.push({ kind: 'delete', from: 'invented.md' });
    expect(f.changes()).toEqual([
      { kind: 'move', from: 'wiki/a.md', to: 'archive/a.md' },
      { kind: 'delete', from: 'wiki/remove.md' },
    ]);
    expect([...f.files]).toEqual([['archive/a.md', 'a']]);
  });
});

type Note = { path: string; content: string };

function newlyUnresolved(beforePaths: string[], beforeNotes: Note[], afterPaths: string[], afterNotes: Note[]) {
  const before = unresolvedLinkTargets(beforePaths, beforeNotes);
  const after = unresolvedLinkTargets(afterPaths, afterNotes);
  return new Set([...after].filter((target) => !before.has(target)));
}

describe('dream broken-link detection', () => {
  it('identifies the old qualified target after moving a linked note without changing its basename', () => {
    const notes = [{ path: 'wiki/source.md', content: 'Read [[Wiki/Topic.md#Details|the topic]].' }];
    const before = ['wiki/source.md', 'Wiki/Topic.md'];
    const after = ['wiki/source.md', 'archive/Topic.md'];
    expect(unresolvedLinkTargets(before, notes)).toEqual(new Set());
    expect(newlyUnresolved(before, notes, after, notes)).toEqual(new Set(['Wiki/Topic.md']));
  });

  it('introduces no broken targets when inbound links are fixed after the move', () => {
    const beforeNotes = [{ path: 'wiki/source.md', content: 'Read [[wiki/Topic]].' }];
    const afterNotes = [{ path: 'wiki/source.md', content: 'Read [[archive/Topic#Details|the topic]].' }];
    expect(newlyUnresolved(
      ['wiki/source.md', 'wiki/Topic.md'], beforeNotes,
      ['wiki/source.md', 'archive/Topic.md'], afterNotes,
    )).toEqual(new Set());
    expect(unresolvedLinkTargets(['wiki/source.md', 'archive/Topic.md'], afterNotes)).toEqual(new Set());
  });

  it('treats a newly colliding basename as ambiguous while preserving qualified links', () => {
    const notes = [{ path: 'wiki/source.md', content: '[[Topic]] and [[wiki/Topic]]' }];
    expect(newlyUnresolved(
      ['wiki/source.md', 'wiki/Topic.md', 'archive/Other.md'], notes,
      ['wiki/source.md', 'wiki/Topic.md', 'archive/Topic.md'], notes,
    )).toEqual(new Set(['Topic']));
  });

  it('resolves existing asset embeds by qualified path or unique basename across repository files', () => {
    const paths = [
      'wiki/source.md', 'assets/image.png', 'raw/import/source.pdf', 'diagram.svg',
    ];
    const notes = [{
      path: 'wiki/source.md',
      content: '![[ASSETS/IMAGE.PNG|image]] ![[image.png]] ![[source.pdf#page=2]] ![[diagram.svg]]',
    }];
    expect(unresolvedLinkTargets(paths, notes)).toEqual(new Set());
  });

  it('identifies a moved asset as newly unresolved without falling back from its qualified path', () => {
    const notes = [{ path: 'wiki/source.md', content: '![[assets/image.png]] ![[image.png]]' }];
    const before = ['wiki/source.md', 'assets/image.png'];
    const after = ['wiki/source.md', 'assets/archive/image.png'];
    expect(newlyUnresolved(before, notes, after, notes)).toEqual(new Set(['assets/image.png']));
    expect(unresolvedLinkTargets(after, notes)).toEqual(new Set(['assets/image.png']));
  });

  it('rejects ambiguous asset basenames even when one candidate is at the repository root', () => {
    const notes = [{ path: 'wiki/source.md', content: '![[image.png]] ![[assets/image.png]]' }];
    const before = ['wiki/source.md', 'assets/image.png'];
    const after = [...before, 'image.png'];
    expect(unresolvedLinkTargets(after, notes)).toEqual(new Set(['image.png']));
    expect(newlyUnresolved(before, notes, after, notes)).toEqual(new Set(['image.png']));
  });

  it('resolves markdown and extensionless targets only against notes, including dotted note names', () => {
    const paths = ['wiki/source.md', 'assets/Topic', 'wiki/Topic.v2.md', 'wiki/Topic.v2'];
    const notes = [{
      path: 'wiki/source.md',
      content: '[[assets/Topic]] [[Topic.md]] [[wiki/Topic.v2.md]]',
    }];
    expect(unresolvedLinkTargets(paths, notes)).toEqual(new Set(['assets/Topic', 'Topic.md']));
  });

  it('does not blame existing unresolved targets on the structural changes', () => {
    const notes = [{ path: 'wiki/source.md', content: '[[Already Missing]] and [[wiki/Topic]]' }];
    const before = ['wiki/source.md', 'wiki/Topic.md'];
    const after = ['wiki/source.md', 'archive/Topic.md'];
    expect(unresolvedLinkTargets(before, notes)).toEqual(new Set(['Already Missing']));
    expect(unresolvedLinkTargets(after, notes)).toEqual(new Set(['Already Missing', 'wiki/Topic']));
    expect(newlyUnresolved(before, notes, after, notes)).toEqual(new Set(['wiki/Topic']));
  });

  it('uses extracted original target text, including embeds, and resolves paths case-insensitively', () => {
    const paths = ['wiki/source.md', 'Wiki/Present.md', 'MEMORY.md', 'assets/image.png'];
    const notes = [{
      path: 'wiki/source.md',
      content: [
        '[[wiki/PRESENT.md#Details|present]] [[memory]]',
        '[[ Missing/Topic.MD#Heading|label ]] ![[Embed/Absent#Details]]',
        '[[#Local heading]] [[missing/topic.md|same target]]',
        '![[assets/image.png]]',
        '`[[Code/Absent]]`',
        '---\nrelated: "[[Frontmatter/Absent]]"\n---',
      ].join('\n'),
    }];
    expect(unresolvedLinkTargets(paths, notes)).toEqual(new Set([
      'Missing/Topic.MD', 'Embed/Absent', 'Code/Absent', 'Frontmatter/Absent',
    ]));
  });
});
