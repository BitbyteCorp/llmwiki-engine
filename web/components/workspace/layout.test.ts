import { describe, expect, it } from 'vitest'
import { createWorkspace, findParent, GRAPH_TAB_PATH, groupOrder, insertGroup, isGraphTab, migrateV1, moveTab, neighbour, normalizeLayout, removeGroup, removePath, renamePath, validateV2, visitGroup, MAX_EDITOR_GROUPS, type EditorGroup, type LayoutNode, type SplitSide } from './layout'

const group = (id: string, path = `${id}.md`): EditorGroup => ({ id, tabs: [{ path, pinned: true }], activePath: path })

describe('editor group layout', () => {
  it.each<[SplitSide, string, string[]]>([
    ['left', 'horizontal', ['second', 'group-1']],
    ['right', 'horizontal', ['group-1', 'second']],
    ['top', 'vertical', ['second', 'group-1']],
    ['bottom', 'vertical', ['group-1', 'second']],
  ])('inserts on the %s edge with the corresponding orientation and reading order', (side, orientation, order) => {
    const state = insertGroup(createWorkspace(), 'group-1', side, group('second'))
    expect(groupOrder(state.layout)).toEqual(order)
    expect(state.layout).toMatchObject({ type: 'split', orientation, sizes: [50, 50] })
    expect(state.activeGroupId).toBe('second')
  })

  it('flattens matching orientations but retains perpendicular splits and their local proportions', () => {
    let state = insertGroup(createWorkspace(), 'group-1', 'right', group('second'))
    state = insertGroup(state, 'second', 'right', group('third'))
    expect(state.layout).toMatchObject({ orientation: 'horizontal', sizes: [50, 25, 25] })
    state = insertGroup(state, 'second', 'top', group('fourth'))
    expect(groupOrder(state.layout)).toEqual(['group-1', 'fourth', 'second', 'third'])
    expect(state.layout).toMatchObject({ orientation: 'horizontal', sizes: [50, 25, 25], children: [
      { groupId: 'group-1' },
      { type: 'split', orientation: 'vertical', sizes: [50, 50], children: [{ groupId: 'fourth' }, { groupId: 'second' }] },
      { groupId: 'third' },
    ] })
    expect(findParent(state.layout, 'second')?.orientation).toBe('vertical')
    expect(neighbour(state.layout, 'second')).toBe('third')
    expect(neighbour(state.layout, 'third')).toBe('second')
  })

  it('multiplies child proportions when flattening and collapses single-child splits', () => {
    const layout: LayoutNode = { type: 'split', id: 'outer', orientation: 'horizontal', sizes: [60, 40], children: [
      { type: 'split', id: 'single', orientation: 'vertical', sizes: [100], children: [{ type: 'group', groupId: 'a' }] },
      { type: 'split', id: 'inner', orientation: 'horizontal', sizes: [25, 75], children: [{ type: 'group', groupId: 'b' }, { type: 'group', groupId: 'c' }] },
    ] }
    expect(normalizeLayout(layout)).toEqual({ type: 'split', id: 'outer', orientation: 'horizontal', sizes: [60, 10, 30], children: [{ type: 'group', groupId: 'a' }, { type: 'group', groupId: 'b' }, { type: 'group', groupId: 'c' }] })
  })

  it('removes groups, collapses nesting, selects the neighbour, and resets the sole group', () => {
    let state = visitGroup(createWorkspace(), 'group-1', 'a.md', true)
    state = insertGroup(state, 'group-1', 'right', group('second'))
    state = insertGroup(state, 'second', 'bottom', group('third'))
    state = removeGroup(state, 'third')
    expect(groupOrder(state.layout)).toEqual(['group-1', 'second'])
    expect(state.layout).toMatchObject({ orientation: 'horizontal', sizes: [50, 50] })
    expect(state.activeGroupId).toBe('second')
    state = removeGroup(state, 'second')
    expect(state.layout).toEqual({ type: 'group', groupId: 'group-1' })
    expect(state.activeGroupId).toBe('group-1')
    state = removeGroup(state, 'group-1')
    expect(state.groups['group-1']).toEqual({ id: 'group-1', tabs: [], activePath: '' })
    expect(state.recentPaths).toEqual(['a.md'])
  })
})

