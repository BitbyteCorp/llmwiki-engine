'use client'

import { useEffect, useRef, useState } from 'react'
import { Ellipsis, Pin, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useEditorStatus } from '@/components/editor/state'
import { useWorkspace } from './context'

export function WorkspaceTabs() {
  const workspace = useWorkspace()
  const root = useRef<HTMLDivElement>(null)
  const [menuPath, setMenuPath] = useState<string | null>(null)
  const openedSplitFromMenu = useRef(false)
  useEffect(() => {
    root.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [workspace.activePath])
  return <div className="flex min-h-10 shrink-0 border-b bg-secondary">
    <div ref={root} role="tablist" aria-label="열린 노트" className="flex min-w-0 flex-1 overflow-x-auto">
      {workspace.tabs.map((tab, index) => <div
        key={tab.path}
        className={cn('flex max-w-64 shrink-0 items-center border-r', workspace.activePath === tab.path && 'bg-background')}
        onContextMenu={event => { event.preventDefault(); setMenuPath(tab.path) }}
        onAuxClick={event => { if (event.button === 1) { event.preventDefault(); workspace.closeTab(tab.path) } }}
        onMouseDown={event => { if (event.button === 1) event.preventDefault() }}
      >
        <button
          role="tab"
          aria-selected={workspace.activePath === tab.path}
          tabIndex={workspace.activePath === tab.path ? 0 : -1}
          data-tab-path={tab.path}
          className={cn('flex min-w-0 items-center px-3 py-2 text-sm', !tab.pinned && 'italic')}
          title={tab.path}
          onClick={() => workspace.openNote(tab.path)}
          onDoubleClick={() => workspace.pinTab(tab.path)}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return
            if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
              event.preventDefault()
              setMenuPath(tab.path)
              return
            }
            const next = event.key === 'ArrowRight' ? (index + 1) % workspace.tabs.length
              : event.key === 'ArrowLeft' ? (index + workspace.tabs.length - 1) % workspace.tabs.length
              : event.key === 'Home' ? 0 : event.key === 'End' ? workspace.tabs.length - 1 : null
            if (next !== null) {
              event.preventDefault()
              workspace.openNote(workspace.tabs[next].path)
              root.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus()
            }
            if (event.key === 'Delete') workspace.closeTab(tab.path)
          }}
        >
          <span className="min-w-0 truncate">{workspace.knownTitles[tab.path] || tab.path.split('/').pop()}</span>
          <DirtyIndicator path={tab.path} />
        </button>
        {tab.pinned && <Pin aria-label="고정됨" className="size-3 shrink-0 text-muted-foreground" />}
        <button className="p-2 text-muted-foreground hover:text-foreground" aria-label={`${tab.path} 탭 닫기`} onClick={() => workspace.closeTab(tab.path)}><X className="size-3.5" /></button>
        <DropdownMenu open={menuPath === tab.path} onOpenChange={open => setMenuPath(open ? tab.path : null)}>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`${tab.path} 탭 메뉴`} />}><Ellipsis className="size-3.5" /></DropdownMenuTrigger>
          <DropdownMenuContent finalFocus={() => {
            if (!openedSplitFromMenu.current) return true
            openedSplitFromMenu.current = false
            workspace.focusGroup(2)
            return false
          }}>
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => {
                openedSplitFromMenu.current = true
                workspace.openNote(tab.path, { split: true })
              }}>옆에 열기</DropdownMenuItem>
              <DropdownMenuItem onClick={() => workspace.pinTab(tab.path)} disabled={tab.pinned}>탭 고정</DropdownMenuItem>
              <DropdownMenuItem onClick={() => workspace.closeTab(tab.path)}>탭 닫기</DropdownMenuItem>
              <DropdownMenuItem onClick={() => workspace.closeOthers(tab.path)}>다른 탭 모두 닫기</DropdownMenuItem>
              <DropdownMenuItem onClick={workspace.reopenClosed}>닫은 탭 다시 열기</DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>)}
    </div>
    {!workspace.tabs.length && <span className="px-3 py-2 text-sm text-muted-foreground">열린 노트가 없습니다.</span>}
  </div>
}

function DirtyIndicator({ path }: { path: string }) {
  const editor = useEditorStatus(path)
  return editor?.dirty ? <span className="ml-2 inline-block size-1.5 shrink-0 rounded-full bg-foreground" title="저장되지 않은 변경"><span className="sr-only"> · 저장되지 않은 변경</span></span> : null
}
