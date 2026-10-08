'use client'

import { useId, useMemo, useState, type MouseEvent } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, List, LocateFixed, Maximize, RefreshCw, Search } from 'lucide-react'
import { api } from '@/lib/api'
import { EmptyState, ErrorNotice, Loading, noteHref } from '@/components/common'
import { useWorkspace } from '@/components/workspace/context'
import { isGraphTab } from '@/components/workspace/layout'
import { setNoteDragData } from '@/components/workspace/dnd'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import GraphCanvas from './graph-canvas'

export function GraphView({ groupId }: { groupId: string }) {
  const workspace = useWorkspace()
  const listId = useId()
  const [query, setQuery] = useState('')
  const [listOpen, setListOpen] = useState(false)
  const [focusPath, setFocusPath] = useState<string | null>(null)
  const [focusRequest, setFocusRequest] = useState(0)
  const [fitRequest, setFitRequest] = useState(0)
  const graph = useQuery({ queryKey: ['graph'], queryFn: ({ signal }) => api.graph(signal) })
  const term = query.trim().toLocaleLowerCase('ko-KR')
  const nodes = useMemo(() => (graph.data?.nodes ?? [])
    .filter(node => !term || `${node.title} ${node.path}`.toLocaleLowerCase('ko-KR').includes(term))
    .sort((left, right) => (left.title || left.path).localeCompare(right.title || right.path, 'ko') || left.path.localeCompare(right.path)), [graph.data, term])
  const matchedPaths = useMemo(() => new Set(term ? nodes.map(node => node.path) : []), [nodes, term])
  const activePaths = useMemo(() => new Set(Object.values(workspace.groups).map(group => group.activePath).filter(path => path && !isGraphTab(path))), [workspace.groups])
  const degrees = useMemo(() => {
    const counts = new Map<string, number>()
    for (const edge of graph.data?.edges ?? []) {
      counts.set(edge.from, (counts.get(edge.from) ?? 0) + 1)
      counts.set(edge.to, (counts.get(edge.to) ?? 0) + 1)
    }
    return counts
  }, [graph.data])

  function focusNode(path: string) {
    setFocusPath(path)
    setFocusRequest(previous => previous + 1)
  }
  function openNode(path: string, event: Pick<MouseEvent | globalThis.MouseEvent, 'ctrlKey' | 'metaKey' | 'altKey'>) {
    workspace.openNote(path, { group: event.ctrlKey || event.metaKey || event.altKey ? 'side' : groupId })
  }

  return <div className="flex h-full min-h-0 flex-col">
    {graph.isPending && <div className="p-2"><Loading label="노트 연결을 불러오는 중" /></div>}
    {graph.isError && <div className="shrink-0 space-y-2 border-b p-2"><ErrorNotice error={graph.error} /><Button variant="outline" size="sm" onClick={() => void graph.refetch()} disabled={graph.isFetching}>다시 시도</Button></div>}
    {graph.data && (graph.data.nodes.length === 0 ? <EmptyState title="표시할 노트가 없습니다" description="노트를 추가하고 색인이 완료되면 그래프에 나타납니다." /> : <>
      <GraphCanvas data={graph.data} focusPath={focusPath} focusRequest={focusRequest} fitRequest={fitRequest} matchedPaths={matchedPaths} activePaths={activePaths} onOpen={openNode}>
        <div className="absolute left-2 right-2 top-2 z-10 flex flex-wrap items-center gap-1 rounded-sm border bg-background/95 p-1">
          <form role="search" className="flex min-w-0 flex-[1_1_10rem] items-center gap-1" onSubmit={event => { event.preventDefault(); if (nodes[0]) focusNode(nodes[0].path) }}>
            <Search aria-hidden="true" className="ml-1 size-3.5 shrink-0 text-muted-foreground" />
            <Input aria-label="그래프에서 제목 또는 경로 찾기" type="search" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault() }} placeholder="제목 또는 경로 찾기" className="h-7 rounded-sm px-2 text-xs md:text-xs" />
            <Button type="submit" variant="ghost" size="icon-xs" disabled={!nodes.length} aria-label="첫 검색 결과에 초점 이동" title="첫 검색 결과에 초점 이동"><LocateFixed aria-hidden="true" /></Button>
          </form>
          <Button variant="ghost" size="icon-xs" disabled={graph.isFetching} onClick={() => void graph.refetch()} aria-label="그래프 새로고침" title="새로고침"><RefreshCw aria-hidden="true" className={graph.isFetching ? 'animate-spin motion-reduce:animate-none' : ''} /></Button>
          <Button variant="ghost" size="icon-xs" onClick={() => setFitRequest(previous => previous + 1)} aria-label="그래프 전체 맞춤" title="전체 맞춤"><Maximize aria-hidden="true" /></Button>
          <Button variant="ghost" size="icon-xs" onClick={() => setListOpen(previous => !previous)} aria-expanded={listOpen} aria-controls={listId} aria-label="키보드 노트 목록" title="키보드 노트 목록"><List aria-hidden="true" /></Button>
          <p role="status" className="px-1 text-xs text-muted-foreground">노트 {graph.data.nodes.length} · 링크 {graph.data.edges.length}{term && ` · 검색 ${nodes.length}`}</p>
        </div>
      </GraphCanvas>
      <section className="flex max-h-[40%] shrink-0 flex-col border-t" aria-label="그래프 노트 목록">
        <button type="button" onClick={() => setListOpen(previous => !previous)} aria-expanded={listOpen} aria-controls={listId} className="flex h-7 shrink-0 items-center justify-between gap-2 px-2 text-xs text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"><span className="flex items-center gap-1"><ChevronDown aria-hidden="true" className={`size-3 ${listOpen ? 'rotate-180' : ''}`} />노트 목록 · 키보드 탐색</span><span>{nodes.length}개</span></button>
        <div id={listId} hidden={!listOpen} className="min-h-0 overflow-auto overscroll-contain">
          {nodes.length === 0 ? <EmptyState title="일치하는 노트가 없습니다" description="제목이나 경로의 다른 부분을 입력해 보세요." /> : <ul className="divide-y">{nodes.map(node => <li key={node.path} draggable onDragStart={event => setNoteDragData(event, node.path, { title: node.title })} className={`flex items-center justify-between gap-2 px-2 py-1 hover:bg-accent ${focusPath === node.path ? 'bg-accent/50' : ''}`}>
            <div className="min-w-0"><Link href={noteHref(node.path)} draggable={false} onClick={event => { if (event.button === 0 && !event.shiftKey) { event.preventDefault(); openNode(node.path, event) } }} className="break-words text-label-13 font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring">{node.title || node.path}</Link><p className="break-all text-xs text-muted-foreground">{node.path} · 연결 {degrees.get(node.path) ?? 0}개</p></div>
            <Button variant="ghost" size="xs" onClick={() => focusNode(node.path)} aria-label={`${node.title || node.path}에 그래프 초점 이동`} aria-pressed={focusPath === node.path}><LocateFixed aria-hidden="true" />초점</Button>
          </li>)}</ul>}
        </div>
      </section>
    </>)}
  </div>
}
