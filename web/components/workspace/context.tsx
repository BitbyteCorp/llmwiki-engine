'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { noteHref } from '@/components/common'
import { api } from '@/lib/api'
import { clearDraft, confirmEditorLeave, getEditorStatus, markDraftTransfer, renameDraft, subscribeEditorStatus } from '@/components/editor/state'
import { notify } from '@/components/notifications'
import { createWorkspace, isViewTab, isViewRoute, viewTabPath, viewTabPathname, groupOrder, insertGroup, MAX_EDITOR_GROUPS, moveTab as moveLayoutTab, removeGroup, renamePath, removePath, visitGroup, validateV2, migrateV1, type WorkspaceState, type GroupId, type LayoutNode, type SplitSide, type DropTarget } from './layout'

export { MAX_EDITOR_GROUPS } from './layout'
export type { WorkspaceTab, GroupId, EditorGroup, SplitNode, LayoutNode, SplitSide, DropTarget } from './layout'
export type NoteInfo = { path: string; updatedSha: string; body: string }
export type Workspace = Omit<WorkspaceState, 'closed'> & {
  groupOrder: GroupId[]
  activePath: string
  setActiveGroup(id: GroupId): void
  focusGroup(target: GroupId | number): void
  openNote(path: string, options?: { pin?: boolean; fragment?: string; group?: GroupId | 'side'; ref?: string; query?: string; replace?: boolean }): void
  openHref(href: string, options?: { group?: GroupId; replace?: boolean }): void
  openNoteAt(path: string, target: DropTarget): void
  moveTab(source: { groupId: GroupId; path: string }, target: DropTarget, options?: { copy?: boolean }): void
  splitEditor(side?: SplitSide): void
  closeTab(path: string, groupId?: GroupId): void
  closeOthers(path: string, groupId?: GroupId): void
  closeGroup(groupId: GroupId): void
  pinTab(path: string, groupId?: GroupId): void
  reopenClosed(): void
  setSplitSizes(splitId: string, sizes: number[]): void
  resetSplitSizes(splitId: string): void
  isEditorOwner(groupId: GroupId, path: string): boolean
  revealFolder(path: string): void
  toggleFavorite(path: string): void
  rememberTitle(path: string, title: string): void
  renameNotePath(from: string, to: string): void
  removeNotePath(path: string): void
  noteInfo: NoteInfo | null
  setNoteInfo(info: NoteInfo | null): void
}
const Context = createContext<Workspace | null>(null)
const storagePrefix = 'llmwiki.workspace.v2'
const capNotice = () => notify({ title: `편집기 그룹은 최대 ${MAX_EDITOR_GROUPS}개까지 열 수 있습니다.`, description: '현재 그룹에서 노트를 엽니다.' })
const activeHref = (state: WorkspaceState) => {
  const group = state.groups[state.activeGroupId]
  if (isViewTab(group?.activePath ?? '')) {
    const tab = group.tabs.find(tab => tab.path === group.activePath)
    return viewTabPathname(group.activePath) + (tab?.query ? `?${tab.query}` : '')
  }
  return group?.activePath ? noteHref(group.activePath) + (group.ref ? `?ref=${encodeURIComponent(group.ref)}` : '') : '/wiki?empty=1'
}
function freshGroupId(state: WorkspaceState) {
  let index = 1
  while (state.groups[`group-${index}`]) index += 1
  return `group-${index}`
}
function ownerFor(state: WorkspaceState, path: string, remembered?: string) {
  if (remembered && state.groups[remembered]?.activePath === path) return remembered
  return groupOrder(state.layout).find(id => state.groups[id]?.activePath === path)
}
function leavingFor(state: WorkspaceState, id: string, path: string) {
  const previous = state.groups[id]?.activePath
  return previous && !isViewTab(previous) && previous !== path ? [previous] : []
}
const notePaths = (paths: string[]) => paths.filter(path => !isViewTab(path))
function updateSizes(node: LayoutNode, id: string, sizes?: number[]): LayoutNode {
  if (node.type === 'group') return node
  if (node.id === id) {
    const valid = sizes && sizes.length === node.children.length && sizes.every(size => Number.isFinite(size) && size > 0)
    const values = valid ? sizes : node.children.map(() => 1)
    const sum = values.reduce((total, size) => total + size, 0)
    return { ...node, sizes: values.map(size => size / sum * 100) }
  }
  return { ...node, children: node.children.map(child => updateSizes(child, id, sizes)) }
}

