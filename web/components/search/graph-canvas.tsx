'use client'

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTheme } from 'next-themes'
import ForceGraph from 'react-force-graph-2d'
import type { ForceGraphMethods, NodeObject } from 'react-force-graph-2d'
import type { KnowledgeGraph } from '@/lib/api'
import { Loading } from '@/components/common'

const FOLDER_COLOR_TOKENS = ['--link', '--warning', '--success', '--destructive', '--muted-foreground']
// Leaves room for the overlay toolbar and legend so fitted nodes are not hidden under them.
const FIT_PADDING = 72
type GraphColors = { background: string; link: string; foreground: string; highlight: string; folders: string[] }
type GraphNode = KnowledgeGraph['nodes'][number] & { id: string; degree: number; folder: string }
type PositionedNode = NodeObject<GraphNode>

// Use the engine's force interface rather than importing a transitive d3 dependency.
function centeringForce(axis: 'x' | 'y') {
  let nodes: PositionedNode[] = []
  const velocity = axis === 'x' ? 'vx' : 'vy'
  const force = (alpha: number) => {
    for (const node of nodes) node[velocity] = (node[velocity] ?? 0) - (node[axis] ?? 0) * 0.025 * alpha
  }
  force.initialize = (next: PositionedNode[]) => { nodes = next }
  return force
}

