'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { History, ListTodo, Moon, NotebookPen } from 'lucide-react'
import { activityApi } from '@/lib/api'
import { useWorkspace } from '@/components/workspace/context'
import { ErrorNotice, Loading, formatDate } from '@/components/common'
import { Button } from '@/components/ui/button'
import { BackupBadge } from './backup-badge'

export function HistoryPanel() {
  const { activePath } = useWorkspace()
  const history = useQuery({ queryKey: ['history', 'panel', activePath, 'follow'], queryFn: ({ signal }) => activityApi.noteHistory(activePath, signal), enabled: Boolean(activePath) })
  return <div className="min-w-0 space-y-3 p-3">
    <section className="space-y-3" aria-labelledby="history-panel-title"><h2 id="history-panel-title" className="text-sm font-semibold">이력</h2>
      <nav aria-label="이력 탐색" className="space-y-1">
        <Link className="explorer-row" href="/history"><History className="size-4 shrink-0" />전체 타임라인</Link>
        <Link className="explorer-row" href="/jobs"><ListTodo className="size-4 shrink-0" />쓰기 작업</Link>
        <Link className="explorer-row" href="/dreams"><Moon className="size-4 shrink-0" />꿈꾸기 기록</Link>
        <Link className="explorer-row" href="/journal"><NotebookPen className="size-4 shrink-0" />일기</Link>
      </nav>
    </section>
    <section className="space-y-3 border-t pt-3" aria-labelledby="note-history-panel-title"><h3 id="note-history-panel-title" className="text-sm font-semibold">현재 노트 · 최근 10개</h3>
      {activePath ? <>
        <Link className="block truncate text-xs text-muted-foreground hover:underline" title={`${activePath} 전체 이력`} href={`/history?path=${encodeURIComponent(activePath)}&follow=1`}>{activePath} 전체 이력</Link>
        <p className="text-xs text-muted-foreground">이름 변경 전 이력도 이어서 표시합니다.</p>
        {history.isPending && <Loading label="노트 이력 확인 중…" />}
        {history.isError && <><ErrorNotice error={history.error} /><Button size="sm" variant="outline" onClick={() => void history.refetch()}>다시 시도</Button></>}
        {!history.isPending && !history.isError && !history.data?.commits.length && <p className="text-xs text-muted-foreground">기록된 변경이 없습니다.</p>}
        {history.data && <ol className="space-y-1">{history.data.commits.map(commit => <li key={commit.sha}><Link className="block min-w-0 space-y-1 rounded-md p-2 text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" href={`/history/commits/${encodeURIComponent(commit.sha)}`}><span className="line-clamp-2 break-words font-medium" title={commit.subject || '제목 없는 커밋'}>{commit.subject || '제목 없는 커밋'}</span><span className="flex min-w-0 items-center justify-between gap-2 text-muted-foreground"><span className="truncate" title={commit.authorName}>{commit.authorName}</span><span className="shrink-0 font-mono">{commit.sha.slice(0, 8)}</span></span><time className="block truncate text-right tabular-nums text-muted-foreground" dateTime={commit.date} title={formatDate(commit.date)}>{formatDate(commit.date)}</time></Link></li>)}</ol>}
      </> : <p className="text-xs text-muted-foreground">노트를 열면 최근 변경 이력이 표시됩니다.</p>}
    </section>
    <section className="space-y-3 border-t pt-3" aria-label="백업 상태"><h3 className="text-sm font-semibold">원격 백업</h3><BackupBadge /></section>
  </div>
}
