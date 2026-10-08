'use client'

import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { api } from '@/lib/api'
import { wikiTarget } from '@/lib/wikilinks'
import { EmptyState, ErrorNotice, Loading, noteHref } from '@/components/common'
import { Button } from '@/components/ui/button'
import { useWorkspace } from '@/components/workspace/context'
import { isGraphTab } from '@/components/workspace/layout'
import { dispatchEditorCommand } from '@/components/editor/state'
import { KnowledgeNoteList } from './note-list'

export function LinksPanel() {
  const { activePath, openNote } = useWorkspace()
  const notePath = isGraphTab(activePath) ? '' : activePath
  const links = useQuery({ queryKey: ['links', notePath], queryFn: ({ signal }) => api.links(notePath, signal), enabled: Boolean(notePath) })
  const similar = useQuery({ queryKey: ['similar', notePath], queryFn: ({ signal }) => api.similar(notePath, signal), enabled: Boolean(notePath) })
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, enabled: Boolean(notePath) })
  const canCreate = me.data?.user.role === 'editor' || me.data?.user.role === 'admin'

  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 px-3"><h2 className="text-xs font-semibold text-muted-foreground">노트 연결</h2></div>
    <div className="min-h-0 flex-1 space-y-2 overflow-auto overscroll-contain px-2 pb-2">
    {!notePath ? <EmptyState title="노트를 먼저 열어 주세요" description="현재 노트의 링크와 의미상 유사한 노트를 확인합니다." /> : <>
      <p className="break-all text-xs text-muted-foreground">{notePath}</p>
      <section aria-label="명시적 노트 링크" className="space-y-2">
        {links.isPending && <Loading label="노트 링크를 불러오는 중" />}
        {links.isError && <div className="space-y-2"><ErrorNotice error={links.error} /><Button variant="outline" size="sm" disabled={links.isFetching} onClick={() => void links.refetch()}>링크 다시 시도</Button></div>}
        {links.data && <>
          <section className="space-y-2"><h3 className="text-sm font-semibold">역링크 <span className="text-muted-foreground">{links.data.backlinks.length}</span></h3>
            {links.data.backlinks.length ? <KnowledgeNoteList notes={links.data.backlinks} /> : <EmptyState title="이 노트를 참조하는 노트가 없습니다" />}
          </section>
          <section className="space-y-2"><h3 className="text-sm font-semibold">나가는 링크 <span className="text-muted-foreground">{links.data.outgoing.length}</span></h3>
            {links.data.outgoing.length ? <KnowledgeNoteList notes={links.data.outgoing} /> : <EmptyState title="다른 노트로 연결된 링크가 없습니다" />}
          </section>
          <section className="space-y-2"><h3 className="text-sm font-semibold">미해결 링크 <span className="text-muted-foreground">{links.data.unresolved.length}</span></h3>
          {links.data.unresolved.length ? <ul className="divide-y overflow-hidden border-y">{links.data.unresolved.map(name => {
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
            })}</ul> : <EmptyState title="모든 노트 링크가 연결되어 있습니다" />}
          </section>
        </>}
      </section>
      <section aria-label="의미상 유사" className="space-y-2 border-t pt-3">
        <h3 className="text-sm font-semibold">의미상 유사</h3>
        <p className="text-xs text-muted-foreground">명시적 링크와 별개로, 노트 내용의 의미를 비교한 결과입니다.</p>
        {similar.isPending && <Loading label="유사한 노트를 불러오는 중" />}
        {similar.isError && <div className="space-y-2"><ErrorNotice error={similar.error} /><Button variant="outline" size="sm" disabled={similar.isFetching} onClick={() => void similar.refetch()}>유사 노트 다시 시도</Button></div>}
        {similar.data && (similar.data.length ? <KnowledgeNoteList notes={similar.data} /> : <EmptyState title="의미상 유사한 노트가 없습니다" description="임베딩이 준비되지 않은 경우에도 결과가 없을 수 있습니다." />)}
      </section>
    </>}
    </div>
  </div>
}