export default function GraphCanvas({ data, focusPath, focusRequest, fitRequest, matchedPaths, activePaths, onOpen, children }: {
  data: KnowledgeGraph
  focusPath: string | null
  focusRequest: number
  fitRequest: number
  matchedPaths: ReadonlySet<string>
  activePaths: ReadonlySet<string>
  onOpen(path: string, event: MouseEvent): void
  children: ReactNode
}) {
  const { resolvedTheme } = useTheme()
  const [colors, setColors] = useState<GraphColors | null>(null)
  const [reducedMotion, setReducedMotion] = useState(false)
  const container = useRef<HTMLDivElement>(null)
  const graph = useRef<ForceGraphMethods<GraphNode> | undefined>(undefined)
  const fitted = useRef(false)
  const ticks = useRef(0)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [hovered, setHovered] = useState<GraphNode | null>(null)
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null)
  const graphData = useMemo(() => {
    const degrees = new Map<string, number>()
    for (const edge of data.edges) {
      degrees.set(edge.from, (degrees.get(edge.from) ?? 0) + 1)
      degrees.set(edge.to, (degrees.get(edge.to) ?? 0) + 1)
    }
    // The force engine mutates nodes and links; never pass query-cache objects to it.
    return {
      nodes: data.nodes.map(node => ({ ...node, tags: [...node.tags], id: node.path, degree: degrees.get(node.path) ?? 0, folder: node.path.includes('/') ? node.path.split('/')[0] : '(루트)' })),
      links: data.edges.map(edge => ({ source: edge.from, target: edge.to })),
    }
  }, [data])
  const neighbors = useMemo(() => {
    const result = new Map<string, Set<string>>()
    for (const edge of data.edges) {
      if (!result.has(edge.from)) result.set(edge.from, new Set())
      if (!result.has(edge.to)) result.set(edge.to, new Set())
      result.get(edge.from)!.add(edge.to)
      result.get(edge.to)!.add(edge.from)
    }
    return result
  }, [data])
  const hoveredPaths = useMemo(() => hovered ? new Set([hovered.path, ...(neighbors.get(hovered.path) ?? [])]) : null, [hovered, neighbors])
  const folders = useMemo(() => [...new Set(graphData.nodes.map(node => node.folder))].sort(), [graphData])
  // Sorted-index assignment keeps up to five top-level folders visually distinct; hashing collided on small vaults.
  const folderColors = useMemo(() => new Map(folders.map((folder, index) => [folder, colors ? colors.folders[index % colors.folders.length] : ''])), [folders, colors])
  const folder = folders.includes(selectedFolder ?? '') ? selectedFolder : null
  const duration = reducedMotion ? 0 : 400
  useEffect(() => {
    const instance = graph.current
    if (!instance) return
    instance.d3Force('charge')?.strength?.(-70)
    instance.d3Force('link')?.distance?.(55)
    instance.d3Force('x', centeringForce('x'))
    instance.d3Force('y', centeringForce('y'))
  }, [graphData, colors !== null, size.width > 0 && size.height > 0])

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(preference.matches)
    update()
    preference.addEventListener('change', update)
    return () => preference.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    const element = container.current
    if (!element) return
    const probe = document.createElement('span')
    probe.hidden = true
    element.append(probe)
    const resolve = (token: string) => {
      probe.style.color = `var(${token})`
      return getComputedStyle(probe).color
    }
    const update = () => setColors({
      background: resolve('--card'),
      link: resolve('--border'),
      foreground: resolve('--foreground'),
      highlight: resolve('--link'),
      folders: FOLDER_COLOR_TOKENS.map(resolve),
    })
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
    return () => { observer.disconnect(); probe.remove() }
  }, [resolvedTheme])
  useEffect(() => {
    fitted.current = false
    ticks.current = 0
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
    if (!focusRequest || !focusPath || !graph.current) return
    const node = graphData.nodes.find(item => item.path === focusPath) as PositionedNode | undefined
    if (node?.x === undefined || node.y === undefined) return
    graph.current.centerAt(node.x, node.y, duration)
    graph.current.zoom(2.5, duration)
    fitted.current = true
  }, [focusPath, focusRequest, graphData, duration, size.width > 0])
  useEffect(() => {
    if (!fitRequest) return
    graph.current?.zoomToFit(duration, FIT_PADDING)
    fitted.current = true
  }, [fitRequest, duration])

  function fitInitially() {
    if (fitted.current) return
    graph.current?.zoomToFit(duration, FIT_PADDING)
    fitted.current = true
  }
  function endpointPath(endpoint: string | number | PositionedNode | undefined) {
    return typeof endpoint === 'object' ? endpoint.path : String(endpoint ?? '')
  }

  return <div ref={container} className="relative min-h-0 flex-1 overflow-hidden bg-card">
    <div role="img" aria-label={`${data.nodes.length}개 노트와 ${data.edges.length}개 링크의 전체 그래프. 끌어서 이동하고 휠로 확대합니다. 키보드는 노트 목록을 이용하세요.`} className="absolute inset-0">
      {size.width === 0 || size.height === 0 || !colors ? <div className="p-2"><Loading label="그래프 화면을 준비하는 중" /></div> : <ForceGraph<GraphNode>
        ref={graph}
        graphData={graphData}
        width={size.width}
        height={size.height}
        backgroundColor={colors.background}
        nodeVal={node => 1 + Math.min(node.degree, 40)}
        nodeRelSize={3}
        nodeLabel=""
        linkColor={link => hoveredPaths ? (endpointPath(link.source) === hovered?.path || endpointPath(link.target) === hovered?.path ? colors.highlight : `color-mix(in srgb, ${colors.link} 20%, transparent)`) : colors.link}
        linkWidth={link => hoveredPaths && (endpointPath(link.source) === hovered?.path || endpointPath(link.target) === hovered?.path) ? 2 : 0.6}
        linkDirectionalArrowLength={3}
        linkDirectionalArrowRelPos={1}
        cooldownTicks={150}
        cooldownTime={6000}
        d3AlphaDecay={0.035}
        d3VelocityDecay={0.35}
        minZoom={0.05}
        maxZoom={12}
        onEngineTick={() => { if (++ticks.current === 30) fitInitially() }}
        onEngineStop={fitInitially}
        onNodeClick={(node, event) => onOpen(node.path, event)}
        onNodeHover={node => setHovered(node)}
        nodeCanvasObjectMode={() => 'replace'}
        nodeCanvasObject={(node, context, scale) => {
          if (node.x === undefined || node.y === undefined) return
          const radius = 3 * Math.sqrt(1 + Math.min(node.degree, 40))
          const emphasis = hoveredPaths ? hoveredPaths.has(node.path) : matchedPaths.has(node.path) || node.path === focusPath || (folder !== null && node.folder === folder)
          const dimmed = hoveredPaths ? !emphasis : (matchedPaths.size > 0 || folder !== null) && !emphasis
          context.save()
          context.globalAlpha = dimmed ? 0.18 : 1
          context.beginPath()
          context.arc(node.x, node.y, radius, 0, Math.PI * 2)
          context.fillStyle = matchedPaths.has(node.path) ? colors.highlight : folderColors.get(node.folder)!
          context.fill()
          if (activePaths.has(node.path) || node.path === focusPath) {
            context.beginPath()
            context.arc(node.x, node.y, radius + 3 / scale, 0, Math.PI * 2)
            context.strokeStyle = activePaths.has(node.path) ? colors.foreground : colors.highlight
            context.lineWidth = 2 / scale
            context.globalAlpha = 1
            context.stroke()
          }
          const labelThreshold = data.nodes.length > 500 ? 1.8 : data.nodes.length > 200 ? 1.3 : 0.65
          if (emphasis || matchedPaths.has(node.path) || node.path === focusPath || activePaths.has(node.path) || scale >= labelThreshold) {
            const title = node.title || node.path
            context.font = `${12 / scale}px sans-serif`
            context.textAlign = 'center'
            context.textBaseline = 'top'
            context.fillStyle = colors.foreground
            context.fillText(title.length > 44 ? `${title.slice(0, 43)}…` : title, node.x, node.y + radius + 3 / scale)
          }
          context.restore()
        }}
      />}
    </div>
    {children}
    {hovered && <div className="pointer-events-none absolute bottom-2 left-2 right-2 z-10 w-fit max-w-[calc(100%-1rem)] rounded-sm border bg-background/95 px-2 py-1 text-xs"><p className="break-words font-semibold">{hovered.title || hovered.path}</p><p className="break-all text-muted-foreground">{hovered.path}</p></div>}
    <div className="absolute bottom-2 right-2 z-10 max-h-[35%] max-w-[45%] overflow-auto rounded-sm border bg-background/95 p-1">
      <ul aria-label="최상위 폴더 강조" className="flex flex-wrap justify-end gap-0.5 text-xs">{folders.map(name => <li key={name}><button type="button" aria-pressed={folder === name} onClick={() => setSelectedFolder(folder === name ? null : name)} className="flex max-w-full items-center gap-1 rounded-sm px-1.5 py-1 text-muted-foreground hover:bg-accent aria-pressed:bg-accent aria-pressed:text-foreground focus-visible:outline-2 focus-visible:outline-ring"><span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: folderColors.get(name) }} /><span className="break-all">{name}</span></button></li>)}</ul>
    </div>
  </div>
}
