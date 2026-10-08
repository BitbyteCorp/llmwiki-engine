'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { useTheme } from 'next-themes'
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels'
import { ChevronDown, LogOut, Menu, PanelLeftClose, PanelLeftOpen, Search, Columns2, CircleHelp, X, Settings, MessagesSquare, Sun, Moon, Monitor } from 'lucide-react'
import { api, type User } from '@/lib/api'
import { CHAT_OPEN_EVENT, openChat, type ChatOpenRequest } from '@/lib/chat-context'
import { ErrorNotice } from '@/components/common'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { Notifications } from '@/components/notifications'
import { ChatPane } from '@/components/chat/chat-pane'
import { cn } from '@/lib/utils'
import { MAX_EDITOR_GROUPS, useWorkspace } from './context'
import { isViewRoute } from './layout'
import { panelRegistry, type PanelId } from './registry'
import { Palettes, type PaletteMode } from './palettes'
import { useWorkspaceKeybindings, shortcutHint, useShortcutPlatform } from './keybindings'
import { WorkspaceStatus } from './status'
import { confirmEditorLeave } from '@/components/editor/state'

const roleLabels = { admin: '관리자', editor: '편집자', viewer: '조회자' }
type ShellLayout = { selected: PanelId; collapsed: boolean; width: number; chatCollapsed: boolean; chatWidth: number }
const defaults: ShellLayout = { selected: 'explorer', collapsed: false, width: 280, chatCollapsed: true, chatWidth: 400 }
const separatorClass = 'w-px shrink-0 bg-border hover:bg-ring focus-visible:bg-ring'