describe('workspace tabs', () => {
  it('replaces clean previews but pins dirty previews and clears revisions on path changes', () => {
    let state = visitGroup(createWorkspace(), 'group-1', 'a.md', false, 'revision-a')
    state = visitGroup(state, 'group-1', 'b.md', false, undefined, new Set(['a.md']))
    expect(state.groups['group-1']).toEqual({ id: 'group-1', activePath: 'b.md', tabs: [{ path: 'a.md', pinned: true }, { path: 'b.md', pinned: false }] })
    state = visitGroup(state, 'group-1', 'c.md')
    expect(state.groups['group-1'].tabs).toEqual([{ path: 'a.md', pinned: true }, { path: 'c.md', pinned: false }])
    state = visitGroup(state, 'group-1', 'a.md', true, 'revision-a')
    state = visitGroup(state, 'group-1', 'a.md')
    expect(state.groups['group-1'].ref).toBe('revision-a')
    expect(state.recentPaths).toEqual(['a.md', 'c.md', 'b.md'])
  })

  it('opens graph as a pinned tab without replacing previews or retaining note revisions', () => {
    let state = visitGroup(createWorkspace(), 'group-1', 'a.md', false, 'revision-a')
    state = visitGroup(state, 'group-1', GRAPH_TAB_PATH, false, 'revision-graph')
    expect(state.groups['group-1']).toEqual({ id: 'group-1', activePath: '@graph', tabs: [{ path: 'a.md', pinned: false }, { path: '@graph', pinned: true }] })
    expect(state.recentPaths).toEqual(['a.md'])
    state.groups['group-1'].ref = 'stale-revision'
    state = visitGroup(state, 'group-1', GRAPH_TAB_PATH)
    expect(state.groups['group-1'].ref).toBeUndefined()
    state = visitGroup(state, 'group-1', 'b.md')
    expect(state.groups['group-1'].tabs).toEqual([{ path: 'b.md', pinned: false }, { path: '@graph', pinned: true }])
    expect(state.recentPaths).toEqual(['b.md', 'a.md'])
    expect(isGraphTab('@graph')).toBe(true)
    expect(isGraphTab('graph.md')).toBe(false)
  })

  it.each([
    ['tabs', false], ['group', false], ['split', false],
    ['tabs', true], ['group', true], ['split', true],
  ] as const)('keeps graph pinned and out of recents when dropped on %s with copy=%s', (kind, copy) => {
    let state = visitGroup(createWorkspace(), 'group-1', 'a.md', true)
    state = visitGroup(state, 'group-1', GRAPH_TAB_PATH)
    state.groups['group-1'].ref = 'stale-graph-revision'
    state = insertGroup(state, 'group-1', 'right', { ...group('second', 'b.md'), ref: 'revision-b' })
    state.recentPaths = ['b.md', '@graph', 'a.md']
    const target = kind === 'tabs' ? { kind, groupId: 'second', index: 0 } : kind === 'split' ? { kind, groupId: 'second', side: 'bottom' as const } : { kind, groupId: 'second' }
    const moved = moveTab(state, { groupId: 'group-1', path: GRAPH_TAB_PATH }, target, { copy, newGroupId: 'graph-group' })
    const destination = kind === 'split' ? 'graph-group' : 'second'
    expect(moved.groups[destination].activePath).toBe('@graph')
    expect(moved.groups[destination].tabs).toContainEqual({ path: '@graph', pinned: true })
    expect(moved.groups[destination].ref).toBeUndefined()
    expect(moved.recentPaths).toEqual(['b.md', 'a.md'])
    expect(moved.groups['group-1'].tabs).toEqual(copy ? [{ path: 'a.md', pinned: true }, { path: '@graph', pinned: true }] : [{ path: 'a.md', pinned: true }])
  })

  it('reorders graph within its group and clears stale revisions on an already active graph target', () => {
    let state = visitGroup(createWorkspace(), 'group-1', GRAPH_TAB_PATH)
    state = visitGroup(state, 'group-1', 'a.md', true, 'revision-a')
    state = moveTab(state, { groupId: 'group-1', path: GRAPH_TAB_PATH }, { kind: 'tabs', groupId: 'group-1', index: 2 })
    expect(state.groups['group-1']).toEqual({ id: 'group-1', activePath: '@graph', tabs: [{ path: 'a.md', pinned: true }, { path: '@graph', pinned: true }] })
    state = insertGroup(state, 'group-1', 'right', { ...group('second', GRAPH_TAB_PATH), ref: 'stale-graph-revision' })
    state = moveTab(state, { groupId: 'group-1', path: GRAPH_TAB_PATH }, { kind: 'group', groupId: 'second' })
    expect(state.groups.second).toEqual({ id: 'second', activePath: '@graph', tabs: [{ path: '@graph', pinned: true }] })
    expect(state.recentPaths).toEqual(['a.md'])
  })

  it('reorders within one group using the pre-removal drop index', () => {
    let state = visitGroup(createWorkspace(), 'group-1', 'a.md', true)
    state = visitGroup(state, 'group-1', 'b.md', true)
    state = visitGroup(state, 'group-1', 'c.md', true)
    state = moveTab(state, { groupId: 'group-1', path: 'a.md' }, { kind: 'tabs', groupId: 'group-1', index: 3 })
    expect(state.groups['group-1'].tabs.map(tab => tab.path)).toEqual(['b.md', 'c.md', 'a.md'])
    state = moveTab(state, { groupId: 'group-1', path: 'c.md' }, { kind: 'tabs', groupId: 'group-1', index: 0 })
    expect(state.groups['group-1'].tabs.map(tab => tab.path)).toEqual(['c.md', 'b.md', 'a.md'])
  })

  it('moves a last tab, removes its source, and activates its pinned destination', () => {
    const initial = visitGroup(createWorkspace(), 'group-1', 'a.md', false, 'revision-a')
    const state = insertGroup(initial, 'group-1', 'right', group('second', 'b.md'))
    const moved = moveTab(state, { groupId: 'group-1', path: 'a.md' }, { kind: 'tabs', groupId: 'second', index: 0 })
    expect(Object.keys(moved.groups)).toEqual(['second'])
    expect(moved.layout).toEqual({ type: 'group', groupId: 'second' })
    expect(moved.activeGroupId).toBe('second')
    expect(moved.groups.second).toEqual({ id: 'second', tabs: [{ path: 'a.md', pinned: true }, { path: 'b.md', pinned: true }], activePath: 'a.md', ref: 'revision-a' })
    expect(initial.groups['group-1'].tabs).toEqual([{ path: 'a.md', pinned: false }])
    expect(moved.closed).toEqual([])
  })

  it('does not split a group by moving its only tab beside itself', () => {
    const state = visitGroup(createWorkspace(), 'group-1', 'a.md')
    expect(moveTab(state, { groupId: 'group-1', path: 'a.md' }, { kind: 'split', groupId: 'group-1', side: 'right' })).toBe(state)
  })

  it('copies without removing the original and deduplicates existing target paths as pinned', () => {
    const initial = visitGroup(createWorkspace(), 'group-1', 'a.md')
    let state = insertGroup(initial, 'group-1', 'right', group('second', 'b.md'))
    state = moveTab(state, { groupId: 'group-1', path: 'a.md' }, { kind: 'group', groupId: 'second' }, { copy: true })
    expect(state.groups['group-1'].tabs).toEqual([{ path: 'a.md', pinned: false }])
    expect(state.groups.second.tabs).toEqual([{ path: 'b.md', pinned: true }, { path: 'a.md', pinned: true }])
    state = moveTab(state, { groupId: 'group-1', path: 'a.md' }, { kind: 'group', groupId: 'second' })
    expect(state.groups.second.tabs).toEqual([{ path: 'b.md', pinned: true }, { path: 'a.md', pinned: true }])
    expect(state.activeGroupId).toBe('second')
    expect(state.groups['group-1']).toBeUndefined()
  })

  it('merges a moved pinned tab into an existing unpinned target without duplicating it', () => {
    let state = visitGroup(createWorkspace(), 'group-1', 'a.md', true)
    state = insertGroup(state, 'group-1', 'right', { id: 'second', activePath: 'a.md', tabs: [{ path: 'a.md', pinned: false }] })
    state = moveTab(state, { groupId: 'group-1', path: 'a.md' }, { kind: 'group', groupId: 'second' })
    expect(state.groups.second.tabs).toEqual([{ path: 'a.md', pinned: true }])
  })

  it('splits with deterministic unused IDs and supports caller-supplied IDs', () => {
    let state = visitGroup(createWorkspace(), 'group-1', 'a.md', true)
    state = visitGroup(state, 'group-1', 'b.md', true)
    const moved = moveTab(state, { groupId: 'group-1', path: 'b.md' }, { kind: 'split', groupId: 'group-1', side: 'bottom' })
    expect(moved.layout).toMatchObject({ id: 'split-1', orientation: 'vertical' })
    expect(moved.groups['group-2'].tabs).toEqual([{ path: 'b.md', pinned: true }])
    expect(moved.activeGroupId).toBe('group-2')
    const copied = moveTab(moved, { groupId: 'group-2', path: 'b.md' }, { kind: 'split', groupId: 'group-2', side: 'right' }, { copy: true, newGroupId: 'custom-group', splitId: 'custom-split' })
    expect(findParent(copied.layout, 'custom-group')?.id).toBe('custom-split')
    expect(copied.groups['group-2'].tabs).toEqual([{ path: 'b.md', pinned: true }])
  })

  it('keeps insertions unchanged at the cap but degrades split drops to the targeted group', () => {
    let state = visitGroup(createWorkspace(), 'group-1', 'a.md', true)
    for (let index = 2; index <= MAX_EDITOR_GROUPS; index++) state = insertGroup(state, 'group-1', 'right', group(`group-${index}`))
    expect(insertGroup(state, 'group-1', 'right', group('overflow'))).toBe(state)
    const moved = moveTab(state, { groupId: 'group-1', path: 'a.md' }, { kind: 'split', groupId: 'group-2', side: 'top' })
    expect(groupOrder(moved.layout)).toEqual(['group-6', 'group-5', 'group-4', 'group-3', 'group-2'])
    expect(moved.groups['group-2'].tabs).toEqual([{ path: 'group-2.md', pinned: true }, { path: 'a.md', pinned: true }])
    expect(moved.activeGroupId).toBe('group-2')
  })
})

