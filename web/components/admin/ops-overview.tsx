"use client"

import { type ReactNode } from "react"
import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { Activity, Database, RefreshCw, ShieldCheck, Sparkles, UploadCloud } from "lucide-react"
import { opsApi, type OpsJob, type OpsDreamRun } from "@/lib/api"
import { useLiveConnection } from "@/lib/events"
import { EmptyState, ErrorNotice, Loading, formatDate } from "@/components/common"
import { Button } from "@/components/ui/button"
import { useOpsActions } from "./ops-actions"

function Section({ title, icon, children, actions }: { title: string; icon: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return <section className="min-w-0 space-y-2"><div className="flex h-7 items-center justify-between gap-2 border-b"><h2 className="flex items-center gap-1.5 text-label-13 font-semibold">{icon}{title}</h2>{actions}</div>{children}</section>
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="break-words text-label-13">{children}</dd></div>
}
function Sha({ value }: { value: string | null }) { return <code className="break-all text-xs" title={value ?? undefined}>{value ?? "없음"}</code> }
export function queuedAge(value: string | null, now: number) {
  if (!value) return "대기 작업 없음"
  const seconds = Math.max(0, Math.floor((now - Date.parse(value)) / 1000))
  if (seconds < 60) return `${seconds}초`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}시간 ${Math.floor(seconds % 3600 / 60)}분`
  return `${Math.floor(seconds / 86400)}일 ${Math.floor(seconds % 86400 / 3600)}시간`
}
const jobLabels: Record<OpsJob["status"], string> = { queued: "대기", running: "실행 중", merging: "병합 중", succeeded: "완료", failed: "실패" }
const dreamLabels: Record<OpsDreamRun["status"], string> = { running: "실행 중", succeeded: "완료", failed: "실패" }
const pushLabels: Record<OpsDreamRun["push"]["status"], string> = { pending: "대기", succeeded: "성공", skipped: "건너뜀", failed: "실패" }

export function OpsOverview() {
  const connection = useLiveConnection()
  const ops = useQuery({ queryKey: ["ops"], queryFn: ({ signal }) => opsApi.status(signal) })
  const jobs = useQuery({ queryKey: ["ops", "active-jobs"], queryFn: ({ signal }) => opsApi.activeJobs(signal) })
  const ready = useQuery({ queryKey: ["ops-ready"], queryFn: ({ signal }) => opsApi.ready(signal), retry: false })
  const { busy, request: choose } = useOpsActions()
  function refresh() { void ops.refetch(); void jobs.refetch(); void ready.refetch() }
  const data = ops.data
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2"><p className="text-label-13 text-muted-foreground">{connection === "connected" ? "실시간 변경을 수신하고 있습니다." : "실시간 연결 대기 중 · 새로고침으로 최신 상태를 확인하세요."}</p><Button variant="outline" size="sm" onClick={refresh} disabled={ops.isFetching || jobs.isFetching || ready.isFetching}><RefreshCw className="size-4" />새로고침</Button></div>
    {ops.isPending && <Loading label="운영 상태를 불러오는 중…" />}
    {ops.error && <div className="space-y-3"><ErrorNotice error={ops.error} /><Button variant="outline" onClick={() => void ops.refetch()}>운영 상태 다시 시도</Button></div>}
    <Section title="서비스 준비 상태" icon={<ShieldCheck className="size-3.5" />}>
      {ready.isPending ? <Loading label="준비 상태를 확인하는 중…" /> : ready.error ? <div className="space-y-2"><p className="text-label-13 font-medium text-destructive">준비되지 않았거나 상태를 확인할 수 없습니다.</p><ErrorNotice error={ready.error} /><Button size="sm" variant="outline" onClick={() => void ready.refetch()}>준비 상태 다시 확인</Button></div> : ready.data && <><p role="status" className="text-label-13 font-medium text-primary">정상 · /readyz</p><dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-label-13 @2xl/settings-panel:grid-cols-2 @5xl/settings-panel:grid-cols-4"><Field label="초기 색인">{ready.data.initialIndex === "ready" ? "준비 완료" : ready.data.initialIndex}</Field>{(["database", "repository", "index"] as const).map(key => <Field key={key} label={{ database: "데이터베이스", repository: "저장소", index: "검색 색인" }[key]}>{ready.data.checks[key] ? "정상" : "오류"}</Field>)}</dl></>}
    </Section>
    {data && <>
      <Section title="쓰기 작업 큐" icon={<Activity className="size-3.5" />}>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-label-13 @2xl/settings-panel:grid-cols-2 @5xl/settings-panel:grid-cols-4"><Field label="대기"><span className="text-sm font-semibold tabular-nums">{data.queue.queued}</span></Field><Field label="실행·병합 중"><span className="text-sm font-semibold tabular-nums">{data.queue.running}</span></Field><Field label="가장 오래된 대기 시간">{queuedAge(data.queue.oldestQueuedAt, ops.dataUpdatedAt)}</Field><Field label="가장 오래된 대기 시작">{formatDate(data.queue.oldestQueuedAt)}</Field></dl>
        <p className="text-xs text-muted-foreground">대기 시간은 마지막 조회 시점 기준입니다. 취소는 대기 작업에만 적용됩니다.</p>
        {jobs.isPending && <Loading label="전체 작업 이력에서 실행·대기 작업을 확인하는 중…" />}
        {jobs.error && <div className="space-y-3"><ErrorNotice error={jobs.error} /><Button variant="outline" size="sm" onClick={() => void jobs.refetch()}>작업 목록 다시 시도</Button></div>}
        {jobs.data && (jobs.data.length === 0 ? <EmptyState title="실행 중이거나 대기 중인 작업이 없습니다" /> : <ul className="divide-y border-y">{jobs.data.map(job => <JobRow key={job.id} job={job} disabled={busy} onAction={() => choose({ kind: "cancel", job })} />)}</ul>)}
        <Link href="/jobs" className="text-label-13 underline underline-offset-4">전체 쓰기 작업 보기</Link>
      </Section>
      <Section title="최근 실패 작업" icon={<Activity className="size-3.5" />}>
        {data.failedJobs.length === 0 ? <EmptyState title="실패한 작업이 없습니다" /> : <><p className="text-xs text-muted-foreground">최근 실패 작업 최대 20개입니다. 상세 화면에서 원인과 변경 이력을 확인하세요.</p><ul className="divide-y border-y">{data.failedJobs.map(job => <JobRow key={job.id} job={job} disabled={busy} onAction={() => choose({ kind: "retry", job })} />)}</ul></>}
      </Section>
      <Section title="검색 색인" icon={<Database className="size-3.5" />} actions={<div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy || data.index.syncing} onClick={() => choose({ kind: "incremental" })}>증분 재색인</Button><Button size="sm" variant="outline" disabled={busy || data.index.syncing} onClick={() => choose({ kind: "full" })}>전체 재색인</Button></div>}>
        <p className="text-label-13 font-medium">{data.index.syncing ? "동기화 중" : data.index.lastError ? "색인 오류" : data.index.indexedSha === data.index.headSha ? "main과 동기화됨" : "main 변경 반영 대기"}</p>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-label-13 @2xl/settings-panel:grid-cols-2"><Field label="색인된 커밋"><Sha value={data.index.indexedSha} /></Field><Field label="main HEAD"><Sha value={data.index.headSha} /></Field><Field label="최근 동기화">{formatDate(data.index.lastSyncAt)}</Field><Field label="임베딩 대기 청크">{data.index.pendingVectors.toLocaleString("ko-KR")}</Field><Field label="임베딩 상태">{data.index.embedding.ready ? "준비 완료" : data.index.embedding.configured ? "준비 중 또는 오류" : "API 키 미설정 · 키워드 검색 사용"}</Field><Field label="임베딩 모델">{data.index.embedding.model} · {data.index.embedding.dimensions}차원</Field></dl>
        {data.index.lastError && <ErrorNotice error={data.index.lastError} />}
      </Section>
      <Section title="꿈꾸기" icon={<Sparkles className="size-3.5" />} actions={<Button size="sm" disabled={busy || Boolean(data.dreams.running)} onClick={() => choose({ kind: "dream" })}>{data.dreams.running ? "꿈꾸기 실행 중" : "수동 실행"}</Button>}>
        {data.dreams.running && <DreamSummary run={data.dreams.running} title="현재 실행" />}
        {data.dreams.last ? <DreamSummary run={data.dreams.last} title="최근 실행" /> : <EmptyState title="아직 꿈꾸기 실행 기록이 없습니다" description="수동 실행 또는 예약 실행이 끝나면 결과가 여기에 표시됩니다." />}
        <Link href="/dreams" className="text-label-13 underline underline-offset-4">꿈꾸기 기록 보기</Link>
      </Section>
      <Section title="원격 git push 백업" icon={<UploadCloud className="size-3.5" />}>
        <p className="text-xs leading-5 text-muted-foreground">꿈꾸기의 원격 push 결과입니다. SQLite·git bundle 로컬 백업 상태가 아닙니다.</p>
        {data.backup.lastAttempt ? <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-label-13 @2xl/settings-panel:grid-cols-2"><Field label="최근 시도">{formatDate(data.backup.lastAttempt.push.at ?? data.backup.lastAttempt.startedAt)}</Field><Field label="결과">{pushLabels[data.backup.lastAttempt.push.status]}</Field><Field label="원격 저장소">{data.backup.lastAttempt.push.remote ?? "설정 없음"}</Field><Field label="push 커밋"><Sha value={data.backup.lastAttempt.push.sha} /></Field>{data.backup.lastAttempt.push.reason && <Field label="결과 사유">{data.backup.lastAttempt.push.reason}</Field>}<Field label="최근 성공">{formatDate(data.backup.lastSuccess?.push.at ?? null)}</Field></dl> : <EmptyState title="원격 push 기록이 없습니다" description="꿈꾸기 실행 후 백업 결과를 확인할 수 있습니다." />}
      </Section>
    </>}
  </div>
}

function JobRow({ job, disabled, onAction }: { job: OpsJob; disabled: boolean; onAction: () => void }) {
  return <li className="flex flex-col gap-2 px-2 py-1.5 hover:bg-accent @2xl/settings-panel:flex-row @2xl/settings-panel:items-start @2xl/settings-panel:justify-between"><div className="min-w-0 space-y-0.5"><p className="flex flex-wrap gap-x-2 text-label-13"><span>{jobLabels[job.status]} · {job.source} · 사용자 #{job.userId}</span>{job.summary && <span className="break-words">{job.summary}</span>}</p><div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground"><Link className="break-all font-mono underline underline-offset-4" href={`/jobs/${encodeURIComponent(job.id)}`}>{job.id}</Link><span>{formatDate(job.finishedAt ?? job.startedAt ?? job.createdAt)}</span>{job.error && <details className="text-label-13"><summary className="cursor-pointer text-destructive">오류 상세</summary><p className="mt-1 whitespace-pre-wrap break-words text-destructive">{job.error}</p></details>}</div></div>{(job.status === "failed" || job.status === "queued") && <Button className="shrink-0 self-start" variant="outline" size="sm" disabled={disabled} onClick={onAction} aria-label={`작업 ${job.id} ${job.status === "failed" ? "재시도" : "취소"}`}>{job.status === "failed" ? "재시도" : "대기 취소"}</Button>}</li>
}
function DreamSummary({ run, title }: { run: OpsDreamRun; title: string }) {
  return <div className="space-y-2"><h3 className="flex h-7 items-center gap-1.5 border-b text-label-13 font-semibold">{title} · {dreamLabels[run.status]}</h3><div className="flex flex-wrap gap-x-2 text-xs text-muted-foreground"><Link href={`/dreams/${encodeURIComponent(run.id)}`} className="break-all font-mono underline underline-offset-4">{run.id}</Link><span>시작 {formatDate(run.startedAt)} · 종료 {formatDate(run.finishedAt)}</span><span>변경 파일 {run.changedPaths.length}개 · push {pushLabels[run.push.status]}</span></div>{run.summary && <p className="whitespace-pre-wrap break-words text-label-13">{run.summary}</p>}{run.error && <ErrorNotice error={run.error} />}</div>
}
