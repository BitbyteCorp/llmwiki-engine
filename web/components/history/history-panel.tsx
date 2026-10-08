'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { History, ListTodo, Moon, NotebookPen } from 'lucide-react'
import { activityApi, api } from '@/lib/api'
import { useWorkspace } from '@/components/workspace/context'
import { isViewTab } from '@/components/workspace/layout'
import { ErrorNotice, Loading } from '@/components/common'
import { Button } from '@/components/ui/button'
import { BackupBadge } from './backup-badge'
import { CommitByline, commitHref, historyHref } from './commit-meta'

export function HistoryPanel() {
  const { activePath, openHref } = useWorkspace()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const notePath = (pathname === '/history' ? searchParams.get('path') : null) || (isViewTab(activePath) ? '' : activePath)
  const note = useQuery({ queryKey: ['notes/content', notePath], queryFn: () => api.note(notePath), enabled: Boolean(notePath), retry: false })
  const noteTitle = typeof note.data?.frontmatter.title === 'string' && note.data.frontmatter.title.trim()
    ? note.data.frontmatter.title.trim() : notePath.split('/').pop()?.replace(/\.md$/i, '') || '노트'
  const history = useQuery({ queryKey: ['history', 'panel', notePath, 'follow'], queryFn: ({ signal }) => activityApi.noteHistory(notePath, signal), enabled: Boolean(notePath) })
  return <div className="min-w-0 space-y-3 p-2">
    <section className="space-y-3" aria-labelledby="history-panel-title"><h2 id="history-panel-title" className="text-sm font-semibold">이력</h2>
      <nav aria-label="이력 탐색" className="space-y-1">
        <Link className="explorer-row" href="/history" onNavigate={event => { event.preventDefault(); openHref('/history') }}><History className="size-4 shrink-0" />전체 활동</Link>
        <Link className="explorer-row" href="/jobs" onNavigate={event => { event.preventDefault(); openHref('/jobs') }}><ListTodo className="size-4 shrink-0" />쓰기 작업</Link>
        <Link className="explorer-row" href="/dreams" onNavigate={event => { event.preventDefault(); openHref('/dreams') }}><Moon className="size-4 shrink-0" />꿈꾸기 기록</Link>
        <Link className="explorer-row" href="/journal" onNavigate={event => { event.preventDefault(); openHref('/journal') }}><NotebookPen className="size-4 shrink-0" />일기</Link>
      </nav>
    </section>
    <section className="space-y-3 border-t pt-3" aria-labelledby="note-history-panel-title"><h3 id="note-history-panel-title" className="break-words text-sm font-semibold">{notePath ? `${noteTitle} · 최근 변경` : '노트 · 최근 변경'}</h3>
      {notePath ? <>
        <p className="text-xs text-muted-foreground">이름 변경 전 이력도 이어서 표시합니다.</p>
        {history.isPending && <Loading label="노트 이력 확인 중…" />}
        {history.isError && <><ErrorNotice error={history.error} /><Button size="sm" variant="outline" onClick={() => void history.refetch()}>다시 시도</Button></>}
        {!history.isPending && !history.isError && !history.data?.commits.length && <p className="text-xs text-muted-foreground">기록된 변경이 없습니다.</p>}
        {history.data && <ol className="divide-y border-y">{history.data.commits.map(commit => <li key={commit.sha}><Link className="block min-w-0 space-y-1 px-2 py-1.5 text-label-13 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" href={commitHref(commit.sha)} onNavigate={event => { event.preventDefault(); openHref(commitHref(commit.sha)) }}><span className="line-clamp-2 break-words font-medium" title={commit.subject || '제목 없는 변경'}>{commit.subject || '제목 없는 변경'}</span><CommitByline commit={commit} /></Link></li>)}</ol>}
      </> : <p className="text-xs text-muted-foreground">노트를 열면 최근 변경 이력이 표시됩니다.</p>}
      <footer className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">{notePath && <Link className="hover:underline" href={historyHref(notePath)} onNavigate={event => { event.preventDefault(); openHref(historyHref(notePath)) }}>전체 이력</Link>}<Link className="hover:underline" href="/history" onNavigate={event => { event.preventDefault(); openHref('/history') }}>전체 활동</Link></footer>
    </section>
    <section className="space-y-3 border-t pt-3" aria-label="백업 상태"><h3 className="text-sm font-semibold">원격 백업</h3><BackupBadge /></section>
  </div>
}
