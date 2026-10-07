'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, FileText, Folder, LocateFixed, Star } from 'lucide-react'
import { api } from '@/lib/api'
import { ErrorNotice, Loading } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useWorkspace } from './context'

type Node = { name: string; path: string; children?: Node[] }
function buildTree(files: string[]): Node[] {
  const roots: Node[] = []
  const nodes = new Map<string, Node>()
  for (const file of files) {
    const parts = file.split('/')
    let siblings = roots
    let prefix = ''
    for (let index = 0; index < parts.length; index++) {
      prefix = prefix ? `${prefix}/${parts[index]}` : parts[index]
      let node = nodes.get(prefix)
      if (!node) {
        node = { name: parts[index], path: prefix, ...(index < parts.length - 1 ? { children: [] } : {}) }
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

export function Explorer({ userId }: { userId: number }) {
  const workspace = useWorkspace()
  const tree = useQuery({ queryKey: ['notes/tree'], queryFn: api.tree })
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<string[]>([])
  const [highlight, setHighlight] = useState('')
  const [ready, setReady] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const storageKey = `llmwiki.explorer.v1.${userId}`
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null') as { filter: string; expanded: string[] } | null
      if (saved && typeof saved.filter === 'string' && Array.isArray(saved.expanded)) { setFilter(saved.filter); setExpanded(saved.expanded) }
    } catch { /* Explorer remains usable without persistent storage. */ }
    setReady(true)
  }, [storageKey])
  useEffect(() => {
    if (ready) try { localStorage.setItem(storageKey, JSON.stringify({ filter, expanded })) } catch { /* Storage may be unavailable. */ }
  }, [filter, expanded, ready, storageKey])
  useEffect(() => {
    if (!ready || !workspace.activePath) return
    const parts = workspace.activePath.split('/')
    const ancestors = parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'))
    setExpanded(previous => [...new Set([...previous, ...ancestors])])
  }, [workspace.activePath, ready])
  useEffect(() => {
    if (!workspace.activePath) return
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
  const filtered = useMemo(() => (tree.data?.files ?? []).filter(path => `${path} ${workspace.knownTitles[path] || ''}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase())), [tree.data, filter, workspace.knownTitles])
  const nodes = useMemo(() => buildTree(filtered), [filtered])
  function renderNodes(branch: Node[]) {
    return branch.map(node => {
      const open = Boolean(filter) || expanded.includes(node.path)
      if (node.children) return <li key={node.path}><button type="button" data-explorer-path={node.path} aria-expanded={open} className={cn('explorer-row w-full', highlight === node.path && 'bg-accent ring-1 ring-inset ring-ring')} onClick={() => setExpanded(previous => previous.includes(node.path) ? previous.filter(path => path !== node.path) : [...previous, node.path])}><ChevronRight className={cn('size-3 shrink-0', open && 'rotate-90')} /><Folder className="size-4 shrink-0 text-muted-foreground" /><span className="truncate">{node.name}</span></button>{open && <ul className="ml-3 border-l pl-2">{renderNodes(node.children)}</ul>}</li>
      const active = node.path === workspace.activePath
      return <li key={node.path} className="group flex min-w-0"><button type="button" title={node.path} data-explorer-path={node.path} aria-current={active ? 'page' : undefined} className={cn('explorer-row min-w-0 flex-1', active && 'bg-accent font-bold', highlight === node.path && 'ring-1 ring-inset ring-ring')} onClick={event => workspace.openNote(node.path, { split: event.altKey, pin: event.ctrlKey || event.metaKey })} onDoubleClick={() => workspace.pinTab(node.path)}><FileText className="size-4 shrink-0 text-muted-foreground" /><span className="truncate">{workspace.knownTitles[node.path] || node.name}</span></button><button type="button" title="즐겨찾기 전환" aria-label={`${node.name} 즐겨찾기 전환`} aria-pressed={workspace.favoritePaths.includes(node.path)} className="px-1 text-muted-foreground hover:text-foreground" onClick={() => workspace.toggleFavorite(node.path)}><Star className={cn('size-3.5', workspace.favoritePaths.includes(node.path) && 'fill-current text-amber-600 dark:text-amber-400')} /></button></li>
    })
  }
  return <div ref={root} className="flex h-full min-h-0 flex-col"><div className="flex items-center justify-between px-3 py-2"><h2 className="text-xs font-bold">탐색기</h2><Button variant="ghost" size="icon-sm" aria-label="현재 노트 위치 표시" disabled={!workspace.activePath} onClick={() => workspace.revealFolder(workspace.activePath)}><LocateFixed className="size-4" /></Button></div><div className="px-3 pb-2"><Input aria-label="노트 경로 필터" placeholder="경로·제목 필터…" value={filter} onChange={event => setFilter(event.target.value)} /></div><div className="min-h-0 flex-1 overflow-auto px-2 pb-4">{tree.isPending && <Loading label="노트 목록 불러오는 중…" />}{tree.error && <div className="space-y-2"><ErrorNotice error={tree.error} /><Button variant="outline" onClick={() => void tree.refetch()}>다시 시도</Button></div>}{!filter && [['즐겨찾기', workspace.favoritePaths], ['최근 노트', workspace.recentPaths.slice(0, 8)]].map(([label, paths]) => <section key={label as string} className="mb-3"><h3 className="px-2 py-2 text-xs text-muted-foreground">{label}</h3><ul>{(paths as string[]).map(path => <li key={path}><button className={cn('explorer-row w-full', workspace.activePath === path && 'bg-accent')} title={path} onClick={() => workspace.openNote(path)}><FileText className="size-3.5 shrink-0" /><span className="truncate">{workspace.knownTitles[path] || path}</span></button></li>)}</ul>{!(paths as string[]).length && <p className="px-2 text-xs text-muted-foreground">아직 없습니다.</p>}</section>)}<h3 className="px-2 py-2 text-xs text-muted-foreground">노트 {filtered.length}개</h3><nav aria-label="위키 폴더와 노트"><ul>{renderNodes(nodes)}</ul></nav>{tree.data && !filtered.length && <p className="p-2 text-sm text-muted-foreground">{filter ? '일치하는 노트가 없습니다.' : '지식 저장소가 비어 있습니다.'}</p>}</div></div>
}