describe('workspace persistence and path changes', () => {
  const legacy = { tabs: [{ path: 'a.md', pinned: false }, { path: 'b.md', pinned: true }], splitPath: 'c.md', splitRatio: 0.7, favoritePaths: ['a.md'], recentPaths: ['b.md'], knownTitles: { 'a.md': 'A' }, closed: [{ path: 'd.md', pinned: true }] }

  it('migrates legacy tabs, split selection, proportions, and metadata', () => {
    const state = migrateV1(legacy)
    expect(state.groups['group-1']).toEqual({ id: 'group-1', tabs: legacy.tabs, activePath: 'a.md' })
    expect(state.groups['group-2']).toEqual({ id: 'group-2', tabs: [{ path: 'c.md', pinned: true }], activePath: 'c.md' })
    expect(state.layout).toMatchObject({ orientation: 'horizontal' })
    if (state.layout.type !== 'split') throw new Error('Legacy side pane must migrate to a split')
    expect(state.layout.sizes[0]).toBeCloseTo(70)
    expect(state.layout.sizes[1]).toBeCloseTo(30)
    expect(state).toMatchObject({ activeGroupId: 'group-1', favoritePaths: ['a.md'], recentPaths: ['b.md'], knownTitles: { 'a.md': 'A' }, closed: [{ path: 'd.md', pinned: true }] })
    expect(migrateV1({ ...legacy, tabs: [] }).layout).toEqual({ type: 'group', groupId: 'group-2' })
    const clamped = migrateV1({ ...legacy, splitRatio: 9 }).layout
    if (clamped.type !== 'split') throw new Error('Legacy side pane must migrate to a split')
    expect(clamped.sizes[0]).toBeCloseTo(80)
    expect(clamped.sizes[1]).toBeCloseTo(20)
    expect(migrateV1({ ...legacy, tabs: null })).toEqual(createWorkspace())
  })

  it('migrates graph tabs and closed graph tabs as pinned without note metadata', () => {
    const state = migrateV1({ ...legacy, tabs: [{ path: '@graph', pinned: false }, { path: 'a.md', pinned: false }], splitPath: null, favoritePaths: ['@graph', 'a.md'], recentPaths: ['b.md', '@graph'], knownTitles: { '@graph': 'Graph', 'a.md': 'A' }, closed: [{ path: '@graph', pinned: false }, { path: 'd.md', pinned: true }] })
    expect(state.groups['group-1']).toEqual({ id: 'group-1', activePath: '@graph', tabs: [{ path: '@graph', pinned: true }, { path: 'a.md', pinned: false }] })
    expect(state).toMatchObject({ favoritePaths: ['a.md'], recentPaths: ['b.md'], knownTitles: { 'a.md': 'A' }, closed: [{ path: '@graph', pinned: true }, { path: 'd.md', pinned: true }] })
    expect(validateV2(JSON.parse(JSON.stringify(state)))).toEqual(state)
    const splitGraph = migrateV1({ ...legacy, splitPath: '@graph' })
    expect(splitGraph.groups['group-2']).toEqual({ id: 'group-2', activePath: '@graph', tabs: [{ path: '@graph', pinned: true }] })
  })

  it('reloads graph beside a note preview, clears its revision, and restores closed graph as pinned', () => {
    let state = createWorkspace()
    state.groups['group-1'] = { id: 'group-1', activePath: '@graph', ref: 'stale-graph-revision', tabs: [{ path: '@graph', pinned: false }, { path: 'a.md', pinned: false }] }
    state = insertGroup(state, 'group-1', 'right', { ...group('second', 'b.md'), ref: 'revision-b' })
    state.favoritePaths = ['@graph', 'a.md']
    state.recentPaths = ['b.md', '@graph', 'a.md']
    state.knownTitles = { '@graph': 'Graph', 'a.md': 'A' }
    state.closed = [{ path: '@graph', pinned: false }]
    const restored = validateV2(JSON.parse(JSON.stringify(state)))
    expect(restored.groups['group-1']).toEqual({ id: 'group-1', activePath: '@graph', tabs: [{ path: '@graph', pinned: true }, { path: 'a.md', pinned: false }] })
    expect(restored.groups.second.ref).toBe('revision-b')
    expect(restored.favoritePaths).toEqual(['a.md'])
    expect(restored.recentPaths).toEqual(['b.md', 'a.md'])
    expect(restored.knownTitles).toEqual({ 'a.md': 'A' })
    expect(restored.closed).toEqual([{ path: '@graph', pinned: true }])
    expect(validateV2(JSON.parse(JSON.stringify(restored)))).toEqual(restored)
    const reopened = visitGroup(restored, 'second', restored.closed[0].path, restored.closed[0].pinned)
    expect(reopened.groups.second).toEqual({ id: 'second', activePath: '@graph', tabs: [{ path: 'b.md', pinned: true }, { path: '@graph', pinned: true }] })
    expect(reopened.recentPaths).toEqual(['b.md', 'a.md'])
  })

  it('protects graph from note renames and deletion while allowing ordinary note changes', () => {
    const initial = migrateV1({ ...legacy, tabs: [{ path: '@graph', pinned: false }, { path: 'a.md', pinned: true }], splitPath: null, closed: [{ path: '@graph', pinned: false }, { path: 'a.md', pinned: true }] })
    expect(renamePath(initial, '@graph', 'renamed.md')).toBe(initial)
    expect(renamePath(initial, 'a.md', '@graph')).toBe(initial)
    expect(removePath(initial, '@graph')).toBe(initial)
    const renamed = renamePath(initial, 'a.md', 'renamed.md')
    expect(renamed.groups['group-1']).toEqual({ id: 'group-1', activePath: '@graph', tabs: [{ path: '@graph', pinned: true }, { path: 'renamed.md', pinned: true }] })
    expect(renamed.closed).toEqual([{ path: '@graph', pinned: true }, { path: 'renamed.md', pinned: true }])
    const removed = removePath(renamed, 'renamed.md')
    expect(removed.groups['group-1']).toEqual({ id: 'group-1', activePath: '@graph', tabs: [{ path: '@graph', pinned: true }] })
    expect(removed.closed).toEqual([{ path: '@graph', pinned: true }])
    expect(removed.favoritePaths).toEqual([])
    expect(removed.knownTitles).toEqual({})
  })

  it('round-trips valid v2 and rejects malformed topology, selection, tabs, sizes, and metadata', () => {
    const state = migrateV1(legacy)
    expect(validateV2(JSON.parse(JSON.stringify(state)))).toEqual(state)
    const layout = { type: 'split', id: 's', orientation: 'horizontal', sizes: [50, 50], children: [{ type: 'group', groupId: 'group-1' }, { type: 'group', groupId: 'group-1' }] }
    for (const invalid of [
      null, {}, { ...state, activeGroupId: 'missing' }, { ...state, layout },
      { ...state, layout: { type: 'group', groupId: 'group-1' } },
      { ...state, layout: { ...layout, sizes: [40, 40] } },
      { ...state, groups: { ...state.groups, 'group-1': { ...state.groups['group-1'], activePath: 'missing.md' } } },
      { ...state, groups: { ...state.groups, 'group-1': { ...state.groups['group-1'], tabs: [{ path: 'a.md', pinned: false }, { path: 'a.md', pinned: true }] } } },
      { ...state, closed: [null] }, { ...state, knownTitles: { 'a.md': 1 } },
      { ...state, favoritePaths: [1] },
    ]) expect(validateV2(invalid)).toEqual(createWorkspace())
    const cyclic: Record<string, unknown> = { type: 'split', id: 'cycle', orientation: 'horizontal', sizes: [100] }
    cyclic.children = [cyclic]
    expect(validateV2({ ...state, layout: cyclic })).toEqual(createWorkspace())
  })

  it('renames every occurrence and merges colliding tabs and metadata paths without losing pinning', () => {
    let state = migrateV1({ ...legacy, tabs: [{ path: 'a.md', pinned: false }, { path: 'b.md', pinned: true }], splitPath: 'a.md', favoritePaths: ['a.md', 'b.md'], recentPaths: ['a.md', 'b.md'], closed: [{ path: 'a.md', pinned: false }] })
    state = renamePath(state, 'a.md', 'b.md')
    expect(state.groups['group-1']).toEqual({ id: 'group-1', activePath: 'b.md', tabs: [{ path: 'b.md', pinned: true }] })
    expect(state.groups['group-2'].activePath).toBe('b.md')
    expect(state.favoritePaths).toEqual(['b.md'])
    expect(state.recentPaths).toEqual(['b.md'])
    expect(state.knownTitles).toEqual({ 'b.md': 'A' })
    expect(state.closed).toEqual([{ path: 'b.md', pinned: false }])
  })

  it('removes a path from all groups and metadata, pruning empty groups and clearing stale revisions', () => {
    let state = migrateV1({ ...legacy, splitPath: 'a.md', closed: [{ path: 'a.md', pinned: true }] })
    state = visitGroup(state, 'group-1', 'a.md', false, 'revision-a')
    state = removePath(state, 'a.md')
    expect(state.layout).toEqual({ type: 'group', groupId: 'group-1' })
    expect(state.groups['group-1']).toEqual({ id: 'group-1', activePath: 'b.md', tabs: [{ path: 'b.md', pinned: true }] })
    expect(state).toMatchObject({ activeGroupId: 'group-1', favoritePaths: [], recentPaths: ['b.md'], knownTitles: {}, closed: [] })
    state = removePath(state, 'b.md')
    expect(state.groups['group-1']).toEqual({ id: 'group-1', activePath: '', tabs: [] })
  })
})
