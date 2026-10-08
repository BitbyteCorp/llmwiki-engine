'use client'

import { Suspense, useEffect, useMemo, useState } from 'react'
import { useViewLocation } from '@/components/workspace/view-location'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Plus, RefreshCw } from 'lucide-react'
import { api, importsApi, importKeys, type User } from '@/lib/api'
import { onLiveEvent } from '@/lib/events'
import { EmptyState, ErrorNotice, Loading, PageHeader, formatDate } from '@/components/common'
import { Button } from '@/components/ui/button'
import { ImportDialog } from '@/components/admin/import-dialog'
import { ImportDetail, ImportStatusBadge, importKindLabels } from '@/components/admin/import-detail'

const pageSize = 30

export function ImportsPage() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  if (me.isPending) return <Loading label="가져오기 권한을 확인하는 중…" />
  if (me.error) return <div className="space-y-2"><ErrorNotice error={me.error} /><Button variant="outline" onClick={() => void me.refetch()}>다시 시도</Button></div>
  return <Suspense fallback={<Loading label="가져오기 화면을 불러오는 중…" />}><ImportsList user={me.data.user} /></Suspense>
}

function ImportsList({ user }: { user: User }) {
  const client = useQueryClient()
  const location = useViewLocation()
  const searchParams = location.searchParams
  const [selected, setSelected] = useState<string | null>(null)
  const dialogOpen = user.role !== 'viewer' && searchParams.get('new') === '1'
  function closeImport() {
    if (searchParams.has('new')) {
      const params = new URLSearchParams(searchParams.toString())
      params.delete('new')
      const query = params.toString()
      location.replace(`/imports${query ? `?${query}` : ''}`)
    }
  }
  const list = useInfiniteQuery({
    queryKey: importKeys.list(user.id),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => importsApi.list(pageParam, pageSize, signal),
    getNextPageParam: (page) => page.imports.length === pageSize ? page.imports.at(-1)?.id : undefined,
  })
  const records = useMemo(() => {
    const seen = new Set<string>()
    return (list.data?.pages.flatMap((page) => page.imports) ?? []).filter((record) => {
      if (seen.has(record.id)) return false
      seen.add(record.id)
      return true
    })
  }, [list.data])
  useEffect(() => onLiveEvent('job.updated', (event) => {
    if (records.some((record) => record.jobs.some((job) => job.jobId === event.jobId))) void client.invalidateQueries({ queryKey: importKeys.lists })
  }), [client, records])
  return <div className="space-y-4">
    <PageHeader title="원문 가져오기" description={user.role === 'admin' ? '전체 사용자의 수집 기록과 도니 통합 진행 상태를 확인합니다.' : '내가 가져온 원문과 도니 통합 진행 상태를 확인합니다.'} actions={<>
      <Button variant="outline" disabled={list.isFetching} onClick={() => void list.refetch()}><RefreshCw className={`size-3.5 ${list.isFetching ? 'animate-spin motion-reduce:animate-none' : ''}`} />새로고침</Button>
      {user.role !== 'viewer' && <Button onClick={() => { const params = new URLSearchParams(searchParams); params.set('new', '1'); location.push(`/imports?${params}`) }}><Plus className="size-3.5" />새 가져오기</Button>}
    </>} />
    {user.role === 'viewer' && <p className="rounded-lg border bg-muted/30 px-3 py-2 text-label-13 text-muted-foreground">가져오기 기록은 조회할 수 있습니다. 새 원문을 가져오려면 편집자 이상의 권한이 필요합니다.</p>}
    {list.isPending && <Loading label="가져오기 기록을 불러오는 중…" />}
    {list.error && <div className="space-y-2"><ErrorNotice error={list.error} /><Button variant="outline" disabled={list.isFetching} onClick={() => void (list.isFetchNextPageError ? list.fetchNextPage() : list.refetch())}>다시 시도</Button></div>}
    {list.data && records.length === 0 && !list.isError && <EmptyState title="가져온 원문이 없습니다" description={user.role === 'viewer' ? '아직 이 계정의 가져오기 기록이 없습니다.' : 'URL, 텍스트, 문서 파일 또는 Obsidian·Notion ZIP을 가져와 위키와 연결하세요.'} />}
    {records.length > 0 && <section aria-label="가져오기 기록" className="overflow-hidden border-y">
      <div className="hidden h-7 items-center gap-2 border-b px-2 text-xs font-medium text-muted-foreground md:flex"><span className="flex-1">원문 / 종류</span><span>진행 상태</span><span>생성 시각</span><span className="sr-only">상세</span></div>
      <ul className="divide-y">{records.map((record) => <li key={record.id}>
        <button type="button" onClick={() => setSelected(record.id)} aria-label={`${record.source || record.id} 가져오기 상세`} className="block w-full min-w-0 space-y-1 px-2 py-1.5 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          <div className="flex min-w-0 items-center gap-1.5"><ImportStatusBadge status={record.status} /><p className="min-w-0 flex-1 truncate text-label-13 font-medium">{record.source || record.id}</p><ArrowRight className="hidden size-3.5 shrink-0 text-muted-foreground md:block" /></div>
          <div className="flex items-center gap-x-2 overflow-x-auto whitespace-nowrap text-xs text-muted-foreground"><span>{importKindLabels[record.kind]}</span>{user.role === 'admin' && <span>요청자 #{record.userId}</span>}<span className="font-mono">{record.id.slice(0, 8)}</span><time dateTime={record.createdAt}>{formatDate(record.createdAt)}</time>{record.error && <span className="text-destructive">{record.error}</span>}</div>
        </button>
      </li>)}</ul>
    </section>}
    {list.hasNextPage && <div className="flex justify-center"><Button variant="outline" disabled={list.isFetching} onClick={() => void list.fetchNextPage()}>{list.isFetchingNextPage ? '이전 기록을 불러오는 중…' : '이전 기록 더 보기'}</Button></div>}
    {records.length > 0 && !list.hasNextPage && <p className="text-center text-xs text-muted-foreground">모든 가져오기 기록을 확인했습니다.</p>}
    {dialogOpen && <ImportDialog onClose={closeImport} onFailure={() => { void client.invalidateQueries({ queryKey: importKeys.lists }) }} onCreated={({ importId }) => { closeImport(); setSelected(importId); void client.invalidateQueries({ queryKey: importKeys.lists }) }} />}
    {selected && !dialogOpen && <ImportDetail key={selected} id={selected} onClose={() => setSelected(null)} />}
  </div>
}
