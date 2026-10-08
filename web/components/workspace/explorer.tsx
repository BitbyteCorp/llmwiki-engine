'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, FilePlus2, FileText, Folder, FolderPlus, LocateFixed, MoreHorizontal, Star, X } from 'lucide-react'
import { api } from '@/lib/api'
import { ErrorNotice, Loading } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useWorkspace } from './context'
import { parentFolder, useFileOperations } from '@/components/editor/file-operations'
import { getActiveDrag, NOTE_MIME, setNoteDragData, setTabDragData } from './dnd'
import { isViewTab } from './layout'
import { DirtyIndicator } from './tabs'
import { ViewHeader } from './view-pane'
import { ViewTabIcon, viewTabTitle } from './views'

type Node = { name: string; path: string; children?: Node[] }
function buildTree(files: string[], folders: string[]): Node[] {
  const roots: Node[] = []
  const nodes = new Map<string, Node>()
  for (const { file, folder } of [...folders.map(file => ({ file, folder: true })), ...files.map(file => ({ file, folder: false }))]) {
    const parts = file.split('/')
    let siblings = roots
    let prefix = ''
    for (let index = 0; index < parts.length; index++) {
      prefix = prefix ? `${prefix}/${parts[index]}` : parts[index]
      let node = nodes.get(prefix)
      if (!node) {
        node = { name: parts[index], path: prefix, ...(index < parts.length - 1 || folder ? { children: [] } : {}) }
        nodes.set(prefix, node)
        siblings.push(node)
      }
      if (node.children) siblings = node.children
    }
  }
  const sort = (branch: Node[]) => {
    branch.sort((a, b) => Number(Boolean(b.children)) - Number(Boolean(a.children)) || a.name.localeCompare(b.name, 'ko'))
    for (const node of branch) if (node.children) sort(node.children)
  }
  sort(roots)
  return roots
}

function FolderChildren({ open, render }: { open: boolean; render: () => ReactNode }) {
  const [mounted, setMounted] = useState(open)
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) { setMounted(true); return }
    if (!mounted) return
    const duration = getComputedStyle(container.current!).transitionDuration.split(',').reduce((longest, value) => Math.max(longest, parseFloat(value) * (value.trim().endsWith('ms') ? 1 : 1000)), 0)
    const timer = window.setTimeout(() => setMounted(false), duration)
    return () => window.clearTimeout(timer)
  }, [open, mounted])
  if (!mounted) return null
  return <div ref={container} className="explorer-children" data-open={open} aria-hidden={!open} inert={!open}><div className="min-h-0 overflow-hidden"><ul className="ml-3 border-l pl-2">{render()}</ul></div></div>
}

