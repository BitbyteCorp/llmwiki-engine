'use client'

import { useEffect, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { LocateFixed, RefreshCw, Search } from 'lucide-react'
import { api } from '@/lib/api'
import { EmptyState, ErrorNotice, Loading, PageHeader, noteHref } from '@/components/common'
import { useWorkspace } from '@/components/workspace/context'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const GraphCanvas = dynamic(() => import('./graph-canvas'), { ssr: false, loading: () => <Loading label="그래프 화면을 불러오는 중" /> })

export function GraphPage() {
  const params = useSearchParams()
  const router = useRouter()
  const workspace = useWorkspace()
  const path = params.get('path')?.trim() || undefined
  const requestedDepth = Number(params.get('depth') ?? 1)
  const depth = Number.isInteger(requestedDepth) && requestedDepth >= 1 && requestedDepth <= 5 ? requestedDepth : 1
  const [pathDraft, setPathDraft] = useState(path ?? '')
  const [depthDraft, setDepthDraft] = useState(depth)
  const [query, setQuery] = useState('')
  const [focusPath, setFocusPath] = useState<string | null>(path ?? null)
  const [focusRequest, setFocusRequest] = useState(0)
  useEffect(() => {
    setPathDraft(path ?? '')
    setDepthDraft(depth)
    setFocusPath(path ?? null)
    setQuery('')
  }, [path, depth])
  const graph = useQuery({ queryKey: ['graph', path ?? '', depth], queryFn: ({ signal }) => api.graph(path, depth, signal) })
  const nodes = useMemo(() => {
    const term = query.trim().toLocaleLowerCase('ko-KR')
    return (graph.data?.nodes ?? []).filter(node => !term || `${node.title} ${node.path}`.toLocaleLowerCase('ko-KR').includes(term)).sort((left, right) => (left.title || left.path).localeCompare(right.title || right.path, 'ko'))
  }, [graph.data, query])
  const degrees = useMemo(() => {
    const counts = new Map<string, number>()
    for (const edge of graph.data?.edges ?? []) {
      counts.set(edge.from, (counts.get(edge.from) ?? 0) + 1)
      counts.set(edge.to, (counts.get(edge.to) ?? 0) + 1)
    }
    return counts
  }, [graph.data])
  function focusNode(notePath: string) {
    setFocusPath(notePath)
    setFocusRequest(previous => previous + 1)
  }

  return <div className="space-y-6">
    <PageHeader title="지식 그래프" description="노트의 링크와 역링크를 살펴보고 연결된 지식을 탐색합니다." actions={<Button variant="outline" disabled={graph.isFetching} onClick={() => void graph.refetch()}><RefreshCw aria-hidden="true" className={graph.isFetching ? 'animate-spin motion-reduce:animate-none' : ''} />새로고침</Button>} />
    <form className="space-y-3 rounded-lg border p-4" onSubmit={event => {
      event.preventDefault()
      const next = new URLSearchParams()
      if (pathDraft.trim()) {
        next.set('path', pathDraft.trim())
        next.set('depth', String(depthDraft))
      }
      const href = next.size ? `/graph?${next}` : '/graph'
      if (pathDraft.trim() === (path ?? '') && (!path || depthDraft === depth)) void graph.refetch()
      else router.push(href)
    }}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1 space-y-1.5"><Label htmlFor="graph-root">중심 노트 경로</Label><Input id="graph-root" name="path" value={pathDraft} onChange={event => setPathDraft(event.target.value)} placeholder="전체 그래프는 비워 두세요 · wiki/노트.md" /></div>
        <div className="space-y-1.5"><Label htmlFor="graph-depth">연결 깊이 · {depthDraft}단계</Label><Input id="graph-depth" name="depth" type="range" min={1} max={5} step={1} value={depthDraft} aria-valuetext={`${depthDraft}단계`} onChange={event => setDepthDraft(Number(event.target.value))} disabled={!pathDraft.trim()} className="w-40 px-0" /></div>
        <Button type="submit">그래프 보기</Button>
        {path && <Link href="/graph" className="rounded-md px-2 py-1 text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">전체 그래프</Link>}
      </div>
      <p className="break-all text-xs text-muted-foreground">{path ? `${path}를 중심으로 ${depth}단계 연결을 표시합니다. 범위는 URL에 저장됩니다.` : '전체 그래프는 연결이 없는 노트도 포함합니다. 노트를 중심으로 1~5단계까지 좁힐 수 있습니다.'}</p>
    </form>
    {graph.isPending && <Loading label="노트 연결을 불러오는 중" />}
    {graph.isError && <div className="space-y-3"><ErrorNotice error={graph.error} /><Button variant="outline" onClick={() => void graph.refetch()} disabled={graph.isFetching}>다시 시도</Button></div>}
    {graph.data && (graph.data.nodes.length === 0 ? <EmptyState title="표시할 노트가 없습니다" description={path ? '중심 노트 경로를 확인하거나 전체 그래프를 열어 보세요. 색인에 포함된 노트만 표시합니다.' : '노트를 추가하고 색인이 완료되면 그래프에 나타납니다.'} /> : <>
      <p className="text-sm text-muted-foreground" aria-live="polite">노트 {graph.data.nodes.length}개 · 링크 {graph.data.edges.length}개</p>
      <section className="space-y-3" aria-label="그래프에서 노트 찾기">
        <form role="search" className="space-y-2" onSubmit={event => { event.preventDefault(); if (nodes[0]) focusNode(nodes[0].path) }}>
          <Label htmlFor="graph-search">현재 그래프에서 제목 또는 경로 찾기</Label>
          <div className="flex gap-2"><Input id="graph-search" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="노트 제목 또는 경로" /><Button type="submit" disabled={!nodes.length}><Search aria-hidden="true" />초점 이동</Button></div>
        </form>
        <GraphCanvas key={`${path ?? ''}:${depth}`} data={graph.data} focusPath={focusPath} focusRequest={focusRequest} onOpen={notePath => workspace.openNote(notePath)} />
      </section>
      <section aria-labelledby="graph-list-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="graph-list-heading" className="text-base font-semibold">노트 목록 · 키보드 탐색</h2><p role="status" className="text-xs text-muted-foreground">{nodes.length}개 표시</p></div>
        {nodes.length === 0 ? <EmptyState title="일치하는 노트가 없습니다" description="제목이나 경로의 다른 부분을 입력해 보세요." /> : <ul className="max-h-[32rem] overflow-y-auto divide-y rounded-lg border">{nodes.map(node => <li key={node.path} className={`flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between ${focusPath === node.path ? 'bg-accent/50' : ''}`}>
          <div className="min-w-0"><Link href={noteHref(node.path)} onClick={event => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); workspace.openNote(node.path) } }} className="break-words font-medium underline-offset-4 hover:underline">{node.title || node.path}</Link><p className="break-all text-xs text-muted-foreground">{node.path} · 연결 {degrees.get(node.path) ?? 0}개</p></div>
          <div className="flex shrink-0 items-center gap-2"><Button variant="ghost" size="sm" onClick={() => focusNode(node.path)} aria-label={`${node.title || node.path}에 그래프 초점 이동`} aria-pressed={focusPath === node.path}><LocateFixed aria-hidden="true" />초점</Button><Link href={`/graph?${new URLSearchParams({ path: node.path, depth: String(depth) })}`} className="rounded-md px-2 py-1 text-xs underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">지역 그래프</Link></div>
        </li>)}</ul>}
      </section>
    </>)}
  </div>
}
