'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { api, jobsApi, type WriteJob } from '@/lib/api'
import { EmptyState, ErrorNotice, Loading, PageHeader, formatDate, noteHref } from '@/components/common'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { JobProgress } from '@/components/history/job-progress'

const statusLabels: Record<WriteJob['status'], string> = { queued: '대기 중', running: '처리 중', merging: '병합 중', succeeded: '완료', failed: '실패' }
const kindLabels: Record<WriteJob['kind'], string> = { agent: '도니 작업', direct: '직접 편집', revert: '변경 되돌리기' }
const sourceLabels: Record<WriteJob['source'], string> = { mcp: 'MCP', web: '웹', chat: '대화', dreaming: '꿈꾸기', import: '가져오기', revert: '되돌리기' }

function JobStatus({ job }: { job: WriteJob }) {
  return <Badge variant="outline" className={job.status === 'failed' ? 'border-destructive/30 bg-destructive/5 text-destructive' : job.status === 'succeeded' ? 'border-success/30 bg-success/10 text-success' : 'text-muted-foreground'}>{job.error === 'canceled' ? '취소됨' : statusLabels[job.status]}</Badge>
}
function jobsHref(status?: string, before?: string) {
  const params = new URLSearchParams({ mine: '1' })
  if (status) params.set('status', status)
  if (before) params.set('before', before)
  return `/jobs?${params}`
}

