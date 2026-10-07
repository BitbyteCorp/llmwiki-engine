'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useTheme } from 'next-themes'
import ForceGraph from 'react-force-graph-2d'
import type { ForceGraphMethods, NodeObject } from 'react-force-graph-2d'
import { Maximize } from 'lucide-react'
import type { KnowledgeGraph } from '@/lib/api'
import { Loading } from '@/components/common'
import { Button } from '@/components/ui/button'

const LIGHT_COLORS = ['#2563eb', '#b45309', '#7c3aed', '#047857', '#be185d', '#0e7490', '#c2410c', '#4d7c0f']
const DARK_COLORS = ['#93c5fd', '#fcd34d', '#c4b5fd', '#6ee7b7', '#f9a8d4', '#67e8f9', '#fdba74', '#bef264']

function colorOf(folder: string, dark: boolean) {
  let hash = 0
  for (let index = 0; index < folder.length; index++) hash = ((hash * 31) + folder.charCodeAt(index)) >>> 0
  return (dark ? DARK_COLORS : LIGHT_COLORS)[hash % LIGHT_COLORS.length]
}
type GraphNode = KnowledgeGraph['nodes'][number] & { id: string; degree: number; folder: string }

export default function GraphCanvas({ data, focusPath, focusRequest, onOpen }: {
  data: KnowledgeGraph
  focusPath: string | null
  focusRequest: number
  onOpen(path: string): void
}) {
  const { resolvedTheme } = useTheme()
  const dark = resolvedTheme === 'dark'
  const container = useRef<HTMLDivElement>(null)
  const graph = useRef<ForceGraphMethods<GraphNode> | undefined>(undefined)
  const fitted = useRef(false)
  const [size, setSize] = useState({ width: 0, height: 400 })
  const [hovered, setHovered] = useState<GraphNode | null>(null)
  const graphData = useMemo(() => {
    const degrees = new Map<string, number>()
    for (const edge of data.edges) {
      degrees.set(edge.from, (degrees.get(edge.from) ?? 0) + 1)
      degrees.set(edge.to, (degrees.get(edge.to) ?? 0) + 1)
    }
    // The force engine mutates its nodes and links; never pass query-cache objects to it.
    return {
      nodes: data.nodes.map(node => ({ ...node, id: node.path, degree: degrees.get(node.path) ?? 0, folder: node.path.includes('/') ? node.path.split('/')[0] : '(루트)' })),
      links: data.edges.map(edge => ({ source: edge.from, target: edge.to })),
    }
  }, [data])
  const folders = useMemo(() => [...new Set(graphData.nodes.map(node => node.folder))].sort(), [graphData])

  useEffect(() => {
    fitted.current = false
    setHovered(null)
  }, [graphData])
  useEffect(() => {
    if (!container.current) return
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) })
    })
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!focusPath || !graph.current) return
    const node = graphData.nodes.find(item => item.path === focusPath) as NodeObject<GraphNode> | undefined
    if (node?.x === undefined || node.y === undefined) return
    graph.current.centerAt(node.x, node.y, 400)
    graph.current.zoom(2.5, 400)
    fitted.current = true
  }, [focusPath, focusRequest, graphData, size.width])

  function focusOrFit() {
    if (fitted.current) return
    const node = graphData.nodes.find(item => item.path === focusPath) as NodeObject<GraphNode> | undefined
    if (node?.x !== undefined && node.y !== undefined) {
      graph.current?.centerAt(node.x, node.y, 400)
      graph.current?.zoom(2.5, 400)
    } else graph.current?.zoomToFit(400, 36)
    fitted.current = true
  }

  return <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p id="graph-canvas-help" className="text-xs text-muted-foreground">끌어서 이동 · 휠이나 두 손가락으로 확대 · 노트를 눌러 열기. 키보드 사용자는 아래 노트 목록을 이용하세요.</p>
      <Button variant="outline" onClick={() => graph.current?.zoomToFit(400, 36)}><Maximize aria-hidden="true" />전체 맞춤</Button>
    </div>
    <div ref={container} role="img" aria-label={`${data.nodes.length}개 노트의 연결 그래프`} aria-describedby="graph-canvas-help" className="relative h-[min(60vh,540px)] min-h-80 overflow-hidden rounded-lg border bg-background">
      {size.width === 0 ? <div className="p-4"><Loading label="그래프 화면을 준비하는 중" /></div> : <ForceGraph<GraphNode>
        ref={graph}
        graphData={graphData}
        width={size.width}
        height={size.height}
        backgroundColor={dark ? '#111827' : '#f8fafc'}
        nodeVal={node => 1 + Math.min(node.degree, 40)}
        nodeRelSize={3}
        nodeColor={node => colorOf(node.folder, dark)}
        nodeLabel=""
        linkColor={() => dark ? '#64748b88' : '#94a3b888'}
        linkDirectionalArrowLength={3}
        linkDirectionalArrowRelPos={1}
        cooldownTicks={150}
        cooldownTime={6000}
        minZoom={0.05}
        maxZoom={12}
        onEngineStop={focusOrFit}
        onNodeClick={node => onOpen(node.path)}
        onNodeHover={node => setHovered(node)}
        nodeCanvasObjectMode={() => 'after'}
        nodeCanvasObject={(node, context, scale) => {
          if (node.x === undefined || node.y === undefined) return
          const selected = node.path === focusPath
          if (selected) {
            context.beginPath()
            context.arc(node.x, node.y, 3 * Math.sqrt(1 + Math.min(node.degree, 40)) + 3 / scale, 0, Math.PI * 2)
            context.strokeStyle = dark ? '#f8fafc' : '#0f172a'
            context.lineWidth = 2 / scale
            context.stroke()
          }
          if (!selected && (scale < 0.45 || (data.nodes.length > 200 && scale < 1.3))) return
          const title = node.title || node.path
          const label = title.length > 44 ? `${title.slice(0, 43)}…` : title
          context.font = `${12 / scale}px sans-serif`
          context.textAlign = 'center'
          context.textBaseline = 'top'
          context.fillStyle = dark ? '#e2e8f0' : '#334155'
          context.fillText(label, node.x, node.y + 3 * Math.sqrt(1 + Math.min(node.degree, 40)) + 3 / scale)
        }}
      />}
      {hovered && <div className="pointer-events-none absolute bottom-3 left-3 right-3 w-fit max-w-[calc(100%-1.5rem)] rounded-md border bg-background/95 px-3 py-2 text-xs shadow-sm"><p className="break-words font-semibold">{hovered.title || hovered.path}</p><p className="break-all text-muted-foreground">{hovered.path}</p></div>}
    </div>
    <ul aria-label="최상위 폴더 색상" className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">{folders.map(folder => <li key={folder} className="flex items-center gap-1.5"><span aria-hidden="true" className="size-2.5 rounded-full" style={{ backgroundColor: colorOf(folder, dark) }} />{folder}</li>)}</ul>
    <p className="text-xs text-muted-foreground">노트 크기는 연결 수를 나타냅니다. 화살표는 링크 방향입니다. 큰 그래프는 축소 시 제목을 숨기고, 배치 계산은 최대 6초 뒤 멈춥니다.</p>
  </div>
}
