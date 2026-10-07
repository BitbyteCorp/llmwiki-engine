'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { Activity, Database, FileInput, RefreshCw, Settings, Sparkles, UploadCloud } from 'lucide-react'
import { api, opsApi } from '@/lib/api'
import { ErrorNotice, Loading, formatDate } from '@/components/common'
import { Button } from '@/components/ui/button'
import { ImportDialog } from './import-dialog'
import { useOpsActions } from './ops-actions'

const dreamLabels = { running: '실행 중', succeeded: '완료', failed: '실패' }
const pushLabels = { pending: '대기', succeeded: '성공', skipped: '건너뜀', failed: '실패' }

export function OpsPanel({ userId }: { userId: number }) {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false })
  const admin = me.data?.user.id === userId && me.data.user.role === 'admin'
  const ops = useQuery({ queryKey: ['ops'], queryFn: ({ signal }) => opsApi.status(signal), enabled: admin })
  const [importing, setImporting] = useState(false)
  const actions = useOpsActions(() => setImporting(true))
  const data = ops.data

  if (me.isPending) return <div className="p-4"><Loading label="운영 권한 확인 중…" /></div>
  if (me.error) return <div className="p-4"><ErrorNotice error={me.error} /></div>
  if (!admin) return <div className="p-4 text-sm text-muted-foreground">관리자만 운영 도구를 사용할 수 있습니다.</div>

  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 px-3"><h2 className="text-xs font-semibold text-muted-foreground">운영</h2><Button variant="ghost" size="icon-sm" disabled={ops.isFetching} onClick={() => void ops.refetch()} aria-label="운영 상태 새로고침"><RefreshCw className="size-4" /></Button></div>
    <div className="min-h-0 flex-1 space-y-3 overflow-auto px-2 pb-2">
    {ops.isPending && <Loading label="운영 상태 확인 중…" />}
    {ops.error && <div className="space-y-3"><ErrorNotice error={ops.error} /><Button variant="outline" size="sm" onClick={() => void ops.refetch()}>다시 시도</Button></div>}
    {data && <>
      <section aria-label="쓰기 작업 큐" className="space-y-3 rounded-lg border bg-card p-4">
        <h3 className="flex items-center gap-2 text-xs font-semibold"><Activity className="size-4" />작업 큐</h3>
        <dl className="grid grid-cols-2 gap-3 text-xs"><div><dt className="text-muted-foreground">대기</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{data.queue.queued}</dd></div><div><dt className="text-muted-foreground">실행·병합 중</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{data.queue.running}</dd></div></dl>
        <Link href="/jobs" className="text-xs underline underline-offset-4">전체 작업 보기</Link>
      </section>
      <section aria-label="검색 색인" className="space-y-3 rounded-lg border bg-card p-4">
        <h3 className="flex items-center gap-2 text-xs font-semibold"><Database className="size-4" />검색 색인</h3>
        <p className={`text-xs ${data.index.lastError ? 'text-destructive' : 'text-muted-foreground'}`}>{data.index.syncing ? '동기화 중' : data.index.lastError ? '색인 오류' : data.index.indexedSha === data.index.headSha ? 'main과 동기화됨' : 'main 변경 반영 대기'}</p>
        <dl className="flex justify-between gap-3 text-xs"><dt className="text-muted-foreground">임베딩 대기</dt><dd className="tabular-nums">{data.index.pendingVectors.toLocaleString('ko-KR')}개</dd></dl>
      </section>
      <section aria-label="꿈꾸기 상태" className="space-y-3 rounded-lg border bg-card p-4">
        <h3 className="flex items-center gap-2 text-xs font-semibold"><Sparkles className="size-4" />꿈꾸기</h3>
        {data.dreams.running && <Link href={`/dreams/${encodeURIComponent(data.dreams.running.id)}`} className="block text-xs underline underline-offset-4">현재 실행 중 · {formatDate(data.dreams.running.startedAt)}</Link>}
        {data.dreams.last ? <Link href={`/dreams/${encodeURIComponent(data.dreams.last.id)}`} className={`block text-xs underline underline-offset-4 ${data.dreams.last.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>최근 {dreamLabels[data.dreams.last.status]} · {formatDate(data.dreams.last.finishedAt ?? data.dreams.last.startedAt)}</Link> : <p className="text-xs text-muted-foreground">실행 기록 없음</p>}
      </section>
      <section aria-label="원격 git push" className="space-y-3 rounded-lg border bg-card p-4">
        <h3 className="flex items-center gap-2 text-xs font-semibold"><UploadCloud className="size-4" />원격 git push</h3>
        {data.backup.lastAttempt ? <Link href={`/dreams/${encodeURIComponent(data.backup.lastAttempt.id)}`} className={`block text-xs underline underline-offset-4 ${data.backup.lastAttempt.push.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>최근 {pushLabels[data.backup.lastAttempt.push.status]} · {formatDate(data.backup.lastAttempt.push.at ?? data.backup.lastAttempt.startedAt)}</Link> : <p className="text-xs text-muted-foreground">push 기록 없음</p>}
        <p className="text-xs text-muted-foreground">최근 성공 {formatDate(data.backup.lastSuccess?.push.at ?? null)}</p>
        <p className="text-xs leading-5 text-muted-foreground">SQLite·업로드를 포함하는 전체 백업 상태가 아닙니다.</p>
      </section>
    </>}
    <section aria-label="빠른 실행" className="space-y-3 rounded-lg border bg-card p-4">
      <h3 className="text-xs font-semibold">빠른 실행</h3>
      <div className="flex flex-col gap-3">
        <Button size="sm" className="justify-start" disabled={actions.busy || !data || Boolean(data.dreams.running)} onClick={() => actions.request({ kind: 'dream' })}><Sparkles className="size-4" />{data?.dreams.running ? '꿈꾸기 실행 중' : '꿈꾸기 지금 실행'}</Button>
        <Button size="sm" variant="outline" className="justify-start" disabled={actions.busy || !data || data.index.syncing} onClick={() => actions.request({ kind: 'incremental' })}><RefreshCw className="size-4" />색인 갱신</Button>
        <Button size="sm" variant="outline" className="justify-start" disabled={actions.busy || !data || data.index.syncing} onClick={() => actions.request({ kind: 'full' })}><Database className="size-4" />전체 색인 재구축</Button>
        <Button size="sm" variant="outline" className="justify-start" disabled={actions.busy} onClick={() => actions.request({ kind: 'import' })}><FileInput className="size-4" />원문 가져오기</Button>
      </div>
    </section>
    <Link className="explorer-row" href="/settings?tab=ops"><Settings className="size-4 shrink-0" />전체 운영 설정</Link>
    {importing && <ImportDialog onClose={() => setImporting(false)} onFailure={actions.importFailed} onCreated={result => { setImporting(false); actions.importCreated(result) }} />}
    </div>
  </div>
}
