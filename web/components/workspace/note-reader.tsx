'use client'

import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { History, Star, X } from 'lucide-react'
import { api } from '@/lib/api'
import { EmptyState, ErrorNotice, Loading } from '@/components/common'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { useWorkspace } from '@/components/workspace/context'
import { Breadcrumbs } from '@/components/workspace/breadcrumbs'
import { Outline } from '@/components/workspace/outline'
import { Properties } from '@/components/workspace/properties'

function urlFragment() {
  try { return decodeURIComponent(window.location.hash.slice(1)) } catch { return window.location.hash.slice(1) }
}

export function NoteReader({ path, split = false }: { path: string; split?: boolean }) {
  const { favoritePaths, toggleFavorite, toggleSplit, rememberTitle, setNoteInfo } = useWorkspace()
  const note = useQuery({ queryKey: ['notes/content', path], queryFn: () => api.note(path), enabled: Boolean(path) })
  const scrollerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [fragment, setFragment] = useState<{ path: string; id: string } | null>(null)
  const frontmatter = note.data?.frontmatter ?? {}
  const title = typeof frontmatter.title === 'string' && frontmatter.title.trim()
    ? frontmatter.title.trim() : path.split('/').pop()?.replace(/\.md$/i, '') || '노트'
  const favorite = favoritePaths.includes(path)
  const Heading = split ? 'h2' : 'h1'

  useEffect(() => {
    if (note.data) rememberTitle(note.data.path, title)
  }, [note.data, title, rememberTitle])

  useEffect(() => {
    if (split) return
    setNoteInfo(note.data ? { path: note.data.path, updatedSha: note.data.updatedSha, body: note.data.body } : null)
    return () => setNoteInfo(null)
  }, [split, note.data, setNoteInfo])

  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: 0 })
    if (!split) setFragment({ path, id: urlFragment() })
  }, [path, split])

  useEffect(() => {
    if (!split) {
      const changed = () => setFragment({ path, id: urlFragment() })
      window.addEventListener('hashchange', changed)
      return () => window.removeEventListener('hashchange', changed)
    }
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ path: string; fragment: string }>).detail
      if (detail && typeof detail.path === 'string' && typeof detail.fragment === 'string') setFragment({ path: detail.path, id: detail.fragment })
    }
    window.addEventListener('workspace-split-fragment', changed)
    return () => window.removeEventListener('workspace-split-fragment', changed)
  }, [path, split])

  useEffect(() => {
    if (!note.data || fragment?.path !== path || !fragment.id) return
    const frame = requestAnimationFrame(() => {
      const scroller = scrollerRef.current
      const target = Array.from(contentRef.current?.querySelectorAll<HTMLElement>('[id]') ?? []).find(element => element.id === fragment.id)
      if (!scroller || !target) return
      scroller.scrollTo({ top: scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16 })
      target.setAttribute('tabindex', '-1')
      target.focus({ preventScroll: true })
      target.addEventListener('blur', () => target.removeAttribute('tabindex'), { once: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [path, fragment, note.data])

  return (
    <section aria-label={split ? '분할 노트 본문' : '노트 본문'} className="flex h-[70dvh] min-h-80 min-w-0 flex-col rounded-lg border md:h-full md:min-h-0">
      <header className="shrink-0 space-y-2 border-b p-4">
        <Breadcrumbs path={path} title={title} />
        <div className="flex items-start justify-between gap-2">
          <Heading className="min-w-0 break-words text-xl font-bold tracking-tight">{title}</Heading>
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="ghost" size="icon-sm" aria-label={favorite ? '즐겨찾기에서 제거' : '즐겨찾기에 추가'} aria-pressed={favorite} title={favorite ? '즐겨찾기에서 제거' : '즐겨찾기에 추가'} onClick={() => toggleFavorite(path)}><Star aria-hidden="true" className={favorite ? 'fill-current text-amber-500' : ''} /></Button>
            <Button variant="ghost" size="icon-sm" nativeButton={false} aria-label="이 노트의 변경 이력" title="변경 이력" render={<Link href={`/history?path=${encodeURIComponent(path)}`} />}><History aria-hidden="true" /></Button>
            {split && <Button variant="ghost" size="icon-sm" aria-label="분할 노트 닫기" onClick={toggleSplit}><X aria-hidden="true" /></Button>}
          </div>
        </div>
        <p className="break-all text-xs text-muted-foreground">{path}{split && <span className="ml-2">· 분할 보기</span>}</p>
      </header>
      <div ref={scrollerRef} tabIndex={0} aria-label={split ? '분할 노트 읽기 영역' : '노트 읽기 영역'} className="min-h-0 flex-1 overflow-auto overscroll-contain p-4 focus-visible:outline-2 focus-visible:outline-ring sm:p-5">
        {note.isPending && <Loading label="노트를 불러오는 중" />}
        {note.isError && <div className="mb-4 space-y-3"><ErrorNotice error={note.error} /><Button variant="outline" disabled={note.isFetching} onClick={() => void note.refetch()}>다시 시도</Button></div>}
        {note.data && <article className="space-y-5">
          <Properties frontmatter={frontmatter} />
          <Outline contentRef={contentRef} scrollerRef={scrollerRef} revision={`${path}:${note.data.updatedSha}`} />
          <div ref={contentRef}>{note.data.body.trim() ? <Markdown content={note.data.body} path={note.data.path} split={split} /> : <EmptyState title="본문이 없는 노트입니다" />}</div>
        </article>}
      </div>
    </section>
  )
}
