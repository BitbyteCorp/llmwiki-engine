'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { noteHref } from '@/components/common'
import { api } from '@/lib/api'

export type WorkspaceTab = { path: string; pinned: boolean }
type NoteInfo = { path: string; updatedSha: string; body: string }
type StoredWorkspace = { tabs: WorkspaceTab[]; splitPath: string | null; favoritePaths: string[]; recentPaths: string[]; knownTitles: Record<string, string>; closed: WorkspaceTab[] }
type Workspace = Omit<StoredWorkspace, 'closed'> & {
  activePath: string
  openNote(path: string, options?: { pin?: boolean; split?: boolean; fragment?: string }): void
  closeTab(path: string): void
  pinTab(path: string): void
  closeOthers(path: string): void
  reopenClosed(): void
  toggleSplit(): void
  revealFolder(path: string): void
  toggleFavorite(path: string): void
  rememberTitle(path: string, title: string): void
  noteInfo: NoteInfo | null
  setNoteInfo(info: NoteInfo | null): void
}
const empty: StoredWorkspace = { tabs: [], splitPath: null, favoritePaths: [], recentPaths: [], knownTitles: {}, closed: [] }
const Context = createContext<Workspace | null>(null)
const key = 'llmwiki.workspace.v1'

function visit(state: StoredWorkspace, path: string, pin = false): StoredWorkspace {
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
  const storageKey = `${key}.${userId ?? 'default'}`
  const [state, setState] = useState<StoredWorkspace>(empty)
  const stateRef = useRef(state)
  stateRef.current = state
  const [ready, setReady] = useState(false)
  const searchParams = useSearchParams()
  const tree = useQuery({ queryKey: ['notes/tree'], queryFn: api.tree })
  useEffect(() => {
    if (pathname !== '/wiki' || searchParams.get('empty') === '1' || !tree.data?.files.length) return
    const defaultPath = tree.data.files.includes('index.md') ? 'index.md' : tree.data.files[0]
    router.replace(noteHref(defaultPath))
  }, [pathname, searchParams, tree.data, router])
  const [noteInfo, setNoteInfo] = useState<NoteInfo | null>(null)
  const [pendingSplitFragment, setPendingSplitFragment] = useState<{ path: string; fragment: string } | null>(null)
  useEffect(() => {
    if (!pendingSplitFragment || state.splitPath !== pendingSplitFragment.path) return
    window.dispatchEvent(new CustomEvent('workspace-split-fragment', { detail: pendingSplitFragment }))
    setPendingSplitFragment(null)
  }, [pendingSplitFragment, state.splitPath])
  useEffect(() => {
    let restored = empty
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null') as StoredWorkspace | null
      if (saved && Array.isArray(saved.tabs) && saved.tabs.every(tab => typeof tab.path === 'string' && typeof tab.pinned === 'boolean') && Array.isArray(saved.favoritePaths) && Array.isArray(saved.recentPaths) && Array.isArray(saved.closed) && saved.knownTitles && typeof saved.knownTitles === 'object' && (saved.splitPath === null || typeof saved.splitPath === 'string')) restored = saved
    } catch { /* Private storage and stale sessions still allow an in-memory workspace. */ }
    setState(restored)
    setReady(true)
  }, [storageKey])
  useEffect(() => {
    if (!ready || !activePath) return
    setState(previous => visit(previous, activePath))
  }, [activePath, ready])
  useEffect(() => {
    if (!ready) return
    try { localStorage.setItem(storageKey, JSON.stringify(state)) } catch { /* Storage may be unavailable. */ }
  }, [state, ready, storageKey])
  const openNote = useCallback((path: string, options?: { pin?: boolean; split?: boolean; fragment?: string }) => {
    if (options?.split) {
      setState(previous => ({ ...previous, splitPath: path }))
      if (options.fragment) setPendingSplitFragment({ path, fragment: options.fragment })
      return
    }
    setState(previous => visit(previous, path, options?.pin))
    window.dispatchEvent(new Event('workspace-navigation'))
    router.push(noteHref(path) + (options?.fragment ? `#${encodeURIComponent(options.fragment)}` : ''))
  }, [router])
  const closeTab = useCallback((path: string) => {
    const current = stateRef.current
    const tab = current.tabs.find(item => item.path === path)
    if (!tab) return
    const index = current.tabs.indexOf(tab)
    const remaining = current.tabs.filter(item => item.path !== path)
    setState(previous => ({ ...previous, tabs: remaining, closed: [...previous.closed, tab].slice(-20) }))
    if (path === activePath) router.push(remaining[Math.min(index, remaining.length - 1)] ? noteHref(remaining[Math.min(index, remaining.length - 1)].path) : '/wiki?empty=1')
  }, [activePath, router])
  const pinTab = useCallback((path: string) => setState(previous => ({ ...previous, tabs: previous.tabs.map(tab => tab.path === path ? { ...tab, pinned: true } : tab) })), [])
  const closeOthers = useCallback((path: string) => {
    setState(previous => ({ ...previous, tabs: previous.tabs.filter(tab => tab.path === path), closed: [...previous.closed, ...previous.tabs.filter(tab => tab.path !== path)].slice(-20) }))
    router.push(noteHref(path))
  }, [router])
  const reopenClosed = useCallback(() => {
    const tab = stateRef.current.closed.at(-1)
    if (!tab) return
    setState(previous => ({ ...visit(previous, tab.path, tab.pinned), closed: previous.closed.slice(0, -1) }))
    router.push(noteHref(tab.path))
  }, [router])
  const toggleSplit = useCallback(() => setState(previous => ({ ...previous, splitPath: previous.splitPath ? null : activePath || null })), [activePath])
  const revealFolder = useCallback((path: string) => window.dispatchEvent(new CustomEvent('workspace-reveal', { detail: path })), [])
  const toggleFavorite = useCallback((path: string) => setState(previous => ({ ...previous, favoritePaths: previous.favoritePaths.includes(path) ? previous.favoritePaths.filter(item => item !== path) : [...previous.favoritePaths, path] })), [])
  const rememberTitle = useCallback((path: string, title: string) => setState(previous => previous.knownTitles[path] === title ? previous : { ...previous, knownTitles: { ...previous.knownTitles, [path]: title } }), [])
  return <Context.Provider value={{ ...state, activePath, openNote, closeTab, pinTab, closeOthers, reopenClosed, toggleSplit, revealFolder, toggleFavorite, rememberTitle, noteInfo: noteInfo?.path === activePath ? noteInfo : null, setNoteInfo }}>{children}</Context.Provider>
}

export function useWorkspace() {
  const workspace = useContext(Context)
  if (!workspace) throw new Error('useWorkspace must be used inside WorkspaceProvider')
  return workspace
}

export function useOptionalWorkspace() {
  return useContext(Context)
}
