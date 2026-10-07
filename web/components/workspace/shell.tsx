'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels'
import { ChevronDown, LogOut, Menu, PanelLeftClose, PanelLeftOpen, Search, Columns2, CircleHelp, X } from 'lucide-react'
import { api, type User } from '@/lib/api'
import { ErrorNotice } from '@/components/common'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useWorkspace } from './context'
import { panelRegistry, type PanelId } from './registry'
import { Palettes, type PaletteMode } from './palettes'
import { WorkspaceTabs } from './tabs'
import { WorkspaceStatus } from './status'

import { confirmEditorLeave } from '@/components/editor/state'
const roleLabels = { admin: '관리자', editor: '편집자', viewer: '조회자' }

export function WorkspaceShell({ user, children }: { user: User; children: ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const workspace = useWorkspace()
  const queryClient = useQueryClient()
  const sidebarRef = usePanelRef()
  const drawer = useRef<HTMLDialogElement>(null)
  const [mobile, setMobile] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [selected, setSelected] = useState<PanelId>('explorer')
  const [width, setWidth] = useState(280)
  const [ready, setReady] = useState(false)
  const [mode, setMode] = useState<PaletteMode>(null)
  const [logoutError, setLogoutError] = useState<unknown>(null)
  const [loggingOut, setLoggingOut] = useState(false)
  const storageKey = `llmwiki.shell.v1.${user.id}`
  const items = panelRegistry.filter(panel => !panel.admin || user.role === 'admin')
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)')
    const changed = () => setMobile(media.matches)
    changed()
    media.addEventListener('change', changed)
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null') as { selected: PanelId; collapsed: boolean; width: number } | null
      if (saved) {
        if (panelRegistry.some(panel => panel.id === saved.selected && (!panel.admin || user.role === 'admin'))) setSelected(saved.selected)
        if (typeof saved.collapsed === 'boolean') setCollapsed(saved.collapsed)
        if (Number.isFinite(saved.width)) setWidth(Math.min(480, Math.max(200, saved.width)))
      }
    } catch { /* Shell still works without local storage. */ }
    setReady(true)
    return () => media.removeEventListener('change', changed)
  }, [storageKey, user.role])
  useEffect(() => {
    if (ready) try { localStorage.setItem(storageKey, JSON.stringify({ selected, collapsed, width })) } catch { /* Storage may be unavailable. */ }
  }, [selected, collapsed, width, ready, storageKey])
  useEffect(() => {
    if (!ready || mobile || collapsed) sidebarRef.current?.collapse()
    else {
      // Let the group measure its desktop width before restoring a pixel size.
      let frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => sidebarRef.current?.resize(width))
      })
      return () => cancelAnimationFrame(frame)
    }
  }, [ready, mobile, collapsed, sidebarRef])
  useEffect(() => { setMobileOpen(false) }, [pathname])
  useEffect(() => {
    const closeDrawer = () => setMobileOpen(false)
    window.addEventListener('workspace-navigation', closeDrawer)
    return () => window.removeEventListener('workspace-navigation', closeDrawer)
  }, [])
  useEffect(() => {
    if (!mobileOpen || !mobile) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const element = drawer.current
    element?.showModal()
    return () => { element?.close(); previousFocus?.focus() }
  }, [mobileOpen, mobile])
  const selectPanel = useCallback((id: PanelId) => { setSelected(id); setCollapsed(false); if (mobile && (id === 'explorer' || id === 'links')) setMobileOpen(true) }, [mobile])
  const toggleSidebar = useCallback(() => { if (mobile) setMobileOpen(open => !open); else setCollapsed(value => !value) }, [mobile])
  useEffect(() => {
    const reveal = () => { selectPanel('explorer'); if (mobile) setMobileOpen(true) }
    window.addEventListener('workspace-reveal', reveal)
    return () => window.removeEventListener('workspace-reveal', reveal)
  }, [selectPanel, mobile])
  async function logout() {
    if (!confirmEditorLeave()) return
    setLoggingOut(true)
    try { await api.logout(); queryClient.clear(); window.location.assign('/') }
    catch (error) { setLogoutError(error); setLoggingOut(false) }
  }
  const activity = <nav aria-label="활동 표시줄" className="flex w-12 shrink-0 flex-col items-center gap-1 border-r bg-secondary py-2">{items.map(panel => <button type="button" key={panel.id} aria-label={`${panel.label} (${panel.key})`} title={panel.label} aria-pressed={selected === panel.id && !collapsed} className={cn('flex size-10 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground', selected === panel.id && !collapsed && 'bg-accent text-foreground')} onClick={() => {
    if (!mobile && selected === panel.id && !collapsed && pathname.startsWith(panel.href)) { setCollapsed(true); return }
    if (panel.id === 'links') { selectPanel(panel.id); return }
    if ((panel.id !== 'explorer' || (!mobile && !workspace.recentPaths[0])) && !confirmEditorLeave()) return
    selectPanel(panel.id)
    if (panel.id === 'explorer') {
      if (!mobile && workspace.recentPaths[0]) workspace.openNote(workspace.recentPaths[0])
      else if (!mobile) router.push(panel.href)
    } else router.push(panel.href)
    if (mobile && panel.id !== 'explorer') setMobileOpen(false)
  }}><panel.icon className="size-5" /></button>)}</nav>
  const panels = <div className="h-full min-h-0 bg-secondary">{items.map(panel => <div key={panel.id} hidden={selected !== panel.id} className="h-full min-h-0"><panel.component userId={user.id} /></div>)}</div>
  const main = <div className="flex h-full min-h-0 min-w-0 flex-col">{pathname.startsWith('/wiki') && <WorkspaceTabs />}<main id="main" tabIndex={-1} className={cn('min-h-0 flex-1 overflow-auto px-4 py-6 sm:px-6', pathname.startsWith('/wiki') && 'md:overflow-hidden')}><div className={cn('mx-auto w-full max-w-[1400px]', pathname.startsWith('/wiki') && 'md:h-full md:min-h-0')}>{Boolean(logoutError) && <div className="mb-4"><ErrorNotice error={logoutError} /></div>}{children}</div></main></div>
  return <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background"><a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:z-50 focus:bg-background focus:p-3">본문으로 이동</a><header className="flex h-12 shrink-0 items-center gap-2 border-b px-3"><Button variant="ghost" size="icon-sm" aria-label={mobile ? '메뉴 열기' : collapsed ? '사이드바 펼치기' : '사이드바 접기'} onClick={toggleSidebar}>{mobile ? <Menu /> : collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</Button><span className="mr-2 text-sm font-bold">LLM Wiki</span><Button variant="outline" className="h-8 min-w-0 flex-1 justify-start text-xs text-muted-foreground sm:max-w-72" onClick={() => setMode('quickopen')}><Search className="size-3.5" /><span className="truncate">노트 빠르게 열기</span><kbd className="ml-auto hidden sm:inline">⌘/Ctrl P</kbd></Button><Button variant="ghost" size="icon-sm" aria-label="명령 팔레트" onClick={() => setMode('commands')}><span className="font-mono text-xs">&gt;_</span></Button><Button variant="ghost" size="icon-sm" aria-label="분할 보기 전환" disabled={!workspace.activePath} aria-pressed={Boolean(workspace.splitPath)} onClick={workspace.toggleSplit}><Columns2 /></Button><Button variant="ghost" size="icon-sm" aria-label="단축키 도움말" className="hidden sm:inline-flex" onClick={() => setMode('help')}><CircleHelp /></Button><div className="ml-auto"><DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" className="gap-2 px-2" aria-label="사용자 메뉴" />}><span className="flex size-6 items-center justify-center rounded-full border bg-muted text-xs font-bold">{(user.name || user.email).slice(0, 1).toUpperCase()}</span><span className="hidden max-w-32 truncate text-xs lg:block">{user.name || user.email}</span><ChevronDown className="size-3" /></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-60"><DropdownMenuGroup><DropdownMenuLabel><span className="block truncate">{user.email}</span><span className="text-xs font-normal text-muted-foreground">{roleLabels[user.role]}</span></DropdownMenuLabel><DropdownMenuSeparator /><DropdownMenuItem disabled={loggingOut} onClick={() => void logout()}><LogOut className="size-4" />로그아웃</DropdownMenuItem></DropdownMenuGroup></DropdownMenuContent></DropdownMenu></div></header><div className="flex min-h-0 flex-1"><div className="hidden md:flex">{activity}</div><Group id="workspace-layout" orientation="horizontal" className="min-h-0 min-w-0 flex-1" onLayoutChanged={(_, { isUserInteraction }) => { if (!ready || mobile || !isUserInteraction) return; const size = sidebarRef.current?.getSize().inPixels; if (size === undefined) return; if (size >= 200) setWidth(size); setCollapsed(size === 0) }}><Panel id="workspace-sidebar" panelRef={sidebarRef} className="hidden md:block" defaultSize={!ready || mobile || collapsed ? 0 : width} minSize={200} maxSize={480} collapsible collapsedSize={0} groupResizeBehavior="preserve-pixel-size">{!mobile && ready && panels}</Panel><Separator aria-label="사이드바 너비 조절 (Resize Sidebar)" className="hidden w-1 shrink-0 bg-border hover:bg-ring focus-visible:bg-ring md:block" /><Panel id="workspace-main" minSize="30%">{main}</Panel></Group></div><WorkspaceStatus />{mobile && <dialog ref={drawer} aria-label="탐색 메뉴" className="workspace-drawer fixed inset-y-0 left-0 m-0 h-dvh max-h-none w-[min(360px,90vw)] max-w-none border-r bg-secondary p-0 text-foreground" onCancel={event => { event.preventDefault(); setMobileOpen(false) }} onClick={event => { if (event.target === event.currentTarget && event.clientX > event.currentTarget.getBoundingClientRect().right) setMobileOpen(false) }}><div className="flex h-12 items-center justify-between border-b px-3"><span className="text-sm font-bold">탐색 메뉴</span><Button autoFocus variant="ghost" size="icon-sm" aria-label="메뉴 닫기" onClick={() => setMobileOpen(false)}><X /></Button></div><div className="flex min-h-0" style={{height: 'calc(100dvh - 3rem)'}}>{activity}<div className="min-w-0 flex-1">{panels}</div></div></dialog>}<Palettes mode={mode} setMode={setMode} admin={user.role === 'admin'} selectPanel={selectPanel} toggleSidebar={toggleSidebar} /></div>
}