export function WorkspaceProvider({ children, userId }: { children: ReactNode; userId?: number }) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const urlIsView = isViewRoute(pathname)
  const urlPath = urlIsView ? viewTabPath(pathname) : pathname.startsWith('/wiki/') ? pathname.slice(6).split('/').map(decodeURIComponent).join('/') : ''
  const urlRef = urlIsView ? undefined : searchParams.get('ref') || undefined
  const urlQuery = urlIsView ? searchParams.toString() : undefined
  const router = useRouter()
  const storageKey = `${storagePrefix}.${userId ?? 'default'}`
  const [state, setState] = useState<WorkspaceState>(createWorkspace)
  const stateRef = useRef(state)
  const [restoredKey, setRestoredKey] = useState<string | null>(null)
  const openHrefRef = useRef<Workspace['openHref'] | null>(null)
  const ready = restoredKey === storageKey
  const [noteInfo, setNoteInfo] = useState<NoteInfo | null>(null)
  const owners = useRef(new Map<string, string>())
  const focusFrame = useRef<number | null>(null)
  const pendingFragments = useRef(new Map<string, { path: string; fragment: string }>())
  const readyReaders = useRef(new Map<string, string>())
  const tree = useQuery({ queryKey: ['notes/tree'], queryFn: api.tree })
  const commit = useCallback((next: WorkspaceState) => {
    for (const [id, path] of readyReaders.current) if (next.groups[id]?.activePath !== path) readyReaders.current.delete(id)
    const nextOwners = new Map<string, string>()
    for (const id of groupOrder(next.layout)) {
      const path = next.groups[id]?.activePath
      if (path && !nextOwners.has(path)) nextOwners.set(path, ownerFor(next, path, owners.current.get(path))!)
    }
    owners.current = nextOwners
    stateRef.current = next
    setState(next)
  }, [])
  const navigate = useCallback((next: WorkspaceState, mode: 'push' | 'replace', fragment?: string) => {
    const href = activeHref(next) + (fragment ? `#${encodeURIComponent(fragment)}` : '')
    if (window.location.pathname + window.location.search + window.location.hash === href) return
    window.dispatchEvent(new Event('workspace-navigation'))
    router[mode](href)
  }, [router])
  const setActiveGroup = useCallback((id: GroupId) => {
    const current = stateRef.current
    if (!current.groups[id] || current.activeGroupId === id) return
    const next = { ...current, activeGroupId: id }
    commit(next)
    navigate(next, 'replace')
  }, [commit, navigate])
  const focusGroup = useCallback((target: GroupId | number) => {
    const id = typeof target === 'number' ? groupOrder(stateRef.current.layout)[target] : target
    if (!id || !stateRef.current.groups[id]) return
    setActiveGroup(id)
    if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current)
    focusFrame.current = requestAnimationFrame(() => {
      focusFrame.current = null
      const region = Array.from(document.querySelectorAll<HTMLElement>('[data-workspace-group]')).find(element => element.dataset.workspaceGroup === id)
      const element = region?.querySelector<HTMLElement>('.cm-content[contenteditable="true"]') ?? region?.querySelector<HTMLElement>('[data-workspace-reader] > section > [tabindex="0"]') ?? region
      element?.focus({ preventScroll: true })
    })
  }, [setActiveGroup])
  useEffect(() => () => { if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current) }, [])
  const emitFragment = useCallback((id: string, clear = false) => {
    const pending = pendingFragments.current.get(id)
    if (!pending || stateRef.current.groups[id]?.activePath !== pending.path) return
    window.dispatchEvent(new CustomEvent('workspace-group-fragment', { detail: { groupId: id, ...pending } }))
    if (clear) pendingFragments.current.delete(id)
  }, [])
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ groupId: string; path: string }>).detail
      readyReaders.current.set(detail.groupId, detail.path)
      if (pendingFragments.current.get(detail.groupId)?.path === detail.path) emitFragment(detail.groupId, true)
    }
    window.addEventListener('workspace-reader-ready', listener)
    return () => window.removeEventListener('workspace-reader-ready', listener)
  }, [emitFragment])
  const queueFragment = useCallback((id: string, path: string, fragment?: string) => {
    pendingFragments.current.delete(id)
    if (!fragment) return
    pendingFragments.current.set(id, { path, fragment })
    requestAnimationFrame(() => emitFragment(id, readyReaders.current.get(id) === path))
  }, [emitFragment])
  useEffect(() => {
    let restored = createWorkspace()
    try {
      const saved = localStorage.getItem(storageKey)
      restored = saved !== null ? validateV2(JSON.parse(saved)) : migrateV1(JSON.parse(localStorage.getItem(`llmwiki.workspace.v1.${userId ?? 'default'}`) || 'null'))
    } catch { /* Private storage and stale sessions still allow an in-memory workspace. */ }
    if (urlPath) {
      const showing = restored.groups[restored.activeGroupId]?.activePath === urlPath ? restored.activeGroupId : groupOrder(restored.layout).find(id => restored.groups[id]?.activePath === urlPath)
      restored = visitGroup(restored, showing ?? restored.activeGroupId, urlPath, false, urlRef, undefined, urlQuery)
      if (!urlIsView) {
        const id = restored.activeGroupId
        restored = { ...restored, groups: { ...restored.groups, [id]: { ...restored.groups[id], ref: urlRef } } }
      }
    }
    commit(restored)
    setRestoredKey(storageKey)
  // The current URL is reconciled on restore; later changes are handled below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, commit])
  useEffect(() => {
    if (!ready || (!urlIsView && pathname !== '/wiki' && !pathname.startsWith('/wiki/'))) return
    const current = stateRef.current
    let next = current
    if (urlPath) {
      const showing = current.groups[current.activeGroupId]?.activePath === urlPath ? current.activeGroupId : groupOrder(current.layout).find(id => current.groups[id]?.activePath === urlPath)
      const id = showing ?? current.activeGroupId
      const group = current.groups[id]
      const tab = group.tabs.find(tab => tab.path === urlPath)
      if (!showing || (urlIsView ? tab?.query !== (urlQuery || undefined) : group.ref !== urlRef) || current.activeGroupId !== id) {
        next = visitGroup(current, id, urlPath, false, urlRef, new Set(Object.values(current.groups).flatMap(group => group.tabs.filter(tab => !isViewTab(tab.path) && getEditorStatus(tab.path)?.dirty).map(tab => tab.path))), urlQuery)
        if (!urlIsView && next.groups[id].ref !== urlRef) next = { ...next, groups: { ...next.groups, [id]: { ...next.groups[id], ref: urlRef } } }
      }
    } else if (searchParams.get('empty') === '1' && current.groups[current.activeGroupId]?.activePath) {
      const id = current.activeGroupId
      next = { ...current, groups: { ...current.groups, [id]: { ...current.groups[id], activePath: '', ref: undefined } } }
    }
    if (next !== current) commit(next)
  }, [urlPath, urlRef, urlQuery, urlIsView, pathname, searchParams, ready, commit])
  useEffect(() => {
    if (!ready) return
    try { localStorage.setItem(storageKey, JSON.stringify(state)) } catch { /* Storage may be unavailable. */ }
  }, [state, ready, storageKey])
  useEffect(() => subscribeEditorStatus(() => {
    const current = stateRef.current
    let changed = false
    const groups = Object.fromEntries(Object.entries(current.groups).map(([id, group]) => [id, { ...group, tabs: group.tabs.map(tab => {
      if (!isViewTab(tab.path) && !tab.pinned && getEditorStatus(tab.path)?.dirty) { changed = true; return { ...tab, pinned: true } }
      return tab
    }) }]))
    if (changed) commit({ ...current, groups })
  }), [commit])
  useEffect(() => {
    if (pathname !== '/wiki' || searchParams.get('empty') === '1' || !tree.data?.files.length || !ready) return
    const defaultPath = tree.data.files.includes('index.md') ? 'index.md' : tree.data.files[0]
    if (!confirmEditorLeave(leavingFor(stateRef.current, stateRef.current.activeGroupId, defaultPath))) return
    router.replace(noteHref(defaultPath))
  }, [pathname, searchParams, tree.data, ready, router])
  useEffect(() => {
    const sameDocument = (left: URL, right: URL) => left.origin === right.origin && left.pathname === right.pathname && left.search === right.search
    const confirmDestination = (destination: URL, groupId?: string) => {
      if (destination.origin !== window.location.origin || (!isViewRoute(destination.pathname) && destination.pathname !== '/wiki' && !destination.pathname.startsWith('/wiki/'))) return confirmEditorLeave(notePaths(Object.values(stateRef.current.groups).flatMap(group => group.tabs.map(tab => tab.path))))
      let path = ''
      try { path = isViewRoute(destination.pathname) ? viewTabPath(destination.pathname) : destination.pathname.slice(6).split('/').map(decodeURIComponent).join('/') } catch { return confirmEditorLeave(notePaths(Object.values(stateRef.current.groups).flatMap(group => group.tabs.map(tab => tab.path)))) }
      const current = stateRef.current
      if (groupId && current.groups[groupId]) return confirmEditorLeave(leavingFor(current, groupId, path))
      if (Object.values(current.groups).some(group => group.activePath === path && path)) return true
      return confirmEditorLeave(leavingFor(current, current.activeGroupId, path))
    }
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null
      if (!anchor || anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self')) return
      const destination = new URL(anchor.href, window.location.href)
      if (!['http:', 'https:'].includes(destination.protocol)) return
      const groupId = anchor.closest<HTMLElement>('[data-workspace-group]')?.dataset.workspaceGroup
      if (destination.origin === window.location.origin && isViewRoute(destination.pathname)) {
        event.preventDefault()
        event.stopImmediatePropagation()
        openHrefRef.current?.(destination.pathname + destination.search, { group: groupId })
        return
      }
      if (sameDocument(destination, new URL(window.location.href))) return
      if (!confirmDestination(destination, groupId)) { event.preventDefault(); event.stopImmediatePropagation() }
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const paths = notePaths(Object.values(stateRef.current.groups).flatMap(group => group.tabs.map(tab => tab.path)))
      if (!paths.some(path => getEditorStatus(path)?.dirty)) return
      event.preventDefault()
      event.returnValue = ''
    }
    // Keep our index in Next's history state so cancelled Back/Forward restores
    // the actual entry without pushing a duplicate or truncating forward history.
    const marker = '__workspaceEditorIndex'
    const history = window.history
    const originalPush = history.pushState
    const originalReplace = history.replaceState
    let index = typeof history.state?.[marker] === 'number' ? history.state[marker] as number : 0
    let acceptedUrl = new URL(window.location.href)
    let restoring = false
    const withIndex = (data: unknown, value: number) => ({ ...(data && typeof data === 'object' ? data : {}), [marker]: value })
    originalReplace.call(history, withIndex(history.state, index), '')
    const push: History['pushState'] = function(data, unused, url) {
      originalPush.call(history, withIndex(data, index + 1), unused, url)
      index += 1
      acceptedUrl = new URL(window.location.href)
    }
    const replace: History['replaceState'] = function(data, unused, url) {
      originalReplace.call(history, withIndex(data, index), unused, url)
      acceptedUrl = new URL(window.location.href)
    }
    history.pushState = push
    history.replaceState = replace
    const popstate = (event: PopStateEvent) => {
      if (restoring) { restoring = false; event.stopImmediatePropagation(); return }
      const destination = new URL(window.location.href)
      const destinationIndex = typeof event.state?.[marker] === 'number' ? event.state[marker] as number : null
      if (!sameDocument(destination, acceptedUrl) && !confirmDestination(destination)) {
        event.stopImmediatePropagation()
        restoring = true
        // An unmarked entry predates the provider and is behind its first entry.
        history.go(destinationIndex === null ? 1 : index - destinationIndex)
        return
      }
      index = destinationIndex ?? index - 1
      acceptedUrl = destination
      if (destinationIndex === null) originalReplace.call(history, withIndex(event.state, index), '')
    }
    document.addEventListener('click', click, true)
    window.addEventListener('beforeunload', beforeUnload)
    window.addEventListener('popstate', popstate, true)
    return () => {
      document.removeEventListener('click', click, true)
      window.removeEventListener('beforeunload', beforeUnload)
      window.removeEventListener('popstate', popstate, true)
      if (history.pushState === push) history.pushState = originalPush
      if (history.replaceState === replace) history.replaceState = originalReplace
    }
  }, [])
  const openNote = useCallback((path: string, options?: { pin?: boolean; fragment?: string; group?: GroupId | 'side'; ref?: string; query?: string; replace?: boolean }) => {
    if (!path) return
    let current = stateRef.current
    let id = options?.group ?? current.activeGroupId
    if (id === 'side') {
      const order = groupOrder(current.layout)
      id = order[order.indexOf(current.activeGroupId) + 1]
      if (!id) {
        id = freshGroupId(current)
        if (order.length >= MAX_EDITOR_GROUPS) { capNotice(); id = current.activeGroupId }
        else current = insertGroup(current, current.activeGroupId, 'right', { id, tabs: [], activePath: '' })
      }
    }
    if (!current.groups[id] || !confirmEditorLeave(leavingFor(current, id, path))) return
    const dirty = new Set(Object.values(current.groups).flatMap(group => group.tabs.filter(tab => !isViewTab(tab.path) && getEditorStatus(tab.path)?.dirty).map(tab => tab.path)))
    const next = visitGroup(current, id, path, options?.pin, isViewTab(path) ? undefined : options?.ref, dirty, options?.query)
    commit(next)
    queueFragment(id, path, isViewTab(path) ? undefined : options?.fragment)
    navigate(next, options?.replace ? 'replace' : 'push', isViewTab(path) ? undefined : options?.fragment)
    if (options?.group) focusGroup(id)
  }, [commit, queueFragment, navigate, focusGroup])
  const openHref = useCallback((href: string, options?: { group?: GroupId; replace?: boolean }) => {
    const url = new URL(href, window.location.href)
    const view = url.origin === window.location.origin && isViewRoute(url.pathname)
    const note = url.origin === window.location.origin && url.pathname.startsWith('/wiki/')
    if (!view && !note) {
      window.dispatchEvent(new Event('workspace-navigation'))
      router[options?.replace ? 'replace' : 'push'](href)
      return
    }
    const path = view ? viewTabPath(url.pathname) : url.pathname.slice(6).split('/').map(decodeURIComponent).join('/')
    const query = view ? url.searchParams.toString() : undefined
    const ref = note ? url.searchParams.get('ref') || undefined : undefined
    const fragment = note && url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined
    const current = stateRef.current
    const id = options?.group ?? current.activeGroupId
    if (!current.groups[id]) return
    if (id === current.activeGroupId) {
      openNote(path, { query, ref, fragment, replace: options?.replace, pin: note })
      return
    }
    // A mounted view in a background group owns its location, not the address bar.
    if (!confirmEditorLeave(leavingFor(current, id, path))) return
    const dirty = new Set(Object.values(current.groups).flatMap(group => group.tabs.filter(tab => !isViewTab(tab.path) && getEditorStatus(tab.path)?.dirty).map(tab => tab.path)))
    const next = visitGroup(current, id, path, note, ref, dirty, query)
    commit({ ...next, activeGroupId: current.activeGroupId })
    queueFragment(id, path, fragment)
  }, [openNote, commit, queueFragment, router])
  openHrefRef.current = openHref
  const moveTab = useCallback((source: { groupId: GroupId; path: string }, target: DropTarget, options?: { copy?: boolean }) => {
    const current = stateRef.current
    if (!current.groups[source.groupId]?.tabs.some(tab => tab.path === source.path) || !current.groups[target.groupId]) return
    if (target.kind === 'split' && source.groupId === target.groupId && current.groups[source.groupId].tabs.length === 1 && !options?.copy) return
    if (target.kind === 'split' && groupOrder(current.layout).length >= MAX_EDITOR_GROUPS) capNotice()
    const resolved: DropTarget = target.kind === 'split' && groupOrder(current.layout).length >= MAX_EDITOR_GROUPS ? { kind: 'group', groupId: target.groupId } : target
    if (resolved.kind !== 'split' && !confirmEditorLeave(leavingFor(current, resolved.groupId, source.path))) return
    const next = moveLayoutTab(current, source, resolved, options)
    if (next === current) return
    const oldOwner = ownerFor(current, source.path, owners.current.get(source.path))
    const newOwner = ownerFor(next, source.path, oldOwner)
    if (!isViewTab(source.path) && oldOwner !== newOwner && getEditorStatus(source.path)?.dirty) markDraftTransfer(source.path)
    commit(next)
    navigate(next, 'push')
    focusGroup(next.activeGroupId)
  }, [commit, navigate, focusGroup])
  const openNoteAt = useCallback((path: string, target: DropTarget) => {
    const current = stateRef.current
    if (!path || !current.groups[target.groupId]) return
    let next = current
    let id = target.groupId
    if (target.kind === 'split') {
      if (groupOrder(current.layout).length >= MAX_EDITOR_GROUPS) capNotice()
      else {
        id = freshGroupId(current)
        next = insertGroup(current, target.groupId, target.side, { id, tabs: [], activePath: '' })
      }
    }
    if (!confirmEditorLeave(leavingFor(next, id, path))) return
    next = visitGroup(next, id, path, true)
    if (target.kind === 'tabs') next = moveLayoutTab(next, { groupId: id, path }, target)
    commit(next)
    queueFragment(id, path)
    navigate(next, 'push')
    focusGroup(id)
  }, [commit, queueFragment, navigate, focusGroup])
  const splitEditor = useCallback((side: SplitSide = 'right') => {
    const current = stateRef.current
    const group = current.groups[current.activeGroupId]
    if (!group?.activePath) return
    if (groupOrder(current.layout).length >= MAX_EDITOR_GROUPS) { capNotice(); return }
    const next = moveLayoutTab(current, { groupId: group.id, path: group.activePath }, { kind: 'split', groupId: group.id, side }, { copy: true })
    commit(next)
    navigate(next, 'replace')
    focusGroup(next.activeGroupId)
  }, [commit, navigate, focusGroup])
  const closeTab = useCallback((path: string, groupId?: GroupId) => {
    const current = stateRef.current
    const id = groupId ?? current.activeGroupId
    const group = current.groups[id]
    const index = group?.tabs.findIndex(tab => tab.path === path) ?? -1
    if (!group || index < 0 || !confirmEditorLeave(notePaths([path]))) return
    const tab = group.tabs[index]
    const tabs = group.tabs.filter(item => item.path !== path)
    const activePath = group.activePath === path ? tabs[Math.min(index, tabs.length - 1)]?.path ?? '' : group.activePath
    let next = { ...current, groups: { ...current.groups, [id]: { ...group, tabs, activePath, ref: activePath === group.activePath ? group.ref : undefined } }, closed: [...current.closed, tab].slice(-20) }
    if (!tabs.length) next = removeGroup(next, id)
    pendingFragments.current.delete(id)
    commit(next)
    if (id === current.activeGroupId) { navigate(next, 'push'); focusGroup(next.activeGroupId) }
  }, [commit, navigate, focusGroup])
  const closeOthers = useCallback((path: string, groupId?: GroupId) => {
    const current = stateRef.current
    const id = groupId ?? current.activeGroupId
    const group = current.groups[id]
    if (!group?.tabs.some(tab => tab.path === path)) return
    const removed = group.tabs.filter(tab => tab.path !== path)
    if (!confirmEditorLeave(notePaths(removed.map(tab => tab.path)))) return
    const next = { ...current, groups: { ...current.groups, [id]: { ...group, tabs: group.tabs.filter(tab => tab.path === path), activePath: path, ref: group.activePath === path ? group.ref : undefined } }, closed: [...current.closed, ...removed].slice(-20) }
    commit(next)
    if (id === current.activeGroupId) navigate(next, 'push')
  }, [commit, navigate])
  const closeGroup = useCallback((id: GroupId) => {
    const current = stateRef.current
    const group = current.groups[id]
    if (!group || !confirmEditorLeave(notePaths(group.tabs.map(tab => tab.path)))) return
    const next = removeGroup({ ...current, closed: [...current.closed, ...group.tabs].slice(-20) }, id)
    pendingFragments.current.delete(id)
    commit(next)
    if (id === current.activeGroupId) { navigate(next, 'replace'); focusGroup(next.activeGroupId) }
  }, [commit, navigate, focusGroup])
  const pinTab = useCallback((path: string, groupId?: GroupId) => {
    const current = stateRef.current
    const id = groupId ?? current.activeGroupId
    const group = current.groups[id]
    if (group) commit({ ...current, groups: { ...current.groups, [id]: { ...group, tabs: group.tabs.map(tab => tab.path === path ? { ...tab, pinned: true } : tab) } } })
  }, [commit])
  const reopenClosed = useCallback(() => {
    const current = stateRef.current
    const tab = current.closed.at(-1)
    if (!tab || !confirmEditorLeave(leavingFor(current, current.activeGroupId, tab.path))) return
    const next = { ...visitGroup(current, current.activeGroupId, tab.path, tab.pinned, undefined, undefined, tab.query), closed: current.closed.slice(0, -1) }
    commit(next)
    navigate(next, 'push')
  }, [commit, navigate])
  const setSplitSizes = useCallback((id: string, sizes: number[]) => commit({ ...stateRef.current, layout: updateSizes(stateRef.current.layout, id, sizes) }), [commit])
  const resetSplitSizes = useCallback((id: string) => commit({ ...stateRef.current, layout: updateSizes(stateRef.current.layout, id) }), [commit])
  const isEditorOwner = useCallback((id: string, path: string) => ownerFor(stateRef.current, path, owners.current.get(path)) === id, [])
  const revealFolder = useCallback((path: string) => window.dispatchEvent(new CustomEvent('workspace-reveal', { detail: path })), [])
  const toggleFavorite = useCallback((path: string) => { if (isViewTab(path)) return; const current = stateRef.current; commit({ ...current, favoritePaths: current.favoritePaths.includes(path) ? current.favoritePaths.filter(item => item !== path) : [...current.favoritePaths, path] }) }, [commit])
  const rememberTitle = useCallback((path: string, title: string) => { if (isViewTab(path)) return; const current = stateRef.current; if (current.knownTitles[path] !== title) commit({ ...current, knownTitles: { ...current.knownTitles, [path]: title } }) }, [commit])
  const renameNotePath = useCallback((from: string, to: string) => {
    if (isViewTab(from) || isViewTab(to)) return
    const current = stateRef.current
    const next = renamePath(current, from, to)
    renameDraft(from, to)
    const owner = owners.current.get(from)
    if (owner) { owners.current.delete(from); owners.current.set(to, owner) }
    for (const [id, pending] of pendingFragments.current) if (pending.path === from) pendingFragments.current.set(id, { ...pending, path: to })
    commit(next)
    setNoteInfo(previous => previous?.path === from ? { ...previous, path: to } : previous)
    if (current.groups[current.activeGroupId]?.activePath === from) router.replace(activeHref(next) + window.location.hash)
  }, [commit, router])
  const removeNotePath = useCallback((path: string) => {
    if (isViewTab(path)) return
    const current = stateRef.current
    const next = removePath(current, path)
    clearDraft(path)
    for (const [id, pending] of pendingFragments.current) if (pending.path === path) pendingFragments.current.delete(id)
    commit(next)
    setNoteInfo(previous => previous?.path === path ? null : previous)
    if (current.groups[current.activeGroupId]?.activePath === path) navigate(next, 'replace')
  }, [commit, navigate])
  const activePath = state.groups[state.activeGroupId]?.activePath ?? ''
  const { closed: _closed, ...workspaceState } = state
  return <Context.Provider value={{ ...workspaceState, groupOrder: groupOrder(state.layout), activePath, setActiveGroup, focusGroup, openNote, openHref, openNoteAt, moveTab, splitEditor, closeTab, closeOthers, closeGroup, pinTab, reopenClosed, setSplitSizes, resetSplitSizes, isEditorOwner, revealFolder, toggleFavorite, rememberTitle, renameNotePath, removeNotePath, noteInfo: !isViewTab(activePath) && noteInfo?.path === activePath ? noteInfo : null, setNoteInfo }}>{children}</Context.Provider>
}

export function useWorkspace() {
  const workspace = useContext(Context)
  if (!workspace) throw new Error('useWorkspace must be used inside WorkspaceProvider')
  return workspace
}

export function useOptionalWorkspace() {
  return useContext(Context)
}
