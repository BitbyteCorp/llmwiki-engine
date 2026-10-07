'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useParams, useSearchParams } from 'next/navigation'
import { X } from 'lucide-react'
import { Group, Panel, Separator, useGroupRef, type Layout } from 'react-resizable-panels'
import { api } from '@/lib/api'
import { EmptyState, ErrorNotice, Loading } from '@/components/common'
import { Button } from '@/components/ui/button'
import { useWorkspace } from '@/components/workspace/context'
import { NoteReader } from '@/components/workspace/note-reader'
import { cn } from '@/lib/utils'

export function WikiPage() {
  const params = useParams<{ path?: string[] }>()
  const searchParams = useSearchParams()
  const workspace = useWorkspace()
  const { splitPath, splitRatio, setSplitRatio, openNote } = workspace
  const groupRef = useGroupRef()
  const defaultLayout = useRef<Layout | undefined>(undefined)
  if (!splitPath) defaultLayout.current = undefined
  else if (!defaultLayout.current) defaultLayout.current = { 'wiki-primary': splitRatio * 100, 'wiki-secondary': (1 - splitRatio) * 100 }
  const [mobile, setMobile] = useState(false)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)')
    const changed = () => setMobile(media.matches)
    changed()
    media.addEventListener('change', changed)
    return () => media.removeEventListener('change', changed)
  }, [])
  const path = params.path?.map(segment => decodeURIComponent(segment)).join('/') ?? ''
  const tree = useQuery({ queryKey: ['notes/tree'], queryFn: api.tree, enabled: !path })
  const closedAll = searchParams.get('empty') === '1'
  const revisionRef = searchParams.get('ref')?.trim() || undefined
  const defaultPath = tree.data?.files.includes('index.md') ? 'index.md' : tree.data?.files[0]

  return (
    <Group
      id="wiki-editors"
      groupRef={groupRef}
      resizeTargetMinimumSize={{ coarse: 28, fine: 12 }}
      className="h-full min-h-0 min-w-0"
      orientation={mobile ? 'vertical' : 'horizontal'}
      defaultLayout={defaultLayout.current}
      disabled={!splitPath}
      onLayoutChanged={(layout, { isUserInteraction, requestedLayout }) => {
        if (isUserInteraction && splitPath) setSplitRatio((requestedLayout ?? layout)['wiki-primary'] / 100)
      }}
    >
      <Panel id="wiki-primary" minSize={splitPath ? '20%' : '100%'} maxSize="100%">
        <WorkspaceGroup group={1} path={path}>
        {path ? <NoteReader key={`${path}:${revisionRef ?? 'main'}`} path={path} revisionRef={revisionRef} /> : <section aria-label="위키 노트 선택" className="h-full min-h-0 min-w-0 space-y-4 overflow-auto p-4">
          <h1 className="sr-only">위키</h1>
          {tree.isPending && <Loading label="노트 목록을 불러오는 중" />}
          {tree.isError && <><ErrorNotice error={tree.error} /><Button variant="outline" disabled={tree.isFetching} onClick={() => void tree.refetch()}>다시 시도</Button></>}
          {tree.data && (tree.data.files.length === 0
            ? <EmptyState title="지식 저장소가 비어 있습니다" description="노트가 추가되면 이곳에서 읽을 수 있습니다." />
            : closedAll
              ? <><EmptyState title="열린 노트가 없습니다" description="탐색 패널에서 노트를 선택하거나 색인을 열어 주세요." /><Button variant="outline" onClick={() => { if (defaultPath) openNote(defaultPath) }}>색인 열기</Button></>
              : <Loading label="색인 노트를 여는 중" />)}
        </section>}
        </WorkspaceGroup>
      </Panel>
      <Separator
        disabled={!splitPath}
        aria-label="노트 분할 크기 조절"
        className={cn('relative z-10 shrink-0 touch-none bg-border transition-colors hover:bg-primary/50 focus-visible:bg-primary/50 focus-visible:outline-2 focus-visible:outline-ring', mobile ? 'h-px w-full cursor-row-resize' : 'h-full w-px cursor-col-resize', !splitPath && 'hidden')}
        onDoubleClick={() => {
          groupRef.current?.setLayout({ 'wiki-primary': 50, 'wiki-secondary': 50 })
          setSplitRatio(0.5)
        }}
      />
      <Panel id="wiki-secondary" minSize={splitPath ? '20%' : 0} maxSize={splitPath ? '80%' : 0}>
        {splitPath && <WorkspaceGroup group={2} path={splitPath}>
          <NoteReader key={`split:${splitPath}`} path={splitPath} split />
        </WorkspaceGroup>}
      </Panel>
    </Group>
  )
}

function WorkspaceGroup({ group, path, children }: { group: 1 | 2; path: string; children: ReactNode }) {
  const workspace = useWorkspace()
  const title = workspace.knownTitles[path] || path.split('/').pop()?.replace(/\.md$/i, '') || '위키'
  return <section
    data-workspace-group={group}
    tabIndex={-1}
    aria-label={`편집기 그룹 ${group}`}
    className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background"
    onFocusCapture={() => workspace.setActiveGroup(group)}
    onPointerDownCapture={() => workspace.setActiveGroup(group)}
  >
    <header className={cn('flex h-9 shrink-0 items-center justify-between gap-2 border-b px-3', workspace.activeGroup === group ? 'bg-accent/50' : 'bg-muted/30')}>
      <span className="min-w-0 truncate text-sm font-medium" title={path || title}>{title}</span>
      {path && <Button
        variant="ghost"
        size="icon-sm"
        aria-label={group === 2 ? '분할 노트 닫기' : '현재 노트 탭 닫기'}
        onClick={() => { if (group === 2) workspace.closeSplit(); else workspace.closeTab(path) }}
      ><X aria-hidden="true" /></Button>}
    </header>
    <div data-workspace-reader className="min-h-0 min-w-0 flex-1 overflow-hidden [&>section]:h-full! [&>section]:min-h-0! [&>section]:rounded-none [&>section]:border-0">{children}</div>
  </section>
}