export function Explorer({ userId }: { userId: number }) {
  const workspace = useWorkspace()
  const tree = useQuery({ queryKey: ['notes/tree'], queryFn: api.tree })
  const operations = useFileOperations(tree.data?.files ?? [])
  const [menu, setMenu] = useState<{ path: string; folder: boolean; x: number; y: number; trigger: HTMLElement } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [renaming, setRenaming] = useState<{ path: string; name: string } | null>(null)
  const [dropFolder, setDropFolder] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<string[]>([])
  const [closedViews, setClosedViews] = useState<string[]>([])
  const [editorsHeight, setEditorsHeight] = useState<number | null>(null)
  const [editorsSize, setEditorsSize] = useState({ max: 192, current: 0 })
  const [resizingEditors, setResizingEditors] = useState(false)
  const viewsColumn = useRef<HTMLDivElement>(null)
  const editorsList = useRef<HTMLDivElement>(null)
  const favoritesView = useRef<HTMLElement>(null)
  const editorsDrag = useRef<{ pointerId: number; y: number; height: number } | null>(null)
  const [highlight, setHighlight] = useState('')
  const [ready, setReady] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const hoverFolder = useRef<{ path: string; timer: number } | null>(null)
  const storageKey = `llmwiki.explorer.v1.${userId}`
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null') as { filter: string; expanded: string[]; closedViews?: string[]; editorsHeight?: number | null } | null
      if (saved && typeof saved.filter === 'string' && Array.isArray(saved.expanded)) {
        setFilter(saved.filter)
        setExpanded(saved.expanded)
        if (Array.isArray(saved.closedViews)) setClosedViews(saved.closedViews.filter(view => typeof view === 'string'))
        setEditorsHeight(typeof saved.editorsHeight === 'number' && Number.isFinite(saved.editorsHeight) && saved.editorsHeight >= 28 ? saved.editorsHeight : null)
      }
    } catch { /* Explorer remains usable without persistent storage. */ }
    setReady(true)
  }, [storageKey])
  useEffect(() => {
    if (ready) try { localStorage.setItem(storageKey, JSON.stringify({ filter, expanded, closedViews, editorsHeight })) } catch { /* Storage may be unavailable. */ }
  }, [filter, expanded, closedViews, editorsHeight, ready, storageKey])
  useEffect(() => {
    if (!ready || !workspace.activePath || isViewTab(workspace.activePath)) return
    const parts = workspace.activePath.split('/')
    const ancestors = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'))
    setExpanded(previous => [...new Set([...previous, ...ancestors])])
  }, [workspace.activePath, ready])
  useEffect(() => {
    if (!workspace.activePath || isViewTab(workspace.activePath)) return
    const frame = requestAnimationFrame(() => {
      const target = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-explorer-path]') ?? []).find(element => element.dataset.explorerPath === workspace.activePath)
      target?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
  }, [workspace.activePath, expanded, tree.data])
  useEffect(() => {
    const reveal = (event: Event) => {
      const path = (event as CustomEvent<string>).detail
      setFilter('')
      setClosedViews(previous => previous.filter(view => view !== 'tree'))
      setHighlight(path)
      const parts = path.split('/')
      setExpanded(previous => [...new Set([...previous, ...parts.map((_, index) => parts.slice(0, index + 1).join('/'))])])
    }
    window.addEventListener('workspace-reveal', reveal)
    return () => window.removeEventListener('workspace-reveal', reveal)
  }, [])
  useEffect(() => {
    if (!highlight) return
    const frame = requestAnimationFrame(() => {
      const target = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-explorer-path]') ?? []).find(element => element.dataset.explorerPath === highlight)
      target?.scrollIntoView({ block: 'nearest' })
      target?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [highlight, expanded, filter])
  useEffect(() => {
    if (!highlight) return
    const timer = window.setTimeout(() => setHighlight(''), 1400)
    return () => window.clearTimeout(timer)
  }, [highlight])
  useEffect(() => {
    const end = () => { clearFolderHover(); setDropFolder(null) }
    window.addEventListener('dragend', end)
    window.addEventListener('drop', end)
    return () => { clearFolderHover(); window.removeEventListener('dragend', end); window.removeEventListener('drop', end) }
  }, [])
  const filtered = useMemo(() => (tree.data?.files ?? []).filter(path => `${path} ${workspace.knownTitles[path] || ''}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase())), [tree.data, filter, workspace.knownTitles])
  const nodes = useMemo(() => buildTree(filtered, operations.virtualFolders.filter(path => !filter || path.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))), [filtered, operations.virtualFolders, filter])
  useEffect(() => {
    if (!menu) return
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const pointer = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as globalThis.Node)) setMenu(null) }
    const close = () => setMenu(null)
    document.addEventListener('pointerdown', pointer)
    window.addEventListener('resize', close)
    return () => { document.removeEventListener('pointerdown', pointer); window.removeEventListener('resize', close); menu.trigger.focus({ preventScroll: true }) }
  }, [menu])
  function openMenu(event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, path: string, folder: boolean) {
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const pointer = 'clientX' in event && event.type === 'contextmenu'
    setMenu({ path, folder, x: Math.max(8, Math.min(pointer ? event.clientX : rect.left, window.innerWidth - 232)), y: Math.max(8, Math.min(pointer ? event.clientY : rect.bottom, window.innerHeight - 340)), trigger: event.currentTarget })
  }
  function runMenu(action: () => void) {
    if (!menu) return
    menu.trigger.focus({ preventScroll: true })
    setMenu(null)
    action()
  }
  function rowKey(event: KeyboardEvent<HTMLElement>, node: Node) {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) openMenu(event, node.path, Boolean(node.children))
    else if (event.key === 'F2' && !node.children && operations.canWrite && !node.path.startsWith('raw/')) {
      event.preventDefault(); setRenaming({ path: node.path, name: node.name })
    } else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const rows = [...root.current?.querySelectorAll<HTMLElement>('[data-explorer-path]') ?? []].filter(row => !row.closest('[inert]'))
      const index = rows.indexOf(event.currentTarget)
      rows[event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus()
    } else if (node.children && ['ArrowRight', 'ArrowLeft'].includes(event.key)) {
      event.preventDefault(); setExpanded(previous => event.key === 'ArrowRight' ? [...new Set([...previous, node.path])] : previous.filter(path => path !== node.path))
    }
  }
  function clearFolderHover() {
    if (hoverFolder.current) window.clearTimeout(hoverFolder.current.timer)
    hoverFolder.current = null
  }
  function canMoveDrag(event: DragEvent<HTMLElement>, folder: string) {
    const drag = getActiveDrag()
    return operations.canWrite && !operations.busy && folder !== 'raw' && !folder.startsWith('raw/') && drag?.kind === 'note' && !drag.path.startsWith('raw/') && tree.data?.files.includes(drag.path) && event.dataTransfer.types.includes(NOTE_MIME) && ['move', 'copyMove', 'all'].includes(event.dataTransfer.effectAllowed)
  }
  function overFolder(event: DragEvent<HTMLElement>, folder: string, open = true) {
    const drag = getActiveDrag()
    if (!open && drag?.kind === 'note' && event.dataTransfer.types.includes(NOTE_MIME) && hoverFolder.current?.path !== folder) {
      clearFolderHover()
      hoverFolder.current = { path: folder, timer: window.setTimeout(() => { setExpanded(previous => [...new Set([...previous, folder])]); hoverFolder.current = null }, 600) }
    }
    if (!canMoveDrag(event, folder)) return
    event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropFolder(folder)
  }
  function leaveFolder(event: DragEvent<HTMLElement>) {
    if (event.currentTarget.contains(event.relatedTarget as globalThis.Node)) return
    clearFolderHover(); setDropFolder(null)
  }
  function drop(event: DragEvent<HTMLElement>, folder: string) {
    clearFolderHover(); setDropFolder(null)
    if (!canMoveDrag(event, folder)) return
    event.preventDefault()
    const path = event.dataTransfer.getData(NOTE_MIME)
    if (getActiveDrag()?.path !== path) return
    const destination = `${folder ? `${folder}/` : ''}${path.split('/').pop()}`
    if (destination !== path) operations.move(path, destination)
  }
  function noteRow(node: Node) {
    const active = node.path === workspace.activePath
    return <li key={node.path} className="group flex min-w-0 items-center">
      {renaming?.path === node.path ? <form className="min-w-0 flex-1" onSubmit={event => { event.preventDefault(); if (!operations.busy) void operations.renameInline(node.path, renaming.name).then(done => { if (done) { setRenaming(null); requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-explorer-path="${CSS.escape(`${parentFolder(node.path) ? `${parentFolder(node.path)}/` : ''}${renaming.name.trim()}`)}"]`)?.focus()) } }) }}>
        <Input aria-label={`${node.name} 새 파일명`} autoFocus value={renaming.name} disabled={operations.busy} onFocus={event => event.target.select()} onChange={event => setRenaming({ path: node.path, name: event.target.value })} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setRenaming(null); requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-explorer-path="${CSS.escape(node.path)}"]`)?.focus()) } }} />
        <div className="flex gap-1 py-1"><Button type="submit" size="sm" disabled={operations.busy}>적용</Button><Button type="button" size="sm" variant="ghost" disabled={operations.busy} onClick={() => setRenaming(null)}>취소</Button></div>
      </form> : <button type="button" title={`${node.path} · F2 이름 변경 · Shift+F10 메뉴`} data-explorer-path={node.path} aria-current={active ? 'page' : undefined} className={cn('explorer-row min-w-0 flex-1', active && 'bg-accent font-bold', highlight === node.path && 'explorer-reveal')} draggable onDragStart={event => setNoteDragData(event, node.path, { title: workspace.knownTitles[node.path], move: operations.canWrite && !operations.busy && !node.path.startsWith('raw/') })} onDragEnd={() => { clearFolderHover(); setDropFolder(null) }} onContextMenu={event => openMenu(event, node.path, false)} onKeyDown={event => rowKey(event, node)} onClick={event => workspace.openNote(node.path, { group: event.altKey ? 'side' : undefined, pin: event.ctrlKey || event.metaKey })} onDoubleClick={() => workspace.pinTab(node.path)}><FileText className="size-4 shrink-0 text-muted-foreground" /><span className="truncate">{workspace.knownTitles[node.path] || node.name}</span></button>}
      <button type="button" title="즐겨찾기 전환" aria-label={`${node.name} 즐겨찾기 전환`} aria-pressed={workspace.favoritePaths.includes(node.path)} className="flex h-7 shrink-0 items-center px-1 text-muted-foreground hover:text-foreground" onClick={() => workspace.toggleFavorite(node.path)}><Star className={cn('size-3.5', workspace.favoritePaths.includes(node.path) && 'fill-current text-warning')} /></button>
      <button type="button" aria-label={`${node.name} 작업 메뉴`} aria-haspopup="menu" aria-expanded={menu?.path === node.path} className="flex h-7 shrink-0 items-center px-1 text-muted-foreground hover:text-foreground" onClick={event => openMenu(event, node.path, false)}><MoreHorizontal className="size-4" /></button>
    </li>
  }
  function renderNodes(branch: Node[]) {
    return branch.map(node => {
      const open = Boolean(filter) || expanded.includes(node.path)
      if (!node.children) return noteRow(node)
      return <li key={node.path}><div className={cn('explorer-folder flex items-center rounded-md', dropFolder === node.path && 'bg-accent ring-2 ring-ring')} onDragOver={event => overFolder(event, node.path, open)} onDragLeave={leaveFolder} onDrop={event => drop(event, node.path)}>
        <button type="button" data-explorer-path={node.path} aria-expanded={open} className={cn('explorer-row min-w-0 flex-1', highlight === node.path && 'explorer-reveal')} onContextMenu={event => openMenu(event, node.path, true)} onKeyDown={event => rowKey(event, node)} onClick={() => setExpanded(previous => previous.includes(node.path) ? previous.filter(path => path !== node.path) : [...previous, node.path])}><ChevronRight className={cn('explorer-chevron size-3 shrink-0', open && 'rotate-90')} /><Folder className="size-4 shrink-0 text-muted-foreground" /><span className="truncate">{node.name}</span></button>
        <button type="button" className="flex h-7 shrink-0 items-center px-1 text-muted-foreground hover:text-foreground" aria-label={`${node.path} 폴더 작업 메뉴`} aria-haspopup="menu" aria-expanded={menu?.path === node.path} onClick={event => openMenu(event, node.path, true)}><MoreHorizontal className="size-4" /></button>
      </div><FolderChildren open={open} render={() => renderNodes(node.children!)} /></li>
    })
  }
  const menuButton = 'flex min-h-9 w-full items-center rounded-md px-3 py-1.5 text-left text-sm hover:bg-accent focus:bg-accent focus:outline-none disabled:opacity-50'
  const writableMenu = operations.canWrite && menu && menu.path !== 'raw' && !menu.path.startsWith('raw/')
  const treeOpen = Boolean(filter) || !closedViews.includes('tree')
  const editorsOpen = !closedViews.includes('editors')
  const favoritesOpen = !closedViews.includes('favorites')
  const editorCount = workspace.groupOrder.reduce((count, id) => count + workspace.groups[id].tabs.length, 0)
  const toggleView = (id: string) => setClosedViews(previous => previous.includes(id) ? previous.filter(view => view !== id) : [...previous, id])
  const minimumEditorsHeight = Math.min(28, editorsSize.max)
  const clampedEditorsHeight = Math.max(minimumEditorsHeight, Math.min(editorsHeight ?? 0, editorsSize.max))
  function resizeEditors(height: number) {
    setEditorsHeight(Math.max(28, Math.min(height, editorsSize.max)))
  }
  useLayoutEffect(() => {
    if (filter || !editorCount || !editorsOpen) return
    const column = viewsColumn.current
    const list = editorsList.current
    if (!column || !list) return
    const measure = () => {
      // Reserve both view headers, the sash, favorites, and the expanded tree.
      const max = Math.max(0, Math.floor(column.getBoundingClientRect().height - (favoritesView.current?.getBoundingClientRect().height ?? 0) - 24 - 1 - (treeOpen ? 128 : 24)))
      const current = Math.min(max, Math.round(list.getBoundingClientRect().height))
      setEditorsSize(previous => previous.max === max && previous.current === current ? previous : { max, current })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(column)
    observer.observe(list)
    if (favoritesView.current) observer.observe(favoritesView.current)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [filter, editorCount, editorsOpen, treeOpen, favoritesOpen, workspace.favoritePaths.length])
  return <div ref={root} className="flex h-full min-h-0 flex-col">
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 px-3"><h2 className="text-xs font-semibold text-muted-foreground">탐색기</h2><div className="flex items-center">
      {operations.canWrite && <><Button variant="ghost" size="icon-sm" aria-label="새 노트" disabled={operations.busy} onClick={() => operations.newNote(workspace.activePath && !isViewTab(workspace.activePath) ? parentFolder(workspace.activePath) : '')}><FilePlus2 className="size-4" /></Button><Button variant="ghost" size="icon-sm" aria-label="새 가상 폴더" disabled={operations.busy} onClick={() => operations.newFolder()}><FolderPlus className="size-4" /></Button></>}
      <Button variant="ghost" size="icon-sm" aria-label="현재 노트 위치 표시" disabled={!workspace.activePath || isViewTab(workspace.activePath)} onClick={() => workspace.revealFolder(workspace.activePath)}><LocateFixed className="size-4" /></Button>
    </div></div>
    <div className="shrink-0 px-2 pb-2"><Input aria-label="노트 경로 필터" className="h-8" placeholder="경로·제목 필터…" value={filter} onChange={event => setFilter(event.target.value)} /></div>
    {operations.me.error && <div className="space-y-2 px-2 pb-2"><ErrorNotice error={operations.me.error} /><Button size="sm" variant="outline" onClick={() => void operations.me.refetch()}>권한 다시 확인</Button></div>}
    {operations.panel}
    <div ref={viewsColumn} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {!filter && editorCount > 0 && <section aria-label="열린 편집기" className={cn('flex shrink-0 flex-col', !editorsOpen && 'border-b')}><ViewHeader title="열린 편집기" open={editorsOpen} onToggle={() => toggleView('editors')} />{editorsOpen && <><div ref={editorsList} className="overflow-auto px-2 pb-1" style={editorsHeight === null ? { maxHeight: `min(12rem, 25vh, ${editorsSize.max}px)` } : { height: clampedEditorsHeight }}>{workspace.groupOrder.map((groupId, index) => workspace.groups[groupId].tabs.length > 0 && <div key={groupId} role="group" aria-label={`${index + 1} 그룹`}>{workspace.groupOrder.length > 1 && <button type="button" className="flex h-5 w-full items-center px-2 text-left text-[11px] text-muted-foreground hover:text-foreground" onClick={() => workspace.focusGroup(groupId)}>{index + 1} 그룹</button>}<ul>{workspace.groups[groupId].tabs.map(tab => {
        const view = isViewTab(tab.path)
        const label = view ? viewTabTitle(tab.path, tab.query) : workspace.knownTitles[tab.path] || tab.path.split('/').pop()!
        const shown = workspace.groups[groupId].activePath === tab.path
        const current = shown && groupId === workspace.activeGroupId
        return <li key={tab.path} className={cn('group/editor flex min-w-0 items-center rounded-sm', current ? 'bg-accent' : shown && 'bg-accent/50')}><button type="button" className={cn('explorer-row min-w-0 flex-1', !tab.pinned && 'italic')} title={view ? label : tab.path} aria-current={current ? 'page' : undefined} draggable onDragStart={event => setTabDragData(event, groupId, tab.path, view ? label : workspace.knownTitles[tab.path], tab.query)} onClick={() => workspace.openNote(tab.path, { group: groupId, query: tab.query })} onKeyDown={event => { if (event.key === 'Delete') { event.preventDefault(); workspace.closeTab(tab.path, groupId) } }}>{view ? <ViewTabIcon path={tab.path} className="size-3.5 shrink-0" /> : <FileText className="size-3.5 shrink-0" />}<span className="truncate">{label}</span>{!view && parentFolder(tab.path) && <span className="min-w-0 shrink truncate text-xs text-muted-foreground">{parentFolder(tab.path)}</span>}{!view && <DirtyIndicator path={tab.path} />}</button><button type="button" title="편집기 닫기" aria-label={`${label} 편집기 닫기`} className={cn('flex h-7 shrink-0 items-center px-1 text-muted-foreground hover:text-foreground group-focus-within/editor:opacity-100 group-hover/editor:opacity-100 [@media(hover:none)]:opacity-100', !current && 'opacity-0')} onClick={() => workspace.closeTab(tab.path, groupId)}><X className="size-3.5" /></button></li>
      })}</ul></div>)}</div>
        <div role="separator" aria-orientation="horizontal" aria-label="열린 편집기 높이 조절" aria-valuemin={minimumEditorsHeight} aria-valuemax={editorsSize.max} aria-valuenow={editorsSize.current} tabIndex={0} className="workspace-editor-separator explorer-editors-separator" data-separator={resizingEditors ? 'active' : undefined}
          onPointerDown={event => {
            if (event.button !== 0) return
            event.preventDefault()
            event.currentTarget.focus({ preventScroll: true })
            event.currentTarget.setPointerCapture(event.pointerId)
            editorsDrag.current = { pointerId: event.pointerId, y: event.clientY, height: editorsList.current?.getBoundingClientRect().height ?? 0 }
            setResizingEditors(true)
          }}
          onPointerMove={event => {
            const drag = editorsDrag.current
            if (drag?.pointerId === event.pointerId) resizeEditors(drag.height + event.clientY - drag.y)
          }}
          onPointerUp={event => {
            if (editorsDrag.current?.pointerId !== event.pointerId) return
            resizeEditors(editorsDrag.current.height + event.clientY - editorsDrag.current.y)
            event.currentTarget.releasePointerCapture(event.pointerId)
            editorsDrag.current = null
            setResizingEditors(false)
          }}
          onLostPointerCapture={() => { editorsDrag.current = null; setResizingEditors(false) }}
          onPointerCancel={() => { editorsDrag.current = null; setResizingEditors(false) }}
          onDoubleClick={() => setEditorsHeight(null)}
          onKeyDown={event => {
            if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            resizeEditors(event.key === 'Home' ? minimumEditorsHeight : event.key === 'End' ? editorsSize.max : editorsSize.current + (event.key === 'ArrowDown' ? 16 : -16))
          }}
        />
      </>}</section>}
      {!filter && workspace.favoritePaths.length > 0 && <section ref={favoritesView} aria-label="즐겨찾기" className="flex shrink-0 flex-col border-b"><ViewHeader title="즐겨찾기" open={favoritesOpen} onToggle={() => toggleView('favorites')} />{favoritesOpen && <ul className="max-h-[min(10rem,20vh)] overflow-auto px-2 pb-1">{workspace.favoritePaths.map(path => <li key={path}><button className={cn('explorer-row w-full', workspace.activePath === path && 'bg-accent')} title={path} draggable onDragStart={event => setNoteDragData(event, path, { title: workspace.knownTitles[path], move: operations.canWrite && !operations.busy && !path.startsWith('raw/') })} onDragEnd={() => { clearFolderHover(); setDropFolder(null) }} onContextMenu={event => openMenu(event, path, false)} onKeyDown={event => { if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') openMenu(event, path, false); else if (event.key === 'F2' && operations.canWrite && !path.startsWith('raw/')) { event.preventDefault(); operations.move(path) } }} onClick={() => workspace.openNote(path)}><FileText className="size-3.5 shrink-0" /><span className="truncate">{workspace.knownTitles[path] || path}</span></button></li>)}</ul>}</section>}
      <section aria-label="저장소 루트" className={cn('flex min-w-0 flex-col', treeOpen ? 'min-h-32 flex-1' : 'shrink-0')}>
        <ViewHeader title={`저장소 루트 · 노트 ${filtered.length}개`} open={treeOpen} onToggle={() => toggleView('tree')} className={cn('explorer-folder', dropFolder === '' && 'bg-accent ring-2 ring-ring')} onContextMenu={event => openMenu(event, '', true)} onDragOver={event => overFolder(event, '')} onDragLeave={leaveFolder} onDrop={event => drop(event, '')} actions={<button type="button" className="flex h-6 shrink-0 items-center px-1 text-muted-foreground hover:text-foreground" aria-label="저장소 루트 작업 메뉴" aria-haspopup="menu" onClick={event => openMenu(event, '', true)}><MoreHorizontal className="size-4" /></button>} />
        {treeOpen && <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
          {tree.isPending && <Loading label="노트 목록 불러오는 중…" />}
          {tree.error && <div className="space-y-2"><ErrorNotice error={tree.error} /><Button variant="outline" onClick={() => void tree.refetch()}>다시 시도</Button></div>}
          <nav aria-label="위키 폴더와 노트"><ul>{renderNodes(nodes)}</ul></nav>
          {tree.data && !filtered.length && <p className="p-2 text-sm text-muted-foreground">{filter ? '일치하는 노트가 없습니다.' : '지식 저장소가 비어 있습니다.'}</p>}
          {operations.canWrite && <p className="mt-3 px-2 text-xs text-muted-foreground">F2 이름 변경 · Shift+F10 메뉴 · 폴더에 끌어 이동 (모바일에서는 메뉴의 이동 사용)</p>}
        </div>}
      </section>
    </div>
    {menu && createPortal(<div ref={menuRef} role="menu" aria-label={`${menu.path || '저장소 루트'} 작업`} className="fixed z-[100] max-h-[calc(100dvh-1rem)] w-56 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-xl" style={{ left: menu.x, top: menu.y }} onKeyDown={event => {
      if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); setMenu(null) }
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        const buttons = [...menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []]
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
      }
    }}>
      <p className="truncate px-3 py-2 text-xs text-muted-foreground" title={menu.path}>{menu.path || '저장소 루트'}</p>
      {writableMenu && <><button type="button" role="menuitem" className={menuButton} disabled={operations.busy} onClick={() => runMenu(() => operations.newNote(menu.folder ? menu.path : parentFolder(menu.path)))}>새 노트</button><button type="button" role="menuitem" className={menuButton} disabled={operations.busy} onClick={() => runMenu(() => operations.newFolder(menu.folder ? menu.path : parentFolder(menu.path)))}>새 가상 폴더</button></>}
      {!menu.folder && writableMenu && <><button type="button" role="menuitem" className={menuButton} disabled={operations.busy} onClick={() => runMenu(() => { const path = menu.path; setRenaming({ path, name: path.split('/').pop()! }); workspace.revealFolder(path) })}>이름 변경 <kbd className="ml-auto text-xs">F2</kbd></button><button type="button" role="menuitem" className={menuButton} disabled={operations.busy} onClick={() => runMenu(() => operations.move(menu.path))}>폴더 이동…</button><button type="button" role="menuitem" className={cn(menuButton, 'text-destructive')} disabled={operations.busy} onClick={() => runMenu(() => operations.remove(menu.path))}>노트 삭제…</button><hr className="my-1 border-border" /></>}
      <button type="button" role="menuitem" className={menuButton} onClick={() => { void operations.copy(menu.path || '.'); setMenu(null) }}>경로 복사</button>
      {!menu.folder && <button type="button" role="menuitem" className={menuButton} onClick={() => { void operations.copy(menu.path, true); setMenu(null) }}>위키링크 복사</button>}
      <button type="button" role="menuitem" className={menuButton} onClick={() => { const path = menu.path; setMenu(null); workspace.openHref(`/history${path ? `?path=${encodeURIComponent(path)}` : ''}`) }}>변경 이력 열기</button>
    </div>, menu.trigger.closest('dialog[open]') ?? document.body)}
  </div>
}