export function JobsPage() {
  const params = useSearchParams()
  const router = useRouter()
  const rawStatus = params.get('status')
  const status = rawStatus && Object.hasOwn(statusLabels, rawStatus) ? rawStatus as WriteJob['status'] : undefined
  const before = params.get('before') || undefined
  const jobs = useQuery({ queryKey: ['jobs', 'mine', status, before], queryFn: ({ signal }) => jobsApi.list({ status, before }, signal) })
  return <div className="min-w-0 space-y-6">
    <PageHeader title="내 쓰기 작업" description="내가 요청한 작업의 진행 상태와 변경 결과를 확인합니다." actions={<Button variant="outline" nativeButton={false} render={<Link href="/history" />}>전체 활동</Button>} />
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4">
      <label className="flex items-center gap-2 text-sm">상태<NativeSelect size="sm" value={status ?? ''} onChange={event => router.push(jobsHref(event.target.value))} aria-label="작업 상태 필터"><NativeSelectOption value="">전체 상태</NativeSelectOption>{Object.entries(statusLabels).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}</NativeSelect></label>
      <Button variant="ghost" disabled={jobs.isFetching} onClick={() => void jobs.refetch()}>새로고침</Button>
    </div>
    {jobs.isPending && <Loading label="내 작업을 불러오는 중…" />}
    {jobs.error && <div className="space-y-2"><ErrorNotice error={jobs.error} /><Button variant="outline" onClick={() => void jobs.refetch()}>다시 시도</Button></div>}
    {jobs.data && jobs.data.jobs.length === 0 && <EmptyState title={status ? '이 상태의 작업이 없습니다' : before ? '더 오래된 작업이 없습니다' : '아직 요청한 작업이 없습니다'} description="상태 필터를 바꾸거나 새 쓰기 작업을 요청한 뒤 확인해 주세요." />}
    {jobs.data && jobs.data.jobs.length > 0 && <ul className="divide-y rounded-lg border bg-card" aria-label="내 쓰기 작업 목록">
      {jobs.data.jobs.map(job => <li key={job.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:justify-between">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2"><JobStatus job={job} /><Badge variant="secondary">{kindLabels[job.kind]}</Badge><span className="text-xs text-muted-foreground">{sourceLabels[job.source]}</span></div>
          <Link className="line-clamp-2 break-words text-sm font-medium hover:underline" title={job.summary || job.input || '쓰기 작업 상세 보기'} href={`/jobs/${encodeURIComponent(job.id)}`}>{job.summary || job.input || '쓰기 작업 상세 보기'}</Link>
          <p className="break-words text-xs text-muted-foreground">요청자 {job.user.name ? `${job.user.name} · ` : ''}{job.user.email}{job.client ? ` · 클라이언트 ${job.client}` : ''}</p>
          <Link className="break-all font-mono text-xs text-muted-foreground hover:underline" href={`/jobs/${encodeURIComponent(job.id)}`}>{job.id}</Link>
        </div>
        <time className="shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground" dateTime={job.createdAt} title={formatDate(job.createdAt)}>{formatDate(job.createdAt)}</time>
      </li>)}
    </ul>}
    <nav aria-label="작업 목록 페이지" className="flex flex-wrap gap-2">
      {before && <Button variant="outline" nativeButton={false} render={<Link href={jobsHref(status)} />}>최신 작업</Button>}
      {jobs.data?.nextCursor && <Button variant="outline" nativeButton={false} render={<Link href={jobsHref(status, jobs.data.nextCursor)} />}>이전 작업 보기</Button>}
    </nav>
  </div>
}

export function JobPage() {
  const params = useParams<{ id: string }>()
  const id = decodeURIComponent(params.id)
  return <JobDetailPage key={id} id={id} />
}

function JobDetailPage({ id }: { id: string }) {
  const router = useRouter()
  const client = useQueryClient()
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  const detail = useQuery({ queryKey: ['job', id], queryFn: ({ signal }) => jobsApi.detail(id, signal) })
  const [confirmCancel, setConfirmCancel] = useState(false)
  const action = useMutation({
    mutationFn: (kind: 'retry' | 'cancel') => kind === 'retry' ? jobsApi.retry(id) : jobsApi.cancel(id),
    onSuccess: (result, kind) => {
      setConfirmCancel(false)
      void client.invalidateQueries({ queryKey: ['jobs'] })
      void client.invalidateQueries({ queryKey: ['job', id] })
      if (kind === 'retry') router.push(`/jobs/${encodeURIComponent(result.job.id)}`)
    },
  })
  if (detail.isPending) return <Loading label="쓰기 작업을 불러오는 중…" />
  if (!detail.data) return <div className="min-w-0 space-y-6"><PageHeader title="쓰기 작업" /><ErrorNotice error={detail.error} /><Button variant="outline" onClick={() => void detail.refetch()}>다시 시도</Button><Button variant="ghost" nativeButton={false} render={<Link href={jobsHref()} />}>내 작업 목록</Button></div>
  const { job, user, commits, events } = detail.data
  const currentUser = me.data?.user
  const canAct = currentUser && currentUser.role !== 'viewer' && (currentUser.role === 'admin' || currentUser.id === job.userId)
  const duration = job.startedAt && job.finishedAt ? Math.max(0, Math.round((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000)) : null
  return <div className="min-w-0 space-y-6">
    <PageHeader title="쓰기 작업" description={<span className="break-all font-mono text-xs">{job.id}</span>} actions={<>
      <Button variant="outline" nativeButton={false} render={<Link href={jobsHref()} />}>내 작업 목록</Button>
      <Button variant="ghost" disabled={detail.isFetching} onClick={() => void detail.refetch()}>새로고침</Button>
      {canAct && job.status === 'failed' && <Button disabled={action.isPending} onClick={() => action.mutate('retry')}>{action.isPending ? '요청 중…' : '새 작업으로 재시도'}</Button>}
      {canAct && job.status === 'queued' && <Button variant="destructive" disabled={action.isPending} onClick={() => { action.reset(); setConfirmCancel(true) }}>대기 작업 취소</Button>}
    </>} />
    <ErrorNotice error={detail.error || action.error} />
    {me.error && <div className="space-y-2"><ErrorNotice error={me.error} /><Button variant="outline" onClick={() => void me.refetch()}>권한 확인 다시 시도</Button></div>}
    {confirmCancel && job.status === 'queued' && <section aria-label="작업 취소 확인" className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4"><p className="text-sm">대기 중인 이 작업을 취소할까요? 이미 실행된 작업은 취소할 수 없습니다.</p><div className="flex gap-2"><Button variant="destructive" disabled={action.isPending} onClick={() => action.mutate('cancel')}>취소 확인</Button><Button variant="outline" disabled={action.isPending} onClick={() => setConfirmCancel(false)}>돌아가기</Button></div></section>}
    <div className="flex flex-wrap items-center gap-2"><JobStatus job={job} /><Badge variant="secondary">{kindLabels[job.kind]}</Badge><Badge variant="outline">{sourceLabels[job.source]}</Badge>{job.client && <span className="break-all text-xs text-muted-foreground">클라이언트 · {job.client}</span>}</div>
    <dl className="grid gap-3 rounded-lg border bg-card p-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
      <div className="min-w-0"><dt className="text-muted-foreground">요청자</dt><dd className="mt-1 break-words">{user.name && <span className="block">{user.name}</span>}{user.email}</dd></div>
      <div className="min-w-0"><dt className="text-muted-foreground">요청 시각</dt><dd className="mt-1 whitespace-nowrap text-right tabular-nums"><time dateTime={job.createdAt} title={formatDate(job.createdAt)}>{formatDate(job.createdAt)}</time></dd></div>
      <div className="min-w-0"><dt className="text-muted-foreground">시작 시각</dt><dd className="mt-1 whitespace-nowrap text-right tabular-nums">{formatDate(job.startedAt)}</dd></div>
      <div className="min-w-0"><dt className="text-muted-foreground">완료 시각</dt><dd className="mt-1 whitespace-nowrap text-right tabular-nums">{formatDate(job.finishedAt)}{duration !== null && <span className="block text-xs text-muted-foreground">실행 시간 {duration.toLocaleString('ko-KR')}초</span>}</dd></div>
    </dl>
    <JobProgress job={job} events={events} />
    {job.conflicts.length > 0 && <section className="space-y-3" aria-labelledby="job-conflicts-title"><h2 id="job-conflicts-title" className="text-sm font-semibold">충돌 경로</h2><p className="text-sm text-muted-foreground">충돌 해결의 경로와 시각은 단계 이벤트에 기록됩니다. 작업 완료 여부는 최종 상태를 확인하세요.</p><ul className="space-y-2 rounded-lg border bg-card p-4">{job.conflicts.map(path => <li key={path}><Link className="break-all font-mono text-sm underline underline-offset-2" href={noteHref(path)}>{path}</Link></li>)}</ul></section>}
    {job.summary && <section className="space-y-3" aria-labelledby="job-summary-title"><h2 id="job-summary-title" className="text-sm font-semibold">결과 요약</h2><p className="whitespace-pre-wrap break-words rounded-lg border bg-card p-4 text-sm leading-6">{job.summary}</p></section>}
    {job.error && <section className="space-y-3" aria-labelledby="job-error-title"><h2 id="job-error-title" className="text-sm font-semibold">{job.error === 'canceled' ? '취소 사유' : '작업 오류'}</h2><ErrorNotice error={job.error === 'canceled' ? '실행 전 대기 중인 작업을 취소했습니다.' : job.error} /></section>}
    <section className="space-y-3" aria-labelledby="job-commits-title"><h2 id="job-commits-title" className="text-sm font-semibold">관련 커밋</h2>
      {job.mergeSha && <p className="break-all text-xs text-muted-foreground">main 반영 SHA · <Link className="font-mono underline" href={`/history/commits/${encodeURIComponent(job.mergeSha)}`}>{job.mergeSha}</Link></p>}
      {commits.length === 0 ? <EmptyState title="관련 커밋이 없습니다" description="커밋이 만들어지면 이 작업의 변경 내용을 확인할 수 있습니다." /> : <ul className="divide-y rounded-lg border bg-card">{commits.map(commit => <li key={commit.sha} className="space-y-2 p-4"><Link className="line-clamp-2 break-words text-sm font-medium hover:underline" title={commit.subject || '제목 없는 커밋'} href={`/history/commits/${encodeURIComponent(commit.sha)}`}>{commit.subject || '제목 없는 커밋'}</Link><div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground"><span className="min-w-0 break-words">{commit.authorName}</span><time className="shrink-0 whitespace-nowrap text-right tabular-nums" dateTime={commit.date} title={formatDate(commit.date)}>{formatDate(commit.date)}</time></div><Link className="font-mono text-xs text-muted-foreground hover:underline" href={`/history/commits/${encodeURIComponent(commit.sha)}`}>{commit.sha.slice(0, 12)}</Link></li>)}</ul>}
    </section>
    <details className="rounded-lg border bg-card"><summary className="cursor-pointer p-4 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-ring">요청 입력</summary><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words border-t p-4 font-mono text-xs">{job.input}</pre></details>
  </div>
}
