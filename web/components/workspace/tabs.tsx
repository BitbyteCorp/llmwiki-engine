'use client'

import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { Columns2, Ellipsis, Pin, Rows2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useEditorStatus } from '@/components/editor/state'
import { MAX_EDITOR_GROUPS, useWorkspace, type EditorGroup } from './context'
import { getActiveDrag, hasWorkspaceDrag, isCopyDrop, readDropPayload, setTabDragData, useActiveDrag } from './dnd'
import { useTabMotion } from './flip'
import { isViewTab } from './layout'
import { ViewTabIcon, viewTabTitle } from './views'

export function WorkspaceTabs({ group }: { group: EditorGroup }) {
  const workspace = useWorkspace()
  const root = useRef<HTMLDivElement>(null)
  const [menuPath, setMenuPath] = useState<string | null>(null)
  const openedSideFromMenu = useRef(false)
  const activeGroupId = useRef(workspace.activeGroupId)
  activeGroupId.current = workspace.activeGroupId
  const [insertion, setInsertion] = useState<{ index: number; left: number } | null>(null)
  const dragX = useRef<number | null>(null)
  const scrollFrame = useRef<number | null>(null)
  const drag = useActiveDrag()
  const paths = useMemo(() => group.tabs.map(tab => tab.path), [group.tabs])
  useTabMotion(root, paths)

  function locate(clientX: number) {
    const items = root.current?.querySelectorAll<HTMLElement>('[data-tab-item]')
    if (!items?.length) return { index: 0, left: 0 }
    for (let index = 0; index < items.length; index++) {
      const bounds = items[index].getBoundingClientRect()
      if (clientX < bounds.left + bounds.width / 2) return { index, left: items[index].offsetLeft }
    }
    const last = items[items.length - 1]
    return { index: items.length, left: last.offsetLeft + last.offsetWidth }
  }
  function clearDrop() {
    dragX.current = null
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current)
    scrollFrame.current = null
    setInsertion(null)
  }
  function scrollDuringDrag() {
    const element = root.current
    const x = dragX.current
    if (!element || x === null) { scrollFrame.current = null; return }
    const bounds = element.getBoundingClientRect()
    const band = Math.min(40, bounds.width / 3)
    const distance = x < bounds.left + band ? -Math.min(12, (bounds.left + band - x) / 3) : x > bounds.right - band ? Math.min(12, (x - bounds.right + band) / 3) : 0
    if (distance) {
      element.scrollLeft += distance
      setInsertion(locate(x))
    }
    scrollFrame.current = requestAnimationFrame(scrollDuringDrag)
  }
  function dragOver(event: DragEvent<HTMLDivElement>) {
    if (!hasWorkspaceDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = getActiveDrag()?.kind === 'tab' && !isCopyDrop(event) ? 'move' : 'copy'
    dragX.current = event.clientX
    setInsertion(locate(event.clientX))
    if (scrollFrame.current === null) scrollFrame.current = requestAnimationFrame(scrollDuringDrag)
  }
  useEffect(() => {
    const clear = () => clearDrop()
    window.addEventListener('dragend', clear, true)
    window.addEventListener('drop', clear, true)
    return () => {
      window.removeEventListener('dragend', clear, true)
      window.removeEventListener('drop', clear, true)
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current)
    }
  }, [])
  useEffect(() => {
    if (!drag) root.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [group.activePath, drag])

  return <div className="workspace-tabs">
    <div ref={root} role="tablist" aria-label={`편집기 그룹 ${workspace.groupOrder.indexOf(group.id) + 1}의 열린 탭`} className="workspace-tablist" onDragOver={dragOver} onDragLeave={event => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
      const bounds = event.currentTarget.getBoundingClientRect()
      if (event.clientX > bounds.left && event.clientX < bounds.right && event.clientY > bounds.top && event.clientY < bounds.bottom) return
      clearDrop()
    }} onDrop={event => {
      const payload = readDropPayload(event)
      if (!payload) return
      event.preventDefault()
      event.stopPropagation()
      const target = { kind: 'tabs' as const, groupId: group.id, index: locate(event.clientX).index }
      if (payload.kind === 'tab') workspace.moveTab(payload, target, { copy: isCopyDrop(event) })
      else workspace.openNoteAt(payload.path, target)
      clearDrop()
    }}>
      {group.tabs.map((tab, index) => <div key={tab.path} data-tab-item={tab.path} className={cn('workspace-tab', group.activePath === tab.path && 'is-active', drag?.kind === 'tab' && drag.groupId === group.id && drag.path === tab.path && 'is-dragging')} draggable onDragStart={event => setTabDragData(event, group.id, tab.path, workspace.knownTitles[tab.path], tab.query)} onDragEnd={clearDrop} onContextMenu={event => { event.preventDefault(); setMenuPath(tab.path) }} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); workspace.closeTab(tab.path, group.id) } }} onMouseDown={event => { if (event.button === 1) event.preventDefault() }}>
        <button role="tab" aria-selected={group.activePath === tab.path} tabIndex={group.activePath === tab.path ? 0 : -1} data-tab-path={tab.path} data-group-id={group.id} className={cn('flex min-w-0 items-center gap-1.5 px-3 py-2 text-sm', !tab.pinned && 'italic')} title={isViewTab(tab.path) ? viewTabTitle(tab.path, tab.query) : tab.path} onClick={event => workspace.openNote(tab.path, { group: group.id, pin: event.ctrlKey || event.metaKey || undefined, query: tab.query })} onDoubleClick={() => workspace.pinTab(tab.path, group.id)} onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); setMenuPath(tab.path); return }
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); workspace.setActiveGroup(group.id); workspace.openNote(tab.path, { group: 'side', query: tab.query }); return }
          const next = event.key === 'ArrowRight' ? (index + 1) % group.tabs.length : event.key === 'ArrowLeft' ? (index + group.tabs.length - 1) % group.tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? group.tabs.length - 1 : null
          if (next !== null) { event.preventDefault(); workspace.openNote(group.tabs[next].path, { group: group.id, query: group.tabs[next].query }); root.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus() }
          if (event.key === 'Delete') { event.preventDefault(); workspace.closeTab(tab.path, group.id) }
        }}>{isViewTab(tab.path) && <ViewTabIcon path={tab.path} className="size-3.5 shrink-0" />}<span className="min-w-0 truncate">{isViewTab(tab.path) ? viewTabTitle(tab.path, tab.query) : workspace.knownTitles[tab.path] || tab.path.split('/').pop()}</span>{!isViewTab(tab.path) && <DirtyIndicator path={tab.path} />}</button>
        {tab.pinned && <Pin aria-label="고정됨" className="size-3 shrink-0 text-muted-foreground" />}
        <button className="p-2 text-muted-foreground hover:text-foreground" aria-label={`${isViewTab(tab.path) ? viewTabTitle(tab.path, tab.query) : tab.path} 탭 닫기`} onClick={() => workspace.closeTab(tab.path, group.id)}><X className="size-3.5" /></button>
        <DropdownMenu open={menuPath === tab.path} onOpenChange={open => setMenuPath(open ? tab.path : null)}>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`${isViewTab(tab.path) ? viewTabTitle(tab.path, tab.query) : tab.path} 탭 메뉴`} />}><Ellipsis className="size-3.5" /></DropdownMenuTrigger>
          <DropdownMenuContent finalFocus={() => { if (!openedSideFromMenu.current) return true; openedSideFromMenu.current = false; workspace.focusGroup(activeGroupId.current); return false }}><DropdownMenuGroup>
            <DropdownMenuItem onClick={() => { openedSideFromMenu.current = true; workspace.setActiveGroup(group.id); workspace.openNote(tab.path, { group: 'side', query: tab.query }) }}>옆에 열기</DropdownMenuItem>
            <DropdownMenuItem onClick={() => workspace.pinTab(tab.path, group.id)} disabled={tab.pinned}>탭 고정</DropdownMenuItem>
            <DropdownMenuItem onClick={() => workspace.closeTab(tab.path, group.id)}>탭 닫기</DropdownMenuItem>
            <DropdownMenuItem onClick={() => workspace.closeOthers(tab.path, group.id)}>다른 탭 모두 닫기</DropdownMenuItem>
            <DropdownMenuItem onClick={workspace.reopenClosed}>닫은 탭 다시 열기</DropdownMenuItem>
          </DropdownMenuGroup></DropdownMenuContent>
        </DropdownMenu>
      </div>)}
      {!group.tabs.length && <span className="workspace-tabs-empty">열린 탭이 없습니다.</span>}
      {insertion && <span className="workspace-tab-insertion" style={{ left: insertion.left }} aria-hidden="true" />}
    </div>
    <div className="workspace-tab-tools">
      <Button variant="ghost" size="icon-sm" aria-label="오른쪽으로 분할" title="오른쪽으로 분할" disabled={!group.activePath || workspace.groupOrder.length >= MAX_EDITOR_GROUPS} onClick={() => { workspace.setActiveGroup(group.id); workspace.splitEditor('right') }}><Columns2 className="size-3.5" /></Button>
      <Button variant="ghost" size="icon-sm" aria-label="아래로 분할" title="아래로 분할" disabled={!group.activePath || workspace.groupOrder.length >= MAX_EDITOR_GROUPS} onClick={() => { workspace.setActiveGroup(group.id); workspace.splitEditor('bottom') }}><Rows2 className="size-3.5" /></Button>
      <Button variant="ghost" size="icon-sm" aria-label="편집기 그룹 닫기" title="편집기 그룹 닫기" disabled={!group.tabs.length && workspace.groupOrder.length === 1} onClick={() => workspace.closeGroup(group.id)}><X className="size-3.5" /></Button>
    </div>
  </div>
}

export function DirtyIndicator({ path }: { path: string }) {
  const editor = useEditorStatus(path)
  return editor?.dirty ? <span className="ml-2 inline-block size-1.5 shrink-0 rounded-full bg-foreground" title="저장되지 않은 변경"><span className="sr-only"> · 저장되지 않은 변경</span></span> : null
}
