'use client'

import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { dreamsApi, type OpsDreamRun } from '@/lib/api'
import { EmptyState, ErrorNotice, Loading, PageHeader, formatDate, noteHref } from '@/components/common'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

const statusLabels: Record<OpsDreamRun['status'], string> = { running: '실행 중', succeeded: '완료', failed: '실패' }
const pushLabels: Record<OpsDreamRun['push']['status'], string> = { pending: '대기 중', succeeded: '성공', skipped: '건너뜀', failed: '실패' }

function DreamStatus({ status }: { status: OpsDreamRun['status'] }) {
  return <Badge variant="outline" className={status === 'failed' ? 'border-destructive/30 bg-destructive/5 text-destructive' : status === 'succeeded' ? 'border-success/30 bg-success/10 text-success' : 'text-muted-foreground'}>{statusLabels[status]}</Badge>
}

function duration(run: OpsDreamRun) {
  if (!run.finishedAt) return '진행 중'
  const seconds = Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000))
  if (seconds < 60) return `${seconds}초`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 ${seconds % 60}초`
  return `${Math.floor(seconds / 3600)}시간 ${Math.floor(seconds % 3600 / 60)}분`
}

function CommitLink({ sha }: { sha: string | null }) {
  return sha ? <Link href={`/history/commits/${encodeURIComponent(sha)}`} className="break-all font-mono text-xs underline underline-offset-4">{sha}</Link> : <span className="text-muted-foreground">아직 기록되지 않음</span>
}

function journalHref(path: string) {
  const date = /^journal\/(\d{4}-\d{2}-\d{2})\.md$/.exec(path)?.[1]
  return date ? `/journal?date=${date}` : noteHref(path)
}

export function DreamsPage() {
  const query = useInfiniteQuery({
    queryKey: ['dreams'],
    queryFn: ({ pageParam, signal }) => dreamsApi.list({ before: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  })
  const runs = query.data?.pages.flatMap((page) => page.runs) ?? []
  return <div className="min-w-0 space-y-6">
    <PageHeader title="Dreaming 실행 기록" description="하루치 지식 정리 결과와 일기, 원격 백업 결과를 확인합니다." actions={<Button variant="outline" nativeButton={false} render={<Link href="/journal" />}>일기 보기</Button>} />
    {query.isPending && <Loading label="실행 기록을 불러오는 중…" />}
    {query.error && <div className="space-y-3"><ErrorNotice error={query.error} /><Button variant="outline" onClick={() => void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch())} disabled={query.isFetching}>다시 시도</Button></div>}
    {!query.isPending && !query.error && runs.length === 0 && <EmptyState title="아직 dreaming 실행 기록이 없습니다" description="일일 지식 정리가 실행되면 여기에 기록됩니다." />}
    {runs.length > 0 && <ul className="divide-y rounded-lg border bg-card">{runs.map((run) => <li key={run.id} className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex min-w-0 flex-wrap items-center gap-2"><DreamStatus status={run.status} /><Link href={`/dreams/${encodeURIComponent(run.id)}`} className="break-all font-mono text-xs underline underline-offset-4">{run.id}</Link></div><time className="shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground" dateTime={run.startedAt} title={formatDate(run.startedAt)}>{formatDate(run.startedAt)}</time></div>
      <Link href={`/dreams/${encodeURIComponent(run.id)}`} className="line-clamp-3 whitespace-pre-wrap break-words text-sm font-medium leading-6 hover:underline" title={run.summary || run.error || undefined}>{run.summary || (run.status === 'running' ? '지식을 정리하고 있습니다.' : run.error || '기록된 요약이 없습니다.')}</Link>
      <div className="flex flex-wrap gap-x-3 gap-y-2 text-xs text-muted-foreground"><span>변경 파일 <span className="tabular-nums">{run.changedPaths.length}</span>개</span><span className="tabular-nums">소요 시간 {duration(run)}</span><span className={run.push.status === 'failed' ? 'text-destructive' : run.push.status === 'succeeded' ? 'text-success' : run.push.status === 'skipped' ? 'text-warning' : undefined}>원격 push · {pushLabels[run.push.status]}</span>{run.journalPath && <Link href={journalHref(run.journalPath)} className="underline underline-offset-4">일기 보기</Link>}</div>
    </li>)}</ul>}
    {query.hasNextPage && <Button variant="outline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? '불러오는 중…' : '이전 실행 더 보기'}</Button>}
  </div>
}

export function DreamPage() {
  const { id: encodedId } = useParams<{ id: string }>()
  const id = encodedId === undefined ? undefined : decodeURIComponent(encodedId)
  const query = useQuery({ queryKey: ['dream', id], queryFn: ({ signal }) => dreamsApi.detail(id!, signal), enabled: !!id })
  if (!id) return <EmptyState title="실행 기록을 선택해 주세요" />
  if (query.isPending) return <Loading label="Dreaming 보고서를 불러오는 중…" />
  if (query.isError) return <div className="space-y-3"><ErrorNotice error={query.error} /><Button variant="outline" onClick={() => void query.refetch()} disabled={query.isFetching}>다시 시도</Button></div>
  const run = query.data
  return <div className="min-w-0 space-y-6">
    <PageHeader title="Dreaming 보고서" description={<span className="break-all font-mono text-xs">{run.id}</span>} actions={<><Button variant="outline" nativeButton={false} render={<Link href="/dreams" />}>실행 기록</Button>{run.journalPath && <Button variant="outline" nativeButton={false} render={<Link href={journalHref(run.journalPath)} />}>일기 보기</Button>}</>} />
    <dl className="grid gap-3 rounded-lg border bg-card p-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
      <div><dt className="text-muted-foreground">상태</dt><dd className="mt-1"><DreamStatus status={run.status} /></dd></div>
      <div className="min-w-0"><dt className="text-muted-foreground">시작 시각</dt><dd className="mt-1 whitespace-nowrap text-right tabular-nums"><time dateTime={run.startedAt} title={formatDate(run.startedAt)}>{formatDate(run.startedAt)}</time></dd></div>
      <div className="min-w-0"><dt className="text-muted-foreground">완료 시각</dt><dd className="mt-1 whitespace-nowrap text-right tabular-nums">{formatDate(run.finishedAt)}</dd></div>
      <div><dt className="text-muted-foreground">소요 시간</dt><dd className="mt-1 text-right tabular-nums">{duration(run)}</dd></div>
    </dl>
    {run.error && <section role="alert" className="space-y-3 rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-destructive"><h2 className="text-sm font-semibold">실행 오류</h2><p className="whitespace-pre-wrap break-words text-sm leading-6">{run.error}</p></section>}
    <section className="space-y-3 rounded-lg border bg-card p-4"><h2 className="text-sm font-semibold">처리 요약</h2><p className="whitespace-pre-wrap break-words text-sm leading-6">{run.summary || (run.status === 'running' ? '실행이 완료되면 처리 요약이 표시됩니다.' : '기록된 요약이 없습니다.')}</p></section>
    <section className="space-y-3"><h2 className="text-sm font-semibold">입력 커밋 범위</h2><p className="text-sm text-muted-foreground">이전 처리 지점부터 이번 실행이 읽은 저장소 스냅샷까지의 범위입니다.</p><dl className="grid gap-3 rounded-lg border bg-card p-4 text-sm sm:grid-cols-2"><div className="min-w-0"><dt className="text-muted-foreground">시작 · fromSha</dt><dd className="mt-1"><CommitLink sha={run.fromSha} /></dd></div><div className="min-w-0"><dt className="text-muted-foreground">끝 · toSha</dt><dd className="mt-1"><CommitLink sha={run.toSha} /></dd></div><div className="min-w-0 sm:col-span-2"><dt className="text-muted-foreground">최종 반영 커밋 · mergeSha</dt><dd className="mt-1"><CommitLink sha={run.mergeSha} /></dd></div></dl>{run.fromSha && run.toSha && <Button variant="outline" nativeButton={false} render={<Link href={`/history/compare?${new URLSearchParams({ base: run.fromSha, head: run.toSha })}`} />}>입력 범위 비교</Button>}</section>
    <section className="space-y-3"><h2 className="flex items-center justify-between gap-3 text-sm font-semibold"><span>변경 파일</span><span className="text-right tabular-nums text-muted-foreground">{run.changedPaths.length}</span></h2>{run.changedPaths.length === 0 ? <EmptyState title="기록된 변경 파일이 없습니다" description={run.status === 'running' ? '실행이 완료되면 변경 파일이 표시됩니다.' : undefined} /> : <ul className="divide-y rounded-lg border bg-card">{run.changedPaths.map((path) => <li key={path} className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm"><Link href={`/history?${new URLSearchParams({ path })}`} className="min-w-0 break-all underline underline-offset-4">{path}</Link>{path.endsWith('.md') && <Link href={path === run.journalPath ? journalHref(path) : noteHref(path)} className="shrink-0 text-xs text-muted-foreground underline underline-offset-4">{path === run.journalPath ? '일기 보기' : '현재 노트'}</Link>}</li>)}</ul>}</section>
    <section className="space-y-3"><h2 className="text-sm font-semibold">원격 push 결과</h2><dl className="grid gap-3 rounded-lg border bg-card p-4 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">상태</dt><dd className={`mt-1 ${run.push.status === 'failed' ? 'text-destructive' : run.push.status === 'succeeded' ? 'text-success' : run.push.status === 'skipped' ? 'text-warning' : ''}`}>{pushLabels[run.push.status]}</dd></div><div className="min-w-0"><dt className="text-muted-foreground">원격 저장소</dt><dd className="mt-1 break-all">{run.push.remote || '기록 없음'}</dd></div><div className="min-w-0"><dt className="text-muted-foreground">대상 커밋</dt><dd className="mt-1"><CommitLink sha={run.push.sha} /></dd></div><div className="min-w-0"><dt className="text-muted-foreground">처리 시각</dt><dd className="mt-1 whitespace-nowrap text-right tabular-nums">{formatDate(run.push.at)}</dd></div><div className="sm:col-span-2"><dt className="text-muted-foreground">사유</dt><dd className="mt-1 whitespace-pre-wrap break-words">{run.push.reason || (run.push.status === 'pending' ? '원격 push 결과를 기다리고 있습니다.' : '기록된 사유가 없습니다.')}</dd></div></dl><p className="text-sm text-muted-foreground">원격 push 실패는 로컬 지식 반영 실패와 별개입니다. 실행 상태와 최종 반영 커밋을 함께 확인하세요.</p></section>
  </div>
}
