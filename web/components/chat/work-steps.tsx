'use client'

import { Check, ChevronRight, Circle, FileText, LoaderCircle } from 'lucide-react'
import Link from 'next/link'
import type { ChatStreamEvent } from '@/lib/chat-stream'

export type WorkStep = {
  kind: 'status' | 'tool' | 'citation'
  label: string
  path?: string
  jobId?: string
  status: 'active' | 'done'
}

export function toolWorkStep(data: Extract<ChatStreamEvent, { event: 'tool' }>['data']): WorkStep {
  const trackingLabel = data.name === 'get_write_status' ? '기록 상태 확인' : data.name === 'wait_write' ? '기록 완료 대기' : undefined
  const label = data.name === 'write_knowledge' || trackingLabel
    ? `${trackingLabel ?? '지식 기록 요청'}${data.summary ? `: ${data.summary}` : ''}`
    : `${data.name === 'search' ? '위키 검색' : data.name === 'read_note' ? '노트 읽음' : '근거 확인'} ${data.path || data.summary || ''}`.trim()
  return {
    kind: 'tool',
    label,
    path: data.path,
    status: data.state === 'start' ? 'active' : 'done',
    ...(data.jobId && (trackingLabel || (data.name === 'write_knowledge' && data.state === 'end')) ? { jobId: data.jobId } : {}),
  }
}

export function WorkSteps({ steps, running, noteCount }: { steps: WorkStep[]; running: boolean; noteCount: number }) {
  if (!running && steps.length === 0) {
    return noteCount > 0 ? <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><FileText aria-hidden="true" className="size-3"/>노트 {noteCount}개 참고</p> : null
  }

  return <details open={running} className="group/steps min-w-0 border-y text-xs">
    <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
      {running ? <LoaderCircle aria-hidden="true" className="size-3.5 shrink-0 motion-safe:animate-spin"/> : steps.every(step => step.status === 'done') ? <Check aria-hidden="true" className="size-3.5 shrink-0 text-success"/> : <FileText aria-hidden="true" className="size-3.5 shrink-0"/>}
      <span className="min-w-0 flex-1 break-words" role={running ? 'status' : undefined}>{running && '작업 중 · '}{steps.length}단계 · 노트 {noteCount}개 참고</span>
      <ChevronRight aria-hidden="true" className="size-3 shrink-0 transition-transform group-open/steps:rotate-90"/>
    </summary>
    <ol aria-label="도니 작업 단계" className="mx-3 mb-2 space-y-1.5 border-l border-border pl-3">
      {steps.map((step, index) => <li key={index} className="relative flex min-w-0 items-start gap-2">
        <span className="mt-0.5 shrink-0" title={step.status === 'done' ? '완료' : running ? '진행 중' : '미완료'}>
          {step.status === 'done' ? <Check aria-hidden="true" className="size-3 text-success"/> : running ? <LoaderCircle aria-hidden="true" className="size-3 text-primary motion-safe:animate-spin"/> : <Circle aria-hidden="true" className="size-3 text-muted-foreground"/>}
        </span>
        <span className="min-w-0 break-words"><span className={step.status === 'active' && running ? 'text-foreground' : 'text-muted-foreground'}>{step.label}</span>{step.jobId && <Link href={`/jobs/${encodeURIComponent(step.jobId)}`} className="ml-2 text-xs underline underline-offset-4">작업 보기</Link>}{step.path && <span className="block break-all text-xs text-muted-foreground">{step.path}</span>}</span>
      </li>)}
      {steps.length === 0 && <li className="text-muted-foreground">답변을 준비하고 있습니다.</li>}
    </ol>
  </details>
}
