'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { noteHref } from '@/components/common'
import { api } from '@/lib/api'
import { confirmEditorLeave, getEditorStatus, useEditorStatus } from '@/components/editor/state'

export type WorkspaceTab = { path: string; pinned: boolean }
type NoteInfo = { path: string; updatedSha: string; body: string }
type StoredWorkspace = { tabs: WorkspaceTab[]; splitPath: string | null; splitRatio: number; favoritePaths: string[]; recentPaths: string[]; knownTitles: Record<string, string>; closed: WorkspaceTab[] }
export type Workspace = Omit<StoredWorkspace, 'closed'> & {
  activePath: string
  activeGroup: 1 | 2
  activeGroupPath: string
  setActiveGroup(group: 1 | 2): void
  focusGroup(group: 1 | 2): void
  closeSplit(): void
  setSplitRatio(ratio: number): void
  openNote(path: string, options?: { pin?: boolean; split?: boolean; fragment?: string }): void
  closeTab(path: string): void
  pinTab(path: string): void
  closeOthers(path: string): void
  reopenClosed(): void
  toggleSplit(): void
  revealFolder(path: string): void
  toggleFavorite(path: string): void
  rememberTitle(path: string, title: string): void
  renameNotePath(from: string, to: string): void
  removeNotePath(path: string): void
  noteInfo: NoteInfo | null
  setNoteInfo(info: NoteInfo | null): void
}
const empty: StoredWorkspace = { tabs: [], splitPath: null, splitRatio: 0.5, favoritePaths: [], recentPaths: [], knownTitles: {}, closed: [] }
const Context = createContext<Workspace | null>(null)
const key = 'llmwiki.workspace.v1'

function clampSplitRatio(ratio: unknown): number {
  return typeof ratio === 'number' && Number.isFinite(ratio) ? Math.min(0.8, Math.max(0.2, ratio)) : 0.5
}

function visit(state: StoredWorkspace, path: string, pin = false): StoredWorkspace {
  state = { ...state, tabs: state.tabs.map(tab => !tab.pinned && getEditorStatus(tab.path)?.dirty ? { ...tab, pinned: true } : tab) }
  const existing = state.tabs.find(tab => tab.path === path)
  let tabs: WorkspaceTab[]
  if (existing) tabs = pin ? state.tabs.map(tab => tab.path === path ? { ...tab, pinned: true } : tab) : state.tabs
  else {
    const preview = state.tabs.findIndex(tab => !tab.pinned)
    tabs = [...state.tabs]
    if (!pin && preview !== -1) tabs[preview] = { path, pinned: false }
    else tabs.push({ path, pinned: pin })
  }
  return { ...state, tabs, recentPaths: [path, ...state.recentPaths.filter(item => item !== path)].slice(0, 30) }
}

