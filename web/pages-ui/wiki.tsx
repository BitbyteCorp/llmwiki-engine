'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { ChevronRight, FileText, Folder, History } from 'lucide-react'
import { api } from '@/lib/api'
import { EmptyState, ErrorNotice, Loading, PageHeader, noteHref } from '@/components/common'
import { Markdown } from '@/components/markdown'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

interface TreeNode {
  name: string
  path: string
  children?: TreeNode[]
}

function buildTree(files: string[]): TreeNode[] {
  const roots: TreeNode[] = []
  const nodes = new Map<string, TreeNode>()
  for (const file of files) {
    const parts = file.split('/')
    let siblings = roots
    let prefix = ''
    for (let index = 0; index < parts.length; index++) {
      const name = parts[index]
      prefix = prefix ? `${prefix}/${name}` : name
      let node = nodes.get(prefix)
      if (!node) {
        node = { name, path: prefix, ...(index < parts.length - 1 ? { children: [] } : {}) }
        nodes.set(prefix, node)
        siblings.push(node)
      }
      if (node.children) siblings = node.children
    }
  }
  function sort(nodesToSort: TreeNode[]) {
    nodesToSort.sort((a, b) => Number(Boolean(b.children)) - Number(Boolean(a.children)) || a.name.localeCompare(b.name, 'ko'))
    for (const node of nodesToSort) if (node.children) sort(node.children)
  }
  sort(roots)
  return roots
}

function TreeBranch({ node, selected }: { node: TreeNode; selected: string }) {
  const containsSelected = Boolean(node.children && selected.startsWith(`${node.path}/`))
  const [open, setOpen] = useState(containsSelected)
  useEffect(() => {
    if (containsSelected) setOpen(true)
  }, [containsSelected, selected])

  if (node.children) {
    return (
      <li>
        <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="group/folder">
          <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
            <ChevronRight aria-hidden="true" className={`size-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
            <Folder aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{node.name}</span>
          </summary>
          <ul className="ml-3 border-l pl-2">
            {node.children.map((child) => <TreeBranch key={child.path} node={child} selected={selected} />)}
          </ul>
        </details>
      </li>
    )
  }
  const active = selected === node.path
  return (
    <li>
      <Link
        href={noteHref(node.path)}
        aria-current={active ? 'page' : undefined}
        title={node.path}
        className={`flex items-center gap-2 rounded-md px-2 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
      >
        <FileText aria-hidden="true" className="size-4 shrink-0" />
        <span className="truncate">{node.name}</span>
      </Link>
    </li>
  )
}

export function WikiPage() {
  const params = useParams<{ path?: string[] }>()
  const router = useRouter()
  const tree = useQuery({ queryKey: ['notes/tree'], queryFn: () => api.tree() })
  const nodes = useMemo(() => buildTree(tree.data?.files ?? []), [tree.data])
  const requestedPath = params.path?.map((segment) => decodeURIComponent(segment)).join('/')
  const defaultPath = tree.data?.files.includes('index.md') ? 'index.md' : tree.data?.files[0]
  const path = requestedPath || defaultPath || ''
  const note = useQuery({ queryKey: ['notes/content', path], queryFn: () => api.note(path), enabled: Boolean(path) })

  useEffect(() => {
    if (!requestedPath && defaultPath) {
      router.replace(noteHref(defaultPath))
    }
  }, [requestedPath, defaultPath, router])

  const frontmatter = note.data?.frontmatter ?? {}
  const title = typeof frontmatter.title === 'string' && frontmatter.title.trim() ? frontmatter.title : path.split('/').pop()?.replace(/\.md$/i, '') || '위키'
  const tags = Array.isArray(frontmatter.tags)
    ? frontmatter.tags.filter((tag): tag is string => typeof tag === 'string')
    : typeof frontmatter.tags === 'string' ? frontmatter.tags.split(/[,\s]+/).filter(Boolean) : []
  const updated = frontmatter.updated instanceof Date ? frontmatter.updated.toISOString().slice(0, 10) : typeof frontmatter.updated === 'string' ? frontmatter.updated : null
  const importance = typeof frontmatter.importance === 'string' ? ({ high: '높음', medium: '보통', low: '낮음' } as Record<string, string>)[frontmatter.importance] : null

  return (
    <div className="space-y-6">
      <PageHeader title="위키" description="지식 저장소의 색인과 노트를 탐색합니다." />
      <div className="grid items-start gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="min-w-0 rounded-lg border p-3 lg:sticky lg:top-6">
          <div className="mb-2 flex items-center justify-between px-2">
            <h2 className="text-sm font-semibold">노트 탐색</h2>
            {tree.data && <span className="text-xs text-muted-foreground">{tree.data.files.length}개</span>}
          </div>
          {tree.isPending && <Loading label="노트 목록을 불러오는 중" />}
          {tree.isError && <ErrorNotice error={tree.error} />}
          {tree.data && nodes.length === 0 && <p className="px-2 py-3 text-sm text-muted-foreground">아직 노트가 없습니다.</p>}
          <nav aria-label="위키 폴더와 노트" className="max-h-72 overflow-y-auto lg:max-h-[calc(100vh-230px)]">
            <ul className="space-y-0.5">{nodes.map((node) => <TreeBranch key={node.path} node={node} selected={path} />)}</ul>
          </nav>
        </aside>
        <section className="min-w-0" aria-label="노트 본문">
          {!path && tree.isPending && <Loading label="위키를 불러오는 중" />}
          {!path && tree.data && <EmptyState title="지식 저장소가 비어 있습니다" description="노트가 추가되면 이곳에서 읽을 수 있습니다." />}
          {!path && tree.isError && <EmptyState title="노트 목록을 불러오지 못했습니다" description="잠시 후 다시 시도해 주세요." />}
          {path && note.isPending && <Loading label="노트를 불러오는 중" />}
          {path && note.isError && <ErrorNotice error={note.error} />}
          {note.data && (
            <article className="space-y-6">
              <header className="space-y-3 border-b pb-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <h2 className="break-words text-2xl font-bold tracking-tight">{title}</h2>
                    <p className="break-all text-xs text-muted-foreground">{note.data.path}</p>
                  </div>
                  <Button variant="outline" nativeButton={false} render={<Link href={`/history?path=${encodeURIComponent(note.data.path)}`} />}>
                    <History aria-hidden="true" />변경 이력
                  </Button>
                </div>
                {(tags.length > 0 || updated || importance) && (
                  <div className="flex flex-wrap gap-2" aria-label="노트 속성">
                    {updated && <Badge variant="outline">업데이트 {updated}</Badge>}
                    {importance && <Badge variant="outline">중요도 {importance}</Badge>}
                    {[...new Set(tags)].map((tag) => <Badge key={tag} variant="secondary">#{tag.replace(/^#/, '')}</Badge>)}
                  </div>
                )}
              </header>
              {note.data.body.trim() ? <Markdown content={note.data.body} path={note.data.path} /> : <EmptyState title="본문이 없는 노트입니다" />}
            </article>
          )}
        </section>
      </div>
    </div>
  )
}
