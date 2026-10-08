'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight, CheckCircle2, CircleX, Clock3, LoaderCircle } from 'lucide-react'
import { importsApi, importKeys, type ImportKind, type ImportStatus } from '@/lib/api'
import { onLiveEvent } from '@/lib/events'
import { EmptyState, ErrorNotice, Loading, formatDate, noteHref } from '@/components/common'
import { Button } from '@/components/ui/button'
import { ImportModal } from './import-modal'

export const importKindLabels: Record<ImportKind, string> = { url: 'URL', pdf: 'PDF', text: '텍스트', file: '파일', obsidian: 'Obsidian', notion: 'Notion' }
const statusLabels: Record<ImportStatus, string> = { extracting: '원문 추출 중', queued: '통합 대기', running: '통합 실행 중', succeeded: '완료', failed: '실패', cancelled: '취소됨' }

export function ImportStatusBadge({ status }: { status: ImportStatus }) {
  const Icon = status === 'succeeded' ? CheckCircle2 : status === 'failed' || status === 'cancelled' ? CircleX : status === 'queued' ? Clock3 : LoaderCircle
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${status === 'succeeded' ? 'border-success/20 bg-success/10 text-success' : status === 'failed' || status === 'cancelled' ? 'border-destructive/20 bg-destructive/5 text-destructive' : 'border-border bg-muted/40 text-muted-foreground'}`}><Icon className={`size-3.5 ${status === 'extracting' || status === 'running' ? 'animate-spin motion-reduce:animate-none' : ''}`} />{statusLabels[status]}</span>
}

function DetailField({ title, children }: { title: string; children: ReactNode }) {
  return <div className="space-y-0.5"><dt className="text-xs font-medium text-muted-foreground">{title}</dt><dd className="break-all text-label-13">{children}</dd></div>
}

export function ImportDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const client = useQueryClient()
  const detail = useQuery({ queryKey: importKeys.detail(id), queryFn: ({ signal }) => importsApi.detail(id, signal) })
  const record = detail.data
  useEffect(() => onLiveEvent('job.updated', (event) => {
    if (record?.jobId && event.jobId === record.jobId) {
      void client.invalidateQueries({ queryKey: importKeys.detail(id) })
      void client.invalidateQueries({ queryKey: importKeys.lists })
    }
  }), [client, id, record?.jobId])
  const sourceLink = record && /^https?:\/\//i.test(record.source) ? record.source : null
  return <ImportModal drawer title="가져오기 상세" description="원문 보관 상태와 연결된 도니 통합 작업을 확인합니다." onClose={onClose}>
    <div className="space-y-3">
      {detail.isPending && <Loading label="가져오기 정보를 불러오는 중…" />}
      {detail.error && <div className="space-y-3"><ErrorNotice error={detail.error} /><Button variant="outline" onClick={() => void detail.refetch()}>다시 시도</Button></div>}
      {record && <>
        <div className="flex flex-wrap items-end justify-between gap-2 border-b pb-2"><ImportStatusBadge status={record.status} /><Button variant="ghost" size="sm" disabled={detail.isFetching} onClick={() => void detail.refetch()}>{detail.isFetching ? '갱신 중…' : '새로고침'}</Button></div>
        {record.error && <ErrorNotice error={record.error} />}
        <dl className="grid gap-x-6 gap-y-1.5 text-label-13">
          <DetailField title="가져오기 ID"><code>{record.id}</code></DetailField>
          <DetailField title="요청자 ID">{record.userId}</DetailField>
          <DetailField title="종류">{importKindLabels[record.kind]} <span className="text-muted-foreground">({record.kind})</span></DetailField>
          <DetailField title="원문 출처">{sourceLink ? <a href={sourceLink} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">{record.source}<ArrowUpRight className="ml-1 inline size-3.5" /><span className="sr-only"> 새 창에서 열기</span></a> : record.source || '—'}</DetailField>
          <DetailField title="원문 SHA-256"><code>{record.sha ?? '아직 원문 해시가 없습니다.'}</code></DetailField>
          <DetailField title="상태 코드"><code>{record.status}</code></DetailField>
          <DetailField title="연결된 통합 작업">{record.jobId ? <Link href={`/jobs/${encodeURIComponent(record.jobId)}`} className="underline underline-offset-4">{record.jobId}<ArrowUpRight className="ml-1 inline size-3.5" /></Link> : '아직 통합 작업이 등록되지 않았습니다.'}</DetailField>
          <DetailField title="생성 시각"><time dateTime={record.createdAt}>{formatDate(record.createdAt)}</time></DetailField>
          <DetailField title="최근 갱신 시각"><time dateTime={record.updatedAt}>{formatDate(record.updatedAt)}</time></DetailField>
          <DetailField title="완료 시각">{record.finishedAt ? <time dateTime={record.finishedAt}>{formatDate(record.finishedAt)}</time> : '—'}</DetailField>
          <DetailField title="오류">{record.error ?? '없음'}</DetailField>
        </dl>
        <section aria-labelledby="import-raw-heading" className="space-y-2"><h3 id="import-raw-heading" className="flex h-7 items-center gap-1.5 border-b text-label-13 font-semibold">보관된 원문 경로</h3>{record.rawPaths.length ? <ul className="divide-y border-b">{record.rawPaths.map((path) => <li key={path}><Link href={noteHref(path)} className="flex items-start justify-between gap-2 px-2 py-1.5 text-label-13 underline-offset-4 hover:bg-muted/40 hover:underline"><span className="break-all font-mono text-xs leading-5">{path}</span><ArrowUpRight className="mt-0.5 size-3.5 shrink-0" /></Link></li>)}</ul> : <EmptyState title="아직 보관된 원문이 없습니다" description="원문 추출 중이거나 보관 전에 실패한 기록입니다." />}</section>
        <p className="rounded-lg bg-muted/40 px-3 py-2 text-label-13 leading-5 text-muted-foreground">통합이 실패해도 이미 보관된 원문은 유지됩니다. 작업 상세에서 오류와 변경 내역을 확인할 수 있습니다.</p>
      </>}
    </div>
  </ImportModal>
}
