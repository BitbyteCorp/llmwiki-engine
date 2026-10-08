'use client'

import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { api } from '@/lib/api'
import { wikiTarget } from '@/lib/wikilinks'
import { EmptyState, ErrorNotice, Loading, noteHref } from '@/components/common'
import { Button } from '@/components/ui/button'
import { useWorkspace } from '@/components/workspace/context'
import { isGraphTab } from '@/components/workspace/layout'
import { ViewHeader } from '@/components/workspace/view-pane'
import { dispatchEditorCommand } from '@/components/editor/state'
import { KnowledgeNoteList } from './note-list'

export function LinksPanel() {
  const { activePath, openNote } = useWorkspace()
  const notePath = isGraphTab(activePath) ? '' : activePath
  const links = useQuery({ queryKey: ['links', notePath], queryFn: ({ signal }) => api.links(notePath, signal), enabled: Boolean(notePath) })
  const similar = useQuery({ queryKey: ['similar', notePath], queryFn: ({ signal }) => api.similar(notePath, signal), enabled: Boolean(notePath) })
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, enabled: Boolean(notePath) })
  const canCreate = me.data?.user.role === 'editor' || me.data?.user.role === 'admin'
  const [closedViews, setClosedViews] = useState<string[]>([])

  // Empty views are hidden; a view shows only while it is loading, failed, or has rows.
  const view = (id: string, title: string, count: number | null, body: ReactNode) => {
    const open = !closedViews.includes(id)
    return <section key={id} aria-label={title} className="flex shrink-0 flex-col border-b">
      <ViewHeader title={title} open={open} onToggle={() => setClosedViews(previous => previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id])} actions={count !== null && <span className="px-1 text-[11px] tabular-nums text-muted-foreground">{count}</span>} />
      {open && <div className="max-h-[min(14rem,30vh)] overflow-auto overscroll-contain px-2 pb-1">{body}</div>}
    </section>
  }
  const backlinks = links.data?.backlinks ?? []
  const outgoing = links.data?.outgoing ?? []
  const unresolved = links.data?.unresolved ?? []
  const nothing = links.isSuccess && similar.isSuccess && !backlinks.length && !outgoing.length && !unresolved.length && !similar.data.length

  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 px-3"><h2 className="text-xs font-semibold text-muted-foreground">노트 연결</h2></div>
    {!notePath ? <div className="px-2"><EmptyState title="노트를 먼저 열어 주세요" description="현재 노트의 링크와 의미상 유사한 노트를 확인합니다." /></div> : <>
      <p className="shrink-0 truncate px-3 pb-1 text-xs text-muted-foreground" title={notePath}>{notePath}</p>
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain border-t">
        {links.isPending && <div className="px-2"><Loading label="노트 링크를 불러오는 중" /></div>}
        {links.isError && <div className="space-y-2 p-2"><ErrorNotice error={links.error} /><Button variant="outline" size="sm" disabled={links.isFetching} onClick={() => void links.refetch()}>링크 다시 시도</Button></div>}
        {backlinks.length > 0 && view('backlinks', '역링크', backlinks.length, <KnowledgeNoteList notes={backlinks} className="border-y-0" />)}
        {outgoing.length > 0 && view('outgoing', '나가는 링크', outgoing.length, <KnowledgeNoteList notes={outgoing} className="border-y-0" />)}
        {unresolved.length > 0 && view('unresolved', '미해결 링크', unresolved.length, <ul className="divide-y">{unresolved.map(name => {
          const target = wikiTarget(name, notePath)
          const path = target ? target.name.replace(/\.md$/i, '') + '.md' : null
          return <li key={name} className="space-y-1 px-2 py-1.5">
            <p className="break-words text-label-13">{name}</p>
            {path ? <Link href={noteHref(path)} className="inline-flex items-center gap-1 rounded text-xs text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring" onNavigate={event => {
              event.preventDefault()
              if (canCreate) dispatchEditorCommand('new', path, { exactPath: true })
              else openNote(path, { fragment: target?.fragment })
            }}>{canCreate && <Plus aria-hidden="true" className="size-3" />}{canCreate ? '새 노트 만들기' : '대상 노트 열기'}</Link> : <p className="text-xs text-muted-foreground">올바른 노트 경로가 아닙니다.</p>}
          </li>
        })}</ul>)}
        {(similar.isPending || similar.isError || (similar.data?.length ?? 0) > 0) && view('similar', '의미상 유사', similar.data?.length ?? null, <>
          <p className="py-1 text-xs text-muted-foreground">명시적 링크와 별개로, 노트 내용의 의미를 비교한 결과입니다.</p>
          {similar.isPending && <Loading label="유사한 노트를 불러오는 중" />}
          {similar.isError && <div className="space-y-2 pb-1"><ErrorNotice error={similar.error} /><Button variant="outline" size="sm" disabled={similar.isFetching} onClick={() => void similar.refetch()}>유사 노트 다시 시도</Button></div>}
          {similar.data && <KnowledgeNoteList notes={similar.data} className="border-y-0" />}
        </>)}
        {nothing && <div className="px-2"><EmptyState title="연결된 노트가 없습니다" description="역링크·나가는 링크·미해결 링크가 없고 의미상 유사한 노트도 찾지 못했습니다. 임베딩이 준비되지 않은 경우에도 유사 노트가 비어 있을 수 있습니다." /></div>}
      </div>
    </>}
  </div>
}
