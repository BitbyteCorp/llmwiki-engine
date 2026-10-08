export type WorkspaceTab = { path: string; pinned: boolean; query?: string }
export type GroupId = string
export type EditorGroup = { id: GroupId; tabs: WorkspaceTab[]; activePath: string; ref?: string }
export type SplitNode = { type: 'split'; id: string; orientation: 'horizontal' | 'vertical'; children: LayoutNode[]; sizes: number[] }
export type LayoutNode = { type: 'group'; groupId: GroupId } | SplitNode
export type SplitSide = 'left' | 'right' | 'top' | 'bottom'
export type DropTarget = { kind: 'tabs'; groupId: GroupId; index: number } | { kind: 'group'; groupId: GroupId } | { kind: 'split'; groupId: GroupId; side: SplitSide }
export type WorkspaceState = { groups: Record<GroupId, EditorGroup>; layout: LayoutNode; activeGroupId: GroupId; favoritePaths: string[]; recentPaths: string[]; knownTitles: Record<string, string>; closed: WorkspaceTab[] }
export const MAX_EDITOR_GROUPS = 6
export const GRAPH_TAB_PATH = '@/graph'

export function isViewRoute(pathname: string): boolean {
  return /^\/(?:graph|search(?:\/duplicates)?|tags(?:\/[^/]+)?|history(?:\/(?:commits\/[^/]+|compare|blame))?|jobs(?:\/[^/]+)?|dreams(?:\/[^/]+)?|journal|imports|settings)$/.test(pathname)
}

export function isViewTab(path: string): boolean { return path.startsWith('@') && isViewRoute(viewTabPathname(path)) }
export function viewTabPath(pathname: string): string { return `@${pathname}` }
export function viewTabPathname(path: string): string { return path.slice(1) }

export function createWorkspace(): WorkspaceState {
  return { groups: { 'group-1': { id: 'group-1', tabs: [], activePath: '' } }, layout: { type: 'group', groupId: 'group-1' }, activeGroupId: 'group-1', favoritePaths: [], recentPaths: [], knownTitles: {}, closed: [] }
}

function percentages(sizes: number[], count: number): number[] {
  if (!count) return []
  const valid = sizes.length === count && sizes.every(size => Number.isFinite(size) && size > 0)
  const weights = valid ? sizes : Array<number>(count).fill(1)
  const total = weights.reduce((sum, size) => sum + size, 0)
  return weights.map(size => size / total * 100)
}

export function normalizeLayout(node: LayoutNode): LayoutNode {
  if (node.type === 'group') return node
  if (!node.children.length) return createWorkspace().layout
  const weights = percentages(node.sizes, node.children.length)
  const children: LayoutNode[] = []
  const sizes: number[] = []
  node.children.forEach((child, index) => {
    const normalized = normalizeLayout(child)
    if (normalized.type === 'split' && normalized.orientation === node.orientation) {
      children.push(...normalized.children)
      sizes.push(...normalized.sizes.map(size => weights[index] * size / 100))
    } else { children.push(normalized); sizes.push(weights[index]) }
  })
  return children.length === 1 ? children[0] : { ...node, children, sizes: percentages(sizes, children.length) }
}

export function groupOrder(node: LayoutNode): GroupId[] {
  return node.type === 'group' ? [node.groupId] : node.children.flatMap(groupOrder)
}

export function findParent(node: LayoutNode, groupId: GroupId): SplitNode | null {
  if (node.type === 'group') return null
  if (node.children.some(child => child.type === 'group' && child.groupId === groupId)) return node
  for (const child of node.children) { const parent = findParent(child, groupId); if (parent) return parent }
  return null
}

export function neighbour(node: LayoutNode, groupId: GroupId): GroupId | undefined {
  const order = groupOrder(node)
  const index = order.indexOf(groupId)
  return index < 0 ? undefined : order[index + 1] ?? order[index - 1]
}

function unusedId(state: WorkspaceState, prefix: string): string {
  const ids = new Set(Object.keys(state.groups))
  const collect = (node: LayoutNode) => { if (node.type === 'split') { ids.add(node.id); node.children.forEach(collect) } }
  collect(state.layout)
  let index = 1
  while (ids.has(`${prefix}-${index}`)) index++
  return `${prefix}-${index}`
}

