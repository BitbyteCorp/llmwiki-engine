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
  return <section className="space-y-3" aria-labelledby="job-progress-title">
    <h2 id="job-progress-title" className="flex h-7 items-center border-b text-label-13 font-semibold">작업 진행</h2>
    <p role="status" aria-live="polite" className="text-label-13 text-muted-foreground">{job.error === 'canceled' ? '대기 중인 작업을 취소했습니다.' : active ? `현재 단계: ${jobPhaseLabels[active]}` : '단계 기록이 없는 작업입니다.'}</p>
    <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-9" aria-label="작업 단계">
      {steps.map(phase => {
        const recorded = events.some(event => event.phase === phase)
        const current = active === phase
        const Icon = phase === 'failed' && current ? X : current && !terminal ? LoaderCircle : recorded ? Check : Circle
        return <li key={phase} aria-current={current ? 'step' : undefined} className={`relative flex items-center gap-2 rounded-lg border px-2 py-1.5 text-label-13 ${current ? phase === 'failed' ? 'border-destructive/30 bg-destructive/5 text-destructive' : phase === 'done' ? 'border-success/30 bg-success/10 text-success' : 'border-primary bg-primary/5 text-foreground' : recorded ? 'bg-muted/40' : 'text-muted-foreground'}`}>
          <Icon aria-hidden="true" className={`size-4 shrink-0 ${current && !terminal ? 'animate-spin motion-reduce:animate-none' : ''}`} />
          <span>{jobPhaseLabels[phase]}{phase === 'resolving_conflict' && !recorded && <span className="block text-[10px]">해당 시</span>}<span className="sr-only">{current ? ' · 현재 단계' : recorded ? ' · 기록 있음' : ' · 기록 없음'}</span></span>
        </li>
      })}
    </ol>
    <details className="border-y" open={job.conflicts.length > 0 || job.status === 'failed'}>
      <summary className="cursor-pointer border-b px-2 py-1.5 text-label-13 font-semibold focus-visible:outline-2 focus-visible:outline-ring">단계 이벤트 · <span className="tabular-nums">{events.length}</span>건</summary>
      {events.length === 0 ? <p className="px-2 py-1.5 text-label-13 text-muted-foreground">이 작업에는 저장된 단계 이벤트가 없습니다.</p> : <ol className="divide-y">
        {events.map((event, index) => { const paths = eventPaths(event.detail); return <li key={`${event.at}-${index}`} className="space-y-2 px-2 py-1.5">
          <div className="flex items-start justify-between gap-2 text-label-13"><span className="min-w-0 font-medium">{jobPhaseLabels[event.phase]}{paths.length === 1 && <>: <PathRef path={paths[0]} /></>}{paths.length > 1 && <span className="font-normal text-muted-foreground">: 파일 {paths.length}개</span>}</span><time className="shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground" dateTime={event.at} title={formatDate(event.at)}>{formatDate(event.at)}</time></div>
          {paths.length > 1 && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer focus-visible:outline-2 focus-visible:outline-ring">목록 보기</summary><ul className="mt-1 space-y-1" aria-label="참조 경로">{paths.map(path => <li key={path}><PathRef path={path} /></li>)}</ul></details>}
          {event.detail && <EventDetail detail={event.detail} />}
        </li> })}
      </ol>}
    </details>
  </section>
}

const detailKeys: Record<string, true> = { files: true, retryOf: true, reason: true, error: true, sourcePath: true, sourcePaths: true }

function eventPaths(detail: Record<string, unknown> | null | undefined) {
  const paths = new Set<string>()
  if (typeof detail?.sourcePath === 'string') paths.add(detail.sourcePath)
  if (Array.isArray(detail?.sourcePaths)) for (const path of detail.sourcePaths) if (typeof path === 'string') paths.add(path)
  return [...paths]
}

function PathRef({ path }: { path: string }) {
  return /\.md$/i.test(path)
    ? <Link className="break-all font-mono text-xs font-normal underline underline-offset-2" href={noteHref(path)}>{path}</Link>
    : <span className="break-all font-mono text-xs font-normal">{path}</span>
}

function EventDetail({ detail }: { detail: Record<string, unknown> }) {
  const files = Array.isArray(detail.files) ? detail.files.filter((path): path is string => typeof path === 'string') : []
  const rest = Object.fromEntries(Object.entries(detail).filter(([key]) => !detailKeys[key]))
  if (!files.length && typeof detail.retryOf !== 'string' && typeof detail.reason !== 'string' && typeof detail.error !== 'string' && !Object.keys(rest).length) return null
  return <div className="space-y-2 text-xs text-muted-foreground">
    {files.length > 0 && <ul className="space-y-1" aria-label="충돌 경로">{files.map(path => <li key={path}><Link className="break-all font-mono underline underline-offset-2" href={noteHref(path)}>{path}</Link></li>)}</ul>}
    {typeof detail.retryOf === 'string' && <p>재시도 원본: <Link className="break-all font-mono underline" href={`/jobs/${encodeURIComponent(detail.retryOf)}`}>{detail.retryOf}</Link></p>}
    {typeof detail.reason === 'string' && <p>사유: {detail.reason === 'canceled' ? '사용자가 대기 작업을 취소함' : detail.reason === 'interrupted' ? '서버 재시작으로 작업 중단' : detail.reason}</p>}
    {typeof detail.error === 'string' && <p className="whitespace-pre-wrap break-words text-destructive">{detail.error}</p>}
    {Object.keys(rest).length > 0 && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2">{JSON.stringify(rest, null, 2)}</pre>}
  </div>
}
