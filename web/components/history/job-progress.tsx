'use client'

import { Check, Circle, LoaderCircle, X } from 'lucide-react'
import { type JobEvent, type WriteJob } from '@/lib/api'
import { formatDate, noteHref } from '@/components/common'
import Link from 'next/link'

export const jobPhaseLabels: Record<JobEvent['phase'], string> = {
  queued: '대기', preparing: '준비', editing: '편집', committing: '커밋', merging: '병합',
  resolving_conflict: '충돌 해결', indexing: '색인', cleanup: '정리', done: '완료', failed: '실패',
}
const phases: JobEvent['phase'][] = ['queued', 'preparing', 'editing', 'committing', 'merging', 'resolving_conflict', 'indexing', 'cleanup']

export function JobProgress({ job, events }: { job: WriteJob; events: JobEvent[] }) {
  const terminal = job.status === 'failed' || job.status === 'succeeded'
  const last = events.at(-1)?.phase
  const active = last ?? (job.status === 'queued' ? 'queued' : job.status === 'merging' ? 'merging' : null)
  const steps = [...phases, job.status === 'failed' ? 'failed' : 'done'] as JobEvent['phase'][]
  return <section className="space-y-4" aria-labelledby="job-progress-title">
    <h2 id="job-progress-title" className="text-base font-semibold">작업 진행</h2>
    <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{job.error === 'canceled' ? '대기 중인 작업을 취소했습니다.' : active ? `현재 단계: ${jobPhaseLabels[active]}` : '단계 기록이 없는 작업입니다.'}</p>
    <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-9" aria-label="작업 단계">
      {steps.map(phase => {
        const recorded = events.some(event => event.phase === phase)
        const current = active === phase
        const Icon = phase === 'failed' && current ? X : current && !terminal ? LoaderCircle : recorded ? Check : Circle
        return <li key={phase} aria-current={current ? 'step' : undefined} className={`flex items-center gap-2 rounded-lg border p-3 text-xs ${current ? 'border-primary bg-primary/5 text-foreground' : recorded ? 'bg-muted/40' : 'text-muted-foreground'}`}>
          <Icon aria-hidden="true" className={`size-4 shrink-0 ${current && !terminal ? 'animate-spin motion-reduce:animate-none' : ''}`} />
          <span>{jobPhaseLabels[phase]}{phase === 'resolving_conflict' && !recorded && <span className="block text-[10px]">해당 시</span>}<span className="sr-only">{current ? ' · 현재 단계' : recorded ? ' · 기록 있음' : ' · 기록 없음'}</span></span>
        </li>
      })}
    </ol>
    <details className="rounded-lg border" open={job.conflicts.length > 0 || job.status === 'failed'}>
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">단계 이벤트 · {events.length}건</summary>
      {events.length === 0 ? <p className="px-4 pb-4 text-sm text-muted-foreground">이 작업에는 저장된 단계 이벤트가 없습니다.</p> : <ol className="divide-y border-t">
        {events.map((event, index) => <li key={`${event.at}-${index}`} className="space-y-2 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><span className="font-medium">{jobPhaseLabels[event.phase]}</span><time className="text-xs text-muted-foreground" dateTime={event.at}>{formatDate(event.at)}</time></div>
          {event.detail && <EventDetail detail={event.detail} />}
        </li>)}
      </ol>}
    </details>
  </section>
}

function EventDetail({ detail }: { detail: Record<string, unknown> }) {
  const files = Array.isArray(detail.files) ? detail.files.filter((path): path is string => typeof path === 'string') : []
  const rest = Object.fromEntries(Object.entries(detail).filter(([key]) => key !== 'files' && key !== 'retryOf' && key !== 'reason' && key !== 'error'))
  return <div className="space-y-2 text-xs text-muted-foreground">
    {files.length > 0 && <ul className="space-y-1" aria-label="충돌 경로">{files.map(path => <li key={path}><Link className="break-all font-mono underline underline-offset-2" href={noteHref(path)}>{path}</Link></li>)}</ul>}
    {typeof detail.retryOf === 'string' && <p>재시도 원본: <Link className="break-all font-mono underline" href={`/jobs/${encodeURIComponent(detail.retryOf)}`}>{detail.retryOf}</Link></p>}
    {typeof detail.reason === 'string' && <p>사유: {detail.reason === 'canceled' ? '사용자가 대기 작업을 취소함' : detail.reason === 'interrupted' ? '서버 재시작으로 작업 중단' : detail.reason}</p>}
    {typeof detail.error === 'string' && <p className="whitespace-pre-wrap break-words text-destructive">{detail.error}</p>}
    {Object.keys(rest).length > 0 && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">{JSON.stringify(rest, null, 2)}</pre>}
  </div>
}