export function WorkspaceProvider({ children, userId }: { children: ReactNode; userId?: number }) {
  const pathname = usePathname()
  const router = useRouter()
  const activePath = pathname.startsWith('/wiki/') ? pathname.slice(6).split('/').map(decodeURIComponent).join('/') : ''
  const activePathRef = useRef(activePath)
  activePathRef.current = activePath
  const storageKey = `${key}.${userId ?? 'default'}`
  const [state, setState] = useState<StoredWorkspace>(empty)
  const stateRef = useRef(state)
  stateRef.current = state
  const [restoredKey, setRestoredKey] = useState<string | null>(null)
  const ready = restoredKey === storageKey
  const [activeGroup, setActiveGroup] = useState<1 | 2>(1)
  const currentGroup = state.splitPath && activeGroup === 2 ? 2 : 1
  const focusFrame = useRef<number | null>(null)
  const focusGroup = useCallback((group: 1 | 2) => {
    setActiveGroup(group)
    if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current)
    focusFrame.current = requestAnimationFrame(() => {
      focusFrame.current = null
      const selected = group === 2 && stateRef.current.splitPath ? 2 : 1
      const region = document.querySelector<HTMLElement>(`[data-workspace-group="${selected}"]`)
      const target = region?.querySelector<HTMLElement>('.cm-content[contenteditable="true"]')
        ?? region?.querySelector<HTMLElement>('[data-workspace-reader] > section > [tabindex="0"]')
        ?? region
      target?.focus({ preventScroll: true })
    })
  }, [])
  useEffect(() => () => { if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current) }, [])
  useEffect(() => { if (!state.splitPath) setActiveGroup(1) }, [state.splitPath])
  const setSplitRatio = useCallback((ratio: number) => {
    const splitRatio = clampSplitRatio(ratio)
    setState(previous => previous.splitRatio === splitRatio ? previous : { ...previous, splitRatio })
  }, [])
  const searchParams = useSearchParams()
  const tree = useQuery({ queryKey: ['notes/tree'], queryFn: api.tree })
  const activeEditor = useEditorStatus(activePath)
  const splitEditor = useEditorStatus(state.splitPath ?? '')
  useEffect(() => {
    if (!activeEditor?.dirty && !splitEditor?.dirty) return
    setState(previous => {
      const tabs = previous.tabs.map(tab => !tab.pinned && getEditorStatus(tab.path)?.dirty ? { ...tab, pinned: true } : tab)
      return tabs.some((tab, index) => tab !== previous.tabs[index]) ? { ...previous, tabs } : previous
    })
  }, [activeEditor?.dirty, splitEditor?.dirty])
  useEffect(() => {
    const sameDocument = (left: URL, right: URL) => left.origin === right.origin && left.pathname === right.pathname && left.search === right.search
    const confirmDestination = (destination: URL) => {
      if (destination.origin !== window.location.origin || (destination.pathname !== '/wiki' && !destination.pathname.startsWith('/wiki/'))) return confirmEditorLeave()
      let path = ''
      try { path = destination.pathname.slice(6).split('/').map(decodeURIComponent).join('/') } catch { return confirmEditorLeave() }
      const leaving = activePathRef.current ? [activePathRef.current] : []
      if (path !== activePathRef.current && path === stateRef.current.splitPath) leaving.push(path)
      return confirmEditorLeave(leaving)
    }
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null
      if (!anchor || anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self')) return
      const destination = new URL(anchor.href, window.location.href)
      if (!['http:', 'https:'].includes(destination.protocol) || sameDocument(destination, new URL(window.location.href))) return
      if (!confirmDestination(destination)) { event.preventDefault(); event.stopImmediatePropagation() }
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const current = stateRef.current
      const paths = [activePathRef.current, current.splitPath ?? '', ...current.tabs.map(tab => tab.path)]
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
      if (restoring) {
        restoring = false
        event.stopImmediatePropagation()
        return
      }
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
  useEffect(() => {
    if (pathname !== '/wiki' || searchParams.get('empty') === '1' || !tree.data?.files.length) return
    const defaultPath = tree.data.files.includes('index.md') ? 'index.md' : tree.data.files[0]
    if (stateRef.current.splitPath === defaultPath && !confirmEditorLeave([defaultPath])) return
    router.replace(noteHref(defaultPath))
  }, [pathname, searchParams, tree.data, router])
  const [noteInfo, setNoteInfo] = useState<NoteInfo | null>(null)
  const [pendingSplitFragment, setPendingSplitFragment] = useState<{ path: string; fragment: string } | null>(null)
  useEffect(() => {
    if (!pendingSplitFragment || state.splitPath !== pendingSplitFragment.path || !pathname.startsWith('/wiki')) return
    const frame = requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('workspace-split-fragment', { detail: pendingSplitFragment }))
      setPendingSplitFragment(null)
    })
    return () => cancelAnimationFrame(frame)
  }, [pendingSplitFragment, state.splitPath, pathname])
  useEffect(() => {
    let restored = empty
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null') as StoredWorkspace | null
      if (saved && Array.isArray(saved.tabs) && saved.tabs.every(tab => typeof tab.path === 'string' && typeof tab.pinned === 'boolean') && Array.isArray(saved.favoritePaths) && Array.isArray(saved.recentPaths) && Array.isArray(saved.closed) && saved.knownTitles && typeof saved.knownTitles === 'object' && (saved.splitPath === null || typeof saved.splitPath === 'string')) restored = { ...saved, splitRatio: clampSplitRatio(saved.splitRatio) }
    } catch { /* Private storage and stale sessions still allow an in-memory workspace. */ }
    setState(restored)
    setActiveGroup(1)
    setRestoredKey(storageKey)
  }, [storageKey])
  useEffect(() => {
    if (!ready || !activePath) return
    setState(previous => visit(previous, activePath))
  }, [activePath, ready])
  useEffect(() => {
    if (!ready) return
    try { localStorage.setItem(storageKey, JSON.stringify(state)) } catch { /* Storage may be unavailable. */ }
  }, [state, ready, storageKey])
  const confirmPrimaryNavigation = useCallback((path: string, closing: string[] = []) => {
    const leaving = [...closing]
    if (activePathRef.current !== path) {
      if (activePathRef.current) leaving.push(activePathRef.current)
      if (stateRef.current.splitPath === path) leaving.push(path)
    }
    return confirmEditorLeave(leaving)
  }, [])
  const openNote = useCallback((path: string, options?: { pin?: boolean; split?: boolean; fragment?: string }) => {
    const current = stateRef.current
    if (options?.split) {
      if (!confirmEditorLeave(current.splitPath && current.splitPath !== path && current.splitPath !== activePathRef.current ? [current.splitPath] : [])) return
    } else if (!confirmPrimaryNavigation(path)) return
    if (options?.split) {
      setState(previous => ({ ...previous, splitPath: path }))
      setPendingSplitFragment(options.fragment ? { path, fragment: options.fragment } : null)
      focusGroup(2)
      return
    }
    setState(previous => visit(previous, path, options?.pin))
    setActiveGroup(1)
    window.dispatchEvent(new Event('workspace-navigation'))
    router.push(noteHref(path) + (options?.fragment ? `#${encodeURIComponent(options.fragment)}` : ''))
  }, [router, confirmPrimaryNavigation, focusGroup])
  const closeTab = useCallback((path: string) => {
    const current = stateRef.current
    const tab = current.tabs.find(item => item.path === path)
    if (!tab) return
    const index = current.tabs.indexOf(tab)
    const remaining = current.tabs.filter(item => item.path !== path)
    const nextPath = remaining[Math.min(index, remaining.length - 1)]?.path ?? ''
    if (path === activePath ? !confirmPrimaryNavigation(nextPath, [path]) : !confirmEditorLeave([path])) return
    setState(previous => ({ ...previous, tabs: remaining, splitPath: previous.splitPath === path ? null : previous.splitPath, closed: [...previous.closed, tab].slice(-20) }))
    if (path === activePath) router.push(nextPath ? noteHref(nextPath) : '/wiki?empty=1')
  }, [activePath, router, confirmPrimaryNavigation])
  const pinTab = useCallback((path: string) => setState(previous => ({ ...previous, tabs: previous.tabs.map(tab => tab.path === path ? { ...tab, pinned: true } : tab) })), [])
  const closeOthers = useCallback((path: string) => {
    const leaving = stateRef.current.tabs.filter(tab => tab.path !== path).map(tab => tab.path)
    if (!confirmPrimaryNavigation(path, leaving)) return
    setState(previous => ({ ...previous, tabs: previous.tabs.filter(tab => tab.path === path), closed: [...previous.closed, ...previous.tabs.filter(tab => tab.path !== path)].slice(-20) }))
    router.push(noteHref(path))
  }, [router, confirmPrimaryNavigation])
  const reopenClosed = useCallback(() => {
    const tab = stateRef.current.closed.at(-1)
    if (!tab) return
    if (!confirmPrimaryNavigation(tab.path)) return
    setState(previous => ({ ...visit(previous, tab.path, tab.pinned), closed: previous.closed.slice(0, -1) }))
    router.push(noteHref(tab.path))
  }, [router, confirmPrimaryNavigation])
  const closeSplit = useCallback(() => {
    const splitPath = stateRef.current.splitPath
    if (!splitPath || (splitPath !== activePathRef.current && !confirmEditorLeave([splitPath]))) return
    setPendingSplitFragment(null)
    setState(previous => ({ ...previous, splitPath: null }))
    focusGroup(1)
  }, [focusGroup])
  const toggleSplit = useCallback(() => {
    if (stateRef.current.splitPath) { closeSplit(); return }
    if (!activePathRef.current) return
    setPendingSplitFragment(null)
    setState(previous => ({ ...previous, splitPath: activePathRef.current }))
    focusGroup(2)
  }, [closeSplit, focusGroup])
  const revealFolder = useCallback((path: string) => window.dispatchEvent(new CustomEvent('workspace-reveal', { detail: path })), [])
  const toggleFavorite = useCallback((path: string) => setState(previous => ({ ...previous, favoritePaths: previous.favoritePaths.includes(path) ? previous.favoritePaths.filter(item => item !== path) : [...previous.favoritePaths, path] })), [])
  const rememberTitle = useCallback((path: string, title: string) => setState(previous => previous.knownTitles[path] === title ? previous : { ...previous, knownTitles: { ...previous.knownTitles, [path]: title } }), [])
  const renameNotePath = useCallback((from: string, to: string) => {
    const move = (path: string) => path === from ? to : path
    const migrateTabs = (tabs: WorkspaceTab[]) => {
      const merged: WorkspaceTab[] = []
      for (const tab of tabs) {
        const path = move(tab.path)
        const existing = merged.find(item => item.path === path)
        if (existing) existing.pinned ||= tab.pinned
        else merged.push({ ...tab, path })
      }
      return merged
    }
    setState(previous => {
      const knownTitles = { ...previous.knownTitles }
      if (Object.hasOwn(knownTitles, from)) { knownTitles[to] = knownTitles[from]; delete knownTitles[from] }
      return {
        ...previous,
        tabs: migrateTabs(previous.tabs),
        splitPath: previous.splitPath === from ? to : previous.splitPath,
        favoritePaths: [...new Set(previous.favoritePaths.map(move))],
        recentPaths: [...new Set(previous.recentPaths.map(move))],
        closed: previous.closed.map(tab => ({ ...tab, path: move(tab.path) })),
        knownTitles,
      }
    })
    setNoteInfo(previous => previous?.path === from ? { ...previous, path: to } : previous)
    setPendingSplitFragment(previous => previous?.path === from ? { ...previous, path: to } : previous)
    if (activePathRef.current === from) router.replace(noteHref(to) + window.location.search + window.location.hash)
  }, [router])
  const removeNotePath = useCallback((path: string) => {
    const remaining = stateRef.current.tabs.filter(tab => tab.path !== path)
    const next = remaining.find(tab => tab.path !== stateRef.current.splitPath || !getEditorStatus(tab.path)?.dirty)
    setState(previous => {
      const knownTitles = { ...previous.knownTitles }
      delete knownTitles[path]
      return {
        ...previous,
        tabs: previous.tabs.filter(tab => tab.path !== path),
        splitPath: previous.splitPath === path ? null : previous.splitPath,
        favoritePaths: previous.favoritePaths.filter(item => item !== path),
        recentPaths: previous.recentPaths.filter(item => item !== path),
        closed: previous.closed.filter(tab => tab.path !== path),
        knownTitles,
      }
    })
    setNoteInfo(previous => previous?.path === path ? null : previous)
    setPendingSplitFragment(previous => previous?.path === path ? null : previous)
    if (activePathRef.current === path) router.replace(next ? noteHref(next.path) : '/wiki?empty=1')
  }, [router])
  return <Context.Provider value={{ ...state, activePath, activeGroup: currentGroup, activeGroupPath: currentGroup === 2 ? state.splitPath! : activePath, setActiveGroup, focusGroup, closeSplit, setSplitRatio, openNote, closeTab, pinTab, closeOthers, reopenClosed, toggleSplit, revealFolder, toggleFavorite, rememberTitle, renameNotePath, removeNotePath, noteInfo: noteInfo?.path === activePath ? noteInfo : null, setNoteInfo }}>{children}</Context.Provider>
}

export function useWorkspace() {
  const workspace = useContext(Context)
  if (!workspace) throw new Error('useWorkspace must be used inside WorkspaceProvider')
  return workspace
}

export function useOptionalWorkspace() {
  return useContext(Context)
}