function insert(state: WorkspaceState, besideId: GroupId, side: SplitSide, newGroup: EditorGroup, splitId?: string): WorkspaceState {
  if (Object.keys(state.groups).length >= MAX_EDITOR_GROUPS || !Object.hasOwn(state.groups, besideId) || Object.hasOwn(state.groups, newGroup.id)) return state
  const orientation = side === 'left' || side === 'right' ? 'horizontal' : 'vertical'
  const before = side === 'left' || side === 'top'
  const leaf: LayoutNode = { type: 'group', groupId: newGroup.id }
  const replace = (node: LayoutNode): LayoutNode => node.type === 'split' ? { ...node, children: node.children.map(replace) } : node.groupId !== besideId ? node : {
    type: 'split', id: splitId ?? unusedId(state, 'split'), orientation, children: before ? [leaf, node] : [node, leaf], sizes: [50, 50],
  }
  return { ...state, groups: { ...state.groups, [newGroup.id]: newGroup }, layout: normalizeLayout(replace(state.layout)), activeGroupId: newGroup.id }
}

export function insertGroup(state: WorkspaceState, besideId: GroupId, side: SplitSide, newGroup: EditorGroup): WorkspaceState {
  return insert(state, besideId, side, newGroup)
}

export function removeGroup(state: WorkspaceState, id: GroupId): WorkspaceState {
  if (!Object.hasOwn(state.groups, id)) return state
  if (Object.keys(state.groups).length === 1) return { ...state, groups: { [id]: { id, tabs: [], activePath: '' } }, layout: { type: 'group', groupId: id }, activeGroupId: id }
  const remove = (node: LayoutNode): LayoutNode | null => {
    if (node.type === 'group') return node.groupId === id ? null : node
    const children: LayoutNode[] = []
    const sizes: number[] = []
    node.children.forEach((child, index) => { const kept = remove(child); if (kept) { children.push(kept); sizes.push(node.sizes[index]) } })
    return children.length ? normalizeLayout({ ...node, children, sizes }) : null
  }
  const groups = { ...state.groups }
  delete groups[id]
  return { ...state, groups, layout: remove(state.layout)!, activeGroupId: state.activeGroupId === id ? neighbour(state.layout, id)! : state.activeGroupId }
}

export function visitGroup(state: WorkspaceState, id: GroupId, path: string, pin = false, ref?: string, dirtyPaths?: Set<string>, query?: string): WorkspaceState {
  const group = state.groups[id]
  if (!group || !path) return state
  const view = isViewTab(path)
  pin ||= view
  let tabs = group.tabs.map(tab => !tab.pinned && dirtyPaths?.has(tab.path) ? { ...tab, pinned: true } : tab)
  if (tabs.some(tab => tab.path === path)) tabs = tabs.map(tab => {
    if (tab.path !== path) return tab
    const updated = { ...tab, pinned: tab.pinned || pin }
    if (query !== undefined) {
      if (query) updated.query = query
      else delete updated.query
    }
    return updated
  })
  else {
    tabs = [...tabs]
    const tab: WorkspaceTab = { path, pinned: pin, ...(query ? { query } : {}) }
    const preview = tabs.findIndex(tab => !tab.pinned)
    if (!pin && preview >= 0) tabs[preview] = tab
    else tabs.push(tab)
  }
  const next: EditorGroup = { ...group, tabs, activePath: path }
  if (view) delete next.ref
  else if (ref !== undefined) next.ref = ref
  else if (path !== group.activePath) delete next.ref
  const recentPaths = state.recentPaths.filter(item => !isViewTab(item) && item !== path)
  return { ...state, groups: { ...state.groups, [id]: next }, activeGroupId: id, recentPaths: (view ? recentPaths : [path, ...recentPaths]).slice(0, 30) }
}

function withoutTab(group: EditorGroup, path: string): EditorGroup {
  const index = group.tabs.findIndex(tab => tab.path === path)
  const tabs = group.tabs.filter(tab => tab.path !== path)
  if (group.activePath !== path) return { ...group, tabs }
  const next = { ...group, tabs, activePath: tabs[Math.min(index, tabs.length - 1)]?.path ?? '' }
  delete next.ref
  return next
}

