'use client'

import { Check, ChevronRight, Circle, FileText, LoaderCircle } from 'lucide-react'
import Link from 'next/link'

export type WorkStep = {
  kind: 'status' | 'tool' | 'citation'
  label: string
  path?: string
  jobId?: string
  status: 'active' | 'done'
}

export function WorkSteps({ steps, running, noteCount }: { steps: WorkStep[]; running: boolean; noteCount: number }) {
  if (!running && steps.length === 0) {
    return noteCount > 0 ? <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><FileText aria-hidden="true" className="size-3"/>노트 {noteCount}개 참고</p> : null
  }

  return <details open={running} className="group/steps min-w-0 rounded-lg border border-border/70 bg-muted/20 text-xs">
    <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-2.5 py-2 text-muted-foreground hover:text-foreground focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
      {running ? <LoaderCircle aria-hidden="true" className="size-3.5 shrink-0 motion-safe:animate-spin"/> : steps.every(step => step.status === 'done') ? <Check aria-hidden="true" className="size-3.5 shrink-0 text-success"/> : <FileText aria-hidden="true" className="size-3.5 shrink-0"/>}
      <span className="min-w-0 flex-1 break-words" role={running ? 'status' : undefined}>{running && '작업 중 · '}{steps.length}단계 · 노트 {noteCount}개 참고</span>
      <ChevronRight aria-hidden="true" className="size-3 shrink-0 transition-transform group-open/steps:rotate-90"/>
    </summary>
    <ol aria-label="도니 작업 단계" className="mx-3 mb-2.5 space-y-2 border-l border-border pl-3">
      {steps.map((step, index) => <li key={index} className="relative flex min-w-0 items-start gap-2">
        <span className="mt-0.5 shrink-0" title={step.status === 'done' ? '완료' : running ? '진행 중' : '미완료'}>
          {step.status === 'done' ? <Check aria-hidden="true" className="size-3 text-success"/> : running ? <LoaderCircle aria-hidden="true" className="size-3 text-primary motion-safe:animate-spin"/> : <Circle aria-hidden="true" className="size-3 text-muted-foreground"/>}
        </span>
        <span className="min-w-0 break-words leading-relaxed"><span className={step.status === 'active' && running ? 'text-foreground' : 'text-muted-foreground'}>{step.label}</span>{step.jobId && <Link href={`/jobs/${encodeURIComponent(step.jobId)}`} className="ml-2 text-[11px] underline underline-offset-4">작업 보기</Link>}{step.path && <span className="block break-all text-[11px] text-muted-foreground">{step.path}</span>}</span>
      </li>)}
      {steps.length === 0 && <li className="text-muted-foreground">답변을 준비하고 있습니다.</li>}
    </ol>
  </details>
}