export function WorkspaceShell({ user, children }: { user: User; children: ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const workspace = useWorkspace()
  const queryClient = useQueryClient()
  const { theme, resolvedTheme, setTheme } = useTheme()
  const shortcutPlatform = useShortcutPlatform()
  const sidebarRef = usePanelRef()
  const chatRef = usePanelRef()
  const drawer = useRef<HTMLDialogElement>(null)
  const primary = useRef<HTMLDivElement>(null)
  const secondary = useRef<HTMLDivElement>(null)
  const initial = useRef(defaults)
  const [layout, setLayout] = useState<ShellLayout>(defaults)
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const [mobile, setMobile] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [restoredKey, setRestoredKey] = useState<string | null>(null)
  const [mode, setMode] = useState<PaletteMode>(null)
  const [logoutError, setLogoutError] = useState<unknown>(null)
  const [loggingOut, setLoggingOut] = useState(false)
  const storageKey = `llmwiki.shell.v2.${user.id}`
  const ready = restoredKey === storageKey
  const isChat = pathname === '/chat' || pathname.startsWith('/chat/')
  const isWorkspaceRoute = pathname === '/wiki' || pathname.startsWith('/wiki/') || isViewRoute(pathname)
  const items = panelRegistry.filter(panel => !panel.admin || user.role === 'admin')
  useLayoutEffect(() => {
    const media = window.matchMedia('(max-width: 767px)')
    const changed = () => {
      setMobile(media.matches)
      setMobileOpen(false)
      if (!media.matches && window.innerWidth < 810 && !layoutRef.current.chatCollapsed) {
        sidebarRef.current?.collapse()
        setLayout(previous => previous.collapsed ? previous : { ...previous, collapsed: true })
      }
    }
    changed()
    media.addEventListener('change', changed)
    window.addEventListener('resize', changed)
    let restored = { ...defaults }
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || localStorage.getItem(`llmwiki.shell.v1.${user.id}`) || 'null') as Partial<ShellLayout> | null
      if (saved) {
        if (panelRegistry.some(panel => panel.id === saved.selected && (!panel.admin || user.role === 'admin'))) restored.selected = saved.selected!
        if (typeof saved.collapsed === 'boolean') restored.collapsed = saved.collapsed
        if (typeof saved.chatCollapsed === 'boolean') restored.chatCollapsed = saved.chatCollapsed
        if (typeof saved.width === 'number' && Number.isFinite(saved.width)) restored.width = Math.min(480, Math.max(200, saved.width))
        if (typeof saved.chatWidth === 'number' && Number.isFinite(saved.chatWidth)) restored.chatWidth = Math.min(700, Math.max(300, saved.chatWidth))
      }
    } catch { /* Private storage and invalid saved layouts use defaults. */ }
    if (!media.matches && window.innerWidth < 810 && !restored.chatCollapsed) restored.collapsed = true
    initial.current = restored
    setLayout(restored)
    setRestoredKey(storageKey)
    return () => { media.removeEventListener('change', changed); window.removeEventListener('resize', changed) }
  }, [storageKey, user.id, user.role])
  useEffect(() => {
    if (ready) try { localStorage.setItem(storageKey, JSON.stringify(layout)) } catch { /* In-memory resizing remains available. */ }
  }, [layout, ready, storageKey])
  // Only breakpoint/route changes restore sizes. Drag callbacks never resize panels.
  useLayoutEffect(() => {
    if (!ready) return
    const current = layoutRef.current
    if (mobile || current.collapsed) sidebarRef.current?.collapse()
    else sidebarRef.current?.resize(current.width)
    if (mobile || isChat || current.chatCollapsed) chatRef.current?.collapse()
    else chatRef.current?.resize(current.chatWidth)
  }, [ready, mobile, isChat, sidebarRef, chatRef])
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
  const setSidebarCollapsed = useCallback((collapsed: boolean) => {
    if (mobile) { setMobileOpen(!collapsed); return }
    if (collapsed) sidebarRef.current?.collapse()
    else {
      if (window.innerWidth < 810 && !isChat) {
        chatRef.current?.collapse()
        setLayout(previous => ({ ...previous, chatCollapsed: true }))
      }
      sidebarRef.current?.resize(layoutRef.current.width)
    }
    setLayout(previous => ({ ...previous, collapsed }))
  }, [mobile, isChat, sidebarRef, chatRef])
  const selectPanel = useCallback((id: PanelId) => {
    setLayout(previous => ({ ...previous, selected: id }))
    setSidebarCollapsed(false)
    requestAnimationFrame(() => primary.current?.querySelector<HTMLElement>(`[data-panel-id="${id}"] input, [data-panel-id="${id}"] button`)?.focus())
  }, [setSidebarCollapsed])
  const toggleSidebar = useCallback(() => {
    if (mobile) setMobileOpen(open => !open)
    else setSidebarCollapsed(!layoutRef.current.collapsed)
  }, [mobile, setSidebarCollapsed])
  const setChatCollapsed = useCallback((chatCollapsed: boolean) => {
    if (mobile || isChat) { if (!chatCollapsed) openChat(); return }
    if (chatCollapsed) chatRef.current?.collapse()
    else {
      if (window.innerWidth < 810) {
        sidebarRef.current?.collapse()
        setLayout(previous => ({ ...previous, collapsed: true }))
      }
      chatRef.current?.resize(layoutRef.current.chatWidth)
    }
    setLayout(previous => ({ ...previous, chatCollapsed }))
  }, [mobile, isChat, chatRef, sidebarRef])
  const toggleChat = useCallback(() => {
    if (mobile || isChat) openChat()
    else setChatCollapsed(!layoutRef.current.chatCollapsed)
  }, [mobile, isChat, setChatCollapsed])
  useWorkspaceKeybindings({ setMode, selectPanel, toggleSidebar, toggleChat, mobile })
  useEffect(() => {
    const reveal = () => selectPanel('explorer')
    window.addEventListener('workspace-reveal', reveal)
    return () => window.removeEventListener('workspace-reveal', reveal)
  }, [selectPanel])
  useEffect(() => {
    const chatOpen = (event: Event) => {
      const request = (event as CustomEvent<ChatOpenRequest>).detail ?? {}
      if (mobile || isChat) {
        if (!confirmEditorLeave()) return
        router.push(request.newThread ? '/chat?new=1' : request.conversationId ? `/chat/${encodeURIComponent(request.conversationId)}` : request.focusSearch ? '/chat?search=1' : '/chat')
      } else {
        setChatCollapsed(false)
        requestAnimationFrame(() => secondary.current?.querySelector<HTMLElement>(request.focusSearch ? 'input' : 'textarea')?.focus())
      }
    }
    window.addEventListener(CHAT_OPEN_EVENT, chatOpen)
    return () => window.removeEventListener(CHAT_OPEN_EVENT, chatOpen)
  }, [mobile, isChat, router, setChatCollapsed])
  async function logout() {
    if (!confirmEditorLeave()) return
    setLoggingOut(true)
    try { await api.logout(); queryClient.clear(); window.location.assign('/') }
    catch (error) { setLogoutError(error); setLoggingOut(false) }
  }
  function navigate(href: string) { if (confirmEditorLeave()) router.push(href) }
  function resetPanel(side: 'primary' | 'secondary') {
    const width = side === 'primary' ? defaults.width : defaults.chatWidth
    if (side === 'primary') { sidebarRef.current?.resize(width); setLayout(previous => ({ ...previous, width, collapsed: false })) }
    else { chatRef.current?.resize(width); setLayout(previous => ({ ...previous, chatWidth: width, chatCollapsed: false })) }
  }
  const activityExpanded = mobile ? mobileOpen : !layout.collapsed
  const selectedActivityIndex = items.findIndex(panel => panel.id === layout.selected)
  const activity = <nav aria-label="활동 표시줄" className="workspace-activity flex w-12 shrink-0 flex-col items-center gap-1 border-r bg-secondary py-2">
    <span aria-hidden="true" className="workspace-activity-indicator" style={{ top: 8, height: 40, transform: `translateY(${Math.max(0, selectedActivityIndex) * 44}px)`, opacity: selectedActivityIndex < 0 ? 0 : activityExpanded ? 1 : 0.35 }} />
    {items.map(panel => <button type="button" key={panel.id} aria-label={`${panel.label} (${panel.key})`} title={panel.label} aria-pressed={layout.selected === panel.id && activityExpanded} className={cn('flex size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground', layout.selected === panel.id && activityExpanded && 'bg-accent text-foreground')} onClick={() => {
      if (!mobile && layout.selected === panel.id && !layout.collapsed) setSidebarCollapsed(true)
      else selectPanel(panel.id)
    }}><panel.icon className="size-5" /></button>)}
    <Button variant="ghost" size="icon-sm" className="mt-auto" aria-label="설정" title={`설정 (${shortcutHint('settings', shortcutPlatform)})`} onClick={() => navigate('/settings')}><Settings /></Button>
  </nav>
  const panels = <div ref={primary} className="h-full min-h-0 bg-secondary">{items.map(panel => <div key={panel.id} data-panel-id={panel.id} hidden={layout.selected !== panel.id} className="h-full min-h-0"><panel.component userId={user.id} /></div>)}</div>
  const main = <div className="flex h-full min-h-0 min-w-0 flex-col"><main id="main" tabIndex={-1} className={cn('min-h-0 flex-1', isWorkspaceRoute ? 'overflow-hidden' : 'overflow-auto px-5 py-4')}><div className={isWorkspaceRoute ? 'h-full min-h-0 min-w-0' : 'mx-auto w-full max-w-6xl'}>{Boolean(logoutError) && <div className="mb-3"><ErrorNotice error={logoutError} /></div>}{children}</div></main></div>
  return <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background"><a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:z-50 focus:bg-background focus:p-3">본문으로 이동</a><header className="flex h-11 shrink-0 items-center gap-1 border-b px-2 sm:gap-2 sm:px-3"><Button variant="ghost" size="icon-sm" aria-label={mobile ? '메뉴 열기' : layout.collapsed ? '사이드바 펼치기' : '사이드바 접기'} title={shortcutHint('sidebar', shortcutPlatform)} onClick={toggleSidebar}>{mobile ? <Menu /> : layout.collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}</Button><span className="mr-2 hidden text-sm font-bold sm:inline">LLM Wiki</span><Button variant="outline" className="h-8 min-w-0 flex-1 justify-start text-xs text-muted-foreground sm:max-w-72" onClick={() => setMode('quickopen')}><Search className="size-3.5" /><span className="truncate">노트 빠르게 열기</span><kbd className="ml-auto hidden sm:inline">{shortcutHint('quickopen', shortcutPlatform)}</kbd></Button><Button variant="ghost" size="icon-sm" aria-label="명령 팔레트" title={shortcutHint('commands', shortcutPlatform)} onClick={() => setMode('commands')}><span className="font-mono text-xs">&gt;_</span></Button><Button variant="ghost" size="icon-sm" aria-label="오른쪽으로 분할" title={shortcutHint('split', shortcutPlatform)} disabled={!workspace.activePath || workspace.groupOrder.length >= MAX_EDITOR_GROUPS} onClick={() => workspace.splitEditor('right')}><Columns2 /></Button><Button variant="ghost" size="icon-sm" aria-label="단축키 도움말" className="hidden sm:inline-flex" onClick={() => setMode('help')}><CircleHelp /></Button><div className="ml-auto flex items-center gap-1"><Button variant="ghost" size="icon-sm" aria-label="도니 대화 패널 전환" title={`도니 (${shortcutHint('chat-toggle', shortcutPlatform)})`} aria-pressed={!layout.chatCollapsed && !isChat && !mobile} onClick={toggleChat}><MessagesSquare /></Button><DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="테마 선택" />} >{ready && resolvedTheme === 'dark' ? <Moon /> : <Sun />}</DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuGroup>{([{ value: 'system', label: '시스템', icon: Monitor }, { value: 'light', label: '밝게', icon: Sun }, { value: 'dark', label: '어둡게', icon: Moon }] as const).map(option => <DropdownMenuItem key={option.value} onClick={() => setTheme(option.value)}><option.icon className="size-4" />{option.label}{ready && theme === option.value && <span className="ml-auto text-xs">선택됨</span>}</DropdownMenuItem>)}</DropdownMenuGroup></DropdownMenuContent></DropdownMenu><DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" className="h-8 gap-2 px-2" aria-label="사용자 메뉴" />}><span className="flex size-6 items-center justify-center rounded-full border bg-muted text-xs font-bold">{(user.name || user.email).slice(0, 1).toUpperCase()}</span><span className="hidden max-w-32 truncate text-xs lg:block">{user.name || user.email}</span><ChevronDown className="hidden size-3 sm:block" /></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-60"><DropdownMenuGroup><DropdownMenuLabel><span className="block truncate">{user.email}</span><span className="text-xs font-normal text-muted-foreground">{roleLabels[user.role]}</span></DropdownMenuLabel><DropdownMenuSeparator /><DropdownMenuItem onClick={() => navigate('/settings')}><Settings className="size-4" />설정</DropdownMenuItem><DropdownMenuItem disabled={loggingOut} onClick={() => void logout()}><LogOut className="size-4" />로그아웃</DropdownMenuItem></DropdownMenuGroup></DropdownMenuContent></DropdownMenu></div></header><div className="flex min-h-0 flex-1">{ready && <><div className="hidden md:flex">{activity}</div><Group id="workspace-layout" orientation="horizontal" className="workspace-shell-panels min-h-0 min-w-0 flex-1" resizeTargetMinimumSize={{ fine: 8, coarse: 24 }} onLayoutChanged={(_, { isUserInteraction }) => {
    if (!isUserInteraction || mobile) return
    const left = sidebarRef.current?.getSize().inPixels
    const right = chatRef.current?.getSize().inPixels
    setLayout(previous => ({ ...previous, ...(left !== undefined ? { collapsed: left < 1, width: left >= 200 ? left : previous.width } : {}), ...(!isChat && right !== undefined ? { chatCollapsed: right < 1, chatWidth: right >= 300 ? right : previous.chatWidth } : {}) }))
  }}><Panel id="workspace-sidebar" panelRef={sidebarRef} defaultSize={mobile || initial.current.collapsed ? 0 : initial.current.width} minSize={200} maxSize={480} collapsible collapsedSize={0} collapsedThreshold={40} disabled={mobile} groupResizeBehavior="preserve-pixel-size"><div className="h-full min-h-0" inert={mobile || layout.collapsed}>{!mobile && panels}</div></Panel><Separator aria-label="기본 사이드바 너비 조절" disabled={mobile} className={cn(separatorClass, mobile && 'hidden')} onDoubleClick={() => resetPanel('primary')} /><Panel id="workspace-main" minSize={mobile ? '100%' : 260}>{main}</Panel><Separator aria-label="도니 사이드바 너비 조절" disabled={mobile || isChat} className={cn(separatorClass, (mobile || isChat) && 'hidden')} onDoubleClick={() => resetPanel('secondary')} /><Panel id="workspace-chat" panelRef={chatRef} defaultSize={mobile || isChat || initial.current.chatCollapsed ? 0 : initial.current.chatWidth} minSize={300} maxSize={700} collapsible collapsedSize={0} collapsedThreshold={50} disabled={mobile || isChat} groupResizeBehavior="preserve-pixel-size"><div ref={secondary} className={cn('h-full min-h-0', (mobile || isChat) && 'border-l')} inert={mobile || layout.chatCollapsed || isChat}>{!isChat && <ChatPane variant="panel" onClose={() => setChatCollapsed(true)} />}</div></Panel></Group></>}</div><WorkspaceStatus />{mobile && <dialog ref={drawer} aria-label="탐색 메뉴" className="workspace-drawer fixed inset-y-0 left-0 m-0 h-dvh max-h-none w-[min(360px,90vw)] max-w-none border-r bg-secondary p-0 text-foreground" onCancel={event => { event.preventDefault(); setMobileOpen(false) }} onClick={event => { if (event.target === event.currentTarget && event.clientX > event.currentTarget.getBoundingClientRect().right) setMobileOpen(false) }}><div className="flex h-9 items-center justify-between border-b px-3"><span className="text-xs font-semibold text-muted-foreground">탐색 메뉴</span><Button autoFocus variant="ghost" size="icon-sm" aria-label="메뉴 닫기" onClick={() => setMobileOpen(false)}><X /></Button></div><div className="flex min-h-0" style={{ height: 'calc(100dvh - 2.25rem)' }}>{activity}<div className="min-w-0 flex-1">{panels}</div></div></dialog>}<Palettes mode={mode} setMode={setMode} admin={user.role === 'admin'} selectPanel={selectPanel} toggleSidebar={toggleSidebar} toggleChat={toggleChat} /><Notifications /></div>
}