export function moveTab(state: WorkspaceState, source: { groupId: GroupId; path: string }, target: DropTarget, options: { copy?: boolean; newGroupId?: GroupId; splitId?: string } = {}): WorkspaceState {
  const sourceGroup = state.groups[source.groupId]
  const tab = sourceGroup?.tabs.find(item => item.path === source.path)
  if (!tab || !Object.hasOwn(state.groups, target.groupId)) return state
  if (target.kind === 'split' && target.groupId === source.groupId && sourceGroup.tabs.length === 1 && !options.copy) return state
  const view = isViewTab(tab.path)
  const movedTab: WorkspaceTab = { ...tab, pinned: true }
  let destination = target.groupId
  if (target.kind === 'split' && Object.keys(state.groups).length < MAX_EDITOR_GROUPS) {
    destination = options.newGroupId ?? unusedId(state, 'group')
    const next = insert(state, target.groupId, target.side, { id: destination, tabs: [movedTab], activePath: tab.path, ...(!view && sourceGroup.activePath === tab.path && sourceGroup.ref !== undefined ? { ref: sourceGroup.ref } : {}) }, options.splitId)
    if (next === state) return state
    state = next
  } else {
    const group = state.groups[destination]
    const existingIndex = group.tabs.findIndex(item => item.path === tab.path)
    let tabs = group.tabs.map(item => item.path === tab.path ? movedTab : item)
    if (target.kind === 'tabs') {
      let index = Math.max(0, Math.min(group.tabs.length, Math.trunc(target.index)))
      if (existingIndex >= 0) { tabs.splice(existingIndex, 1); if (existingIndex < index) index-- }
      tabs.splice(index, 0, movedTab)
    } else if (existingIndex < 0) tabs = [...tabs, movedTab]
    const next: EditorGroup = { ...group, tabs, activePath: tab.path }
    if (view) delete next.ref
    else if (group.activePath !== tab.path) {
      delete next.ref
      if (sourceGroup.activePath === tab.path && sourceGroup.ref !== undefined) next.ref = sourceGroup.ref
    }
    state = { ...state, groups: { ...state.groups, [destination]: next } }
  }
  if (!options.copy && destination !== source.groupId) {
    const remaining = withoutTab(state.groups[source.groupId], tab.path)
    state = { ...state, groups: { ...state.groups, [source.groupId]: remaining } }
    if (!remaining.tabs.length) state = removeGroup(state, source.groupId)
  }
  const recentPaths = state.recentPaths.filter(path => !isViewTab(path) && path !== tab.path)
  return { ...state, activeGroupId: destination, recentPaths: (view ? recentPaths : [tab.path, ...recentPaths]).slice(0, 30) }
}

function mergeTabs(tabs: WorkspaceTab[]): WorkspaceTab[] {
  const merged: WorkspaceTab[] = []
  for (const tab of tabs) {
    const existing = merged.find(item => item.path === tab.path)
    if (existing) { existing.pinned ||= tab.pinned; if (existing.query === undefined && tab.query !== undefined) existing.query = tab.query }
    else merged.push({ ...tab })
  }
  return merged
}

export function renamePath(state: WorkspaceState, from: string, to: string): WorkspaceState {
  if (from === to || isViewTab(from) || isViewTab(to)) return state
  const rename = (path: string) => path === from ? to : path
  const groups = Object.fromEntries(Object.entries(state.groups).map(([id, group]) => [id, { ...group, tabs: mergeTabs(group.tabs.map(tab => ({ ...tab, path: rename(tab.path) }))), activePath: rename(group.activePath) }]))
  const knownTitles = { ...state.knownTitles }
  if (Object.hasOwn(knownTitles, from)) { knownTitles[to] = knownTitles[from]; delete knownTitles[from] }
  return { ...state, groups, favoritePaths: [...new Set(state.favoritePaths.map(rename))], recentPaths: [...new Set(state.recentPaths.map(rename))], knownTitles, closed: state.closed.map(tab => ({ ...tab, path: rename(tab.path) })) }
}

