'use client'

import { useId } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { EmptyState, ErrorNotice, Loading } from '@/components/common'
import { Button } from '@/components/ui/button'
import { KnowledgeNoteList } from './note-list'

export function LocalGraph({ path }: { path: string }) {
  const markerId = `local-graph-${useId().replace(/:/g, '')}`
  const graph = useQuery({ queryKey: ['graph', path, 1], queryFn: ({ signal }) => api.graph(path, 1, signal) })
  const neighbors = graph.data?.nodes.filter(node => node.path !== path) ?? []
  const positions = new Map<string, { x: number; y: number }>([[path, { x: 150, y: 110 }]])
  neighbors.forEach((node, index) => {
    const angle = index * Math.PI * 2 / neighbors.length - Math.PI / 2
    positions.set(node.path, { x: 150 + Math.cos(angle) * 115, y: 110 + Math.sin(angle) * 80 })
  })

  return <div className="space-y-3">
    {graph.isPending && <Loading label="주변 연결을 불러오는 중" />}
    {graph.isError && <div className="space-y-2"><ErrorNotice error={graph.error} /><Button variant="outline" size="sm" disabled={graph.isFetching} onClick={() => void graph.refetch()}>그래프 다시 시도</Button></div>}
    {graph.data && (graph.data.nodes.length === 0 ? <EmptyState title="그래프에 표시할 노트가 없습니다" description="색인이 갱신되면 연결된 노트를 확인할 수 있습니다." /> : <>
      <svg viewBox="0 0 300 220" aria-hidden="true" className="w-full rounded-lg border bg-muted/20">
        <defs><marker id={markerId} viewBox="0 0 10 10" refX="18" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" className="fill-muted-foreground" /></marker></defs>
        {graph.data.edges.map(edge => {
          const from = positions.get(edge.from)
          const to = positions.get(edge.to)
          if (!from || !to) return null
          return <line key={`${edge.from}:${edge.to}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} markerEnd={`url(#${markerId})`} className="stroke-muted-foreground/50" />
        })}
        {graph.data.nodes.map(node => {
          const point = positions.get(node.path)!
          return <g key={node.path}><title>{node.title || node.path}</title><circle cx={point.x} cy={point.y} r={node.path === path ? 8 : 5} className={node.path === path ? 'fill-primary' : 'fill-muted-foreground'} /><text x={point.x} y={point.y + 18} textAnchor="middle" className="fill-foreground text-[9px]">{(node.title || node.path).slice(0, 12)}</text></g>
        })}
      </svg>
      <p className="text-xs text-muted-foreground">중앙은 현재 노트입니다. 화살표는 링크 방향을 나타냅니다. {graph.data.nodes.length}개 노트 · {graph.data.edges.length}개 연결</p>
      {neighbors.length > 0 ? <KnowledgeNoteList notes={neighbors} /> : <EmptyState title="아직 연결된 노트가 없습니다" />}
    </>)}
  </div>
}