export function removePath(state: WorkspaceState, path: string): WorkspaceState {
  if (isViewTab(path)) return state
  const groups = Object.fromEntries(Object.entries(state.groups).map(([id, group]) => [id, withoutTab(group, path)]))
  const knownTitles = { ...state.knownTitles }
  delete knownTitles[path]
  state = { ...state, groups, favoritePaths: state.favoritePaths.filter(item => item !== path), recentPaths: state.recentPaths.filter(item => item !== path), closed: state.closed.filter(tab => tab.path !== path), knownTitles }
  for (const id of groupOrder(state.layout)) if (!state.groups[id].tabs.length) state = removeGroup(state, id)
  return state
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function paths(value: unknown): value is string[] { return Array.isArray(value) && value.every(path => typeof path === 'string' && !!path) }
function tabs(value: unknown): value is WorkspaceTab[] { return Array.isArray(value) && value.every(tab => record(tab) && typeof tab.path === 'string' && !!tab.path && typeof tab.pinned === 'boolean' && (tab.query === undefined || typeof tab.query === 'string')) }
function metadata(value: Record<string, unknown>): boolean {
  return paths(value.favoritePaths) && paths(value.recentPaths) && tabs(value.closed) && record(value.knownTitles) && Object.values(value.knownTitles).every(title => typeof title === 'string')
}

function storedPath(path: string): string { return path === '@graph' ? GRAPH_TAB_PATH : path }
function storedTab(tab: WorkspaceTab): WorkspaceTab {
  const path = storedPath(tab.path)
  const restored = { ...tab, path, pinned: tab.pinned || isViewTab(path) }
  if (!restored.query) delete restored.query
  return restored
}
function notePaths(value: unknown): string[] { return [...new Set((value as string[]).filter(path => !isViewTab(storedPath(path))))] }

export function migrateV1(value: unknown): WorkspaceState {
  if (!record(value) || !tabs(value.tabs) || !metadata(value) || !(value.splitPath === null || typeof value.splitPath === 'string')) return createWorkspace()
  const state = createWorkspace()
  state.favoritePaths = notePaths(value.favoritePaths)
  state.recentPaths = notePaths(value.recentPaths)
  state.knownTitles = Object.fromEntries(Object.entries(value.knownTitles as Record<string, string>).filter(([path]) => !isViewTab(storedPath(path))))
  state.closed = (value.closed as WorkspaceTab[]).map(storedTab)
  const migratedTabs = mergeTabs(value.tabs.map(storedTab))
  // Legacy storage did not persist selection; URL reconciliation selects the actual tab.
  state.groups['group-1'] = { id: 'group-1', tabs: migratedTabs, activePath: migratedTabs[0]?.path ?? '' }
  if (!value.splitPath) return state
  const splitPath = storedPath(value.splitPath as string)
  const ratio = typeof value.splitRatio === 'number' && Number.isFinite(value.splitRatio) ? Math.min(0.8, Math.max(0.2, value.splitRatio)) : 0.5
  let result = insertGroup(state, 'group-1', 'right', { id: 'group-2', tabs: [{ path: splitPath, pinned: true }], activePath: splitPath })
  if (!migratedTabs.length) return removeGroup(result, 'group-1')
  result = { ...result, activeGroupId: 'group-1', layout: { ...result.layout as SplitNode, sizes: [ratio * 100, (1 - ratio) * 100] } }
  return result
}

export function validateV2(value: unknown): WorkspaceState {
  if (!record(value) || !record(value.groups) || !metadata(value) || typeof value.activeGroupId !== 'string') return createWorkspace()
  const entries = Object.entries(value.groups)
  if (!entries.length || entries.length > MAX_EDITOR_GROUPS) return createWorkspace()
  const groups: Record<GroupId, EditorGroup> = Object.fromEntries(entries.map(([id, group]) => [id, group])) as Record<GroupId, EditorGroup>
  for (const [id, group] of entries) {
    if (!id || !record(group) || group.id !== id || !tabs(group.tabs) || typeof group.activePath !== 'string' || (group.ref !== undefined && typeof group.ref !== 'string')) return createWorkspace()
    if (new Set(group.tabs.map(tab => tab.path)).size !== group.tabs.length || group.tabs.filter(tab => !tab.pinned && !isViewTab(storedPath(tab.path))).length > 1) return createWorkspace()
    if (group.tabs.length ? !group.tabs.some(tab => tab.path === group.activePath) : group.activePath !== '' || entries.length > 1 || group.ref !== undefined) return createWorkspace()
  }
  if (!Object.hasOwn(groups, value.activeGroupId)) return createWorkspace()
  const seen = new Set<unknown>()
  const leaves = new Set<string>()
  const ids = new Set(Object.keys(groups))
  const validNode = (node: unknown): node is LayoutNode => {
    if (!record(node) || seen.has(node) || seen.size > 64) return false
    seen.add(node)
    if (node.type === 'group') {
      if (typeof node.groupId !== 'string' || !Object.hasOwn(groups, node.groupId) || leaves.has(node.groupId)) return false
      leaves.add(node.groupId)
      return true
    }
    if (node.type !== 'split' || typeof node.id !== 'string' || !node.id || ids.has(node.id) || (node.orientation !== 'horizontal' && node.orientation !== 'vertical') || !Array.isArray(node.children) || !node.children.length || !Array.isArray(node.sizes) || node.sizes.length !== node.children.length) return false
    ids.add(node.id)
    if (!node.sizes.every(size => typeof size === 'number' && Number.isFinite(size) && size > 0) || Math.abs(node.sizes.reduce((sum: number, size: number) => sum + size, 0) - 100) > 0.001) return false
    return node.children.every(validNode)
  }
  if (!validNode(value.layout) || leaves.size !== entries.length) return createWorkspace()
  const restoredGroups = Object.fromEntries(entries.map(([id]) => {
    const group = groups[id]
    const restored: EditorGroup = { ...group, activePath: storedPath(group.activePath), tabs: mergeTabs(group.tabs.map(storedTab)) }
    if (isViewTab(restored.activePath)) delete restored.ref
    return [id, restored]
  }))
  const knownTitles = Object.fromEntries(Object.entries(value.knownTitles as Record<string, string>).filter(([path]) => !isViewTab(storedPath(path))))
  return { groups: restoredGroups, layout: normalizeLayout(value.layout), activeGroupId: value.activeGroupId, favoritePaths: notePaths(value.favoritePaths), recentPaths: notePaths(value.recentPaths), knownTitles, closed: (value.closed as WorkspaceTab[]).map(storedTab) }
}
