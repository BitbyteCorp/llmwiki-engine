'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useInfiniteQuery } from '@tanstack/react-query'
import { GitCommitHorizontal, ListTodo, Moon, Cloud } from 'lucide-react'
import { activityApi, type ActivityFilters, type ActivityItem, type ActivityKind, type ActivitySource } from '@/lib/api'
import { onLiveEvent } from '@/lib/events'
import { EmptyState, ErrorNotice, Loading, PageHeader, formatDate, noteHref } from '@/components/common'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { BackupBadge } from '@/components/history/backup-badge'
import { activityKey, activityTypeLabels, activitySourceLabels, activityStatusLabels, pushLabels, uniqueActivity } from '@/components/history/activity-helpers'

const icons = { commit: GitCommitHorizontal, job: ListTodo, dream: Moon, backup: Cloud }

function ActivityRow({ item, fresh }: { item: ActivityItem; fresh: boolean }) {
  const Icon = icons[item.type]
  const href = item.type === 'commit' ? `/history/commits/${encodeURIComponent(item.id)}` : item.type === 'job' ? `/jobs/${encodeURIComponent(item.id)}` : `/dreams/${encodeURIComponent(item.id)}`
  const status = item.job?.status ?? item.dream?.status ?? item.push?.status
  const title = item.summary || item.commit?.subject || (item.type === 'backup' && item.push ? pushLabels[item.push.status] : `${activityTypeLabels[item.type]} 기록`)
  const canOpen = item.type !== 'job' || item.job?.input !== undefined
  return <li className={`relative flex gap-3 p-4 transition-colors ${fresh ? 'bg-primary/5 ring-1 ring-inset ring-primary/30' : ''}`}>
    <Icon aria-hidden="true" className="mt-1 size-5 shrink-0 text-muted-foreground" />
    <article className="min-w-0 flex-1 space-y-2">
      <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{activityTypeLabels[item.type]}</Badge><Badge variant="secondary">{activitySourceLabels[item.source] ?? item.source}</Badge>{status && <Badge variant={status === 'failed' ? 'destructive' : 'outline'} className={status === 'succeeded' ? 'border-success/30 bg-success/10 text-success' : status === 'skipped' ? 'border-warning/30 bg-warning/10 text-warning' : undefined}>{item.push ? pushLabels[item.push.status] : activityStatusLabels[status] ?? status}</Badge>}{fresh && <Badge>새 기록</Badge>}<time dateTime={item.at} title={formatDate(item.at)} className="ml-auto shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-muted-foreground">{formatDate(item.at)}</time></div>
      <h2 className="line-clamp-2 break-words text-sm font-semibold" title={title}>{canOpen ? <Link className="rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-ring" href={href}>{title}</Link> : title}</h2>
      <p className="break-all text-xs text-muted-foreground">{item.commit ? <>작성자 {item.commit.authorName} · <span className="font-mono">{item.id.slice(0, 8)}</span></> : <span className="font-mono">{item.id}</span>}</p>
      {!canOpen && <p className="text-xs text-muted-foreground">작업 상세는 요청자와 관리자만 볼 수 있습니다.</p>}
      {item.push?.status === 'skipped' && <p className="text-xs text-muted-foreground">원격에 저장되지 않은 로컬 전용 기록입니다.</p>}
      {item.paths.length > 0 && <ul aria-label="변경 경로" className="flex flex-wrap gap-x-3 gap-y-1">{item.paths.map(path => <li key={path}><Link className="break-all text-xs text-muted-foreground hover:underline" href={path.endsWith('.md') ? noteHref(path) : `/history?view=activity&path=${encodeURIComponent(path)}`}>{path}</Link></li>)}</ul>}
    </article>
  </li>
}

function ActivityTimeline({ filters }: { filters: ActivityFilters }) {
  const activity = useInfiniteQuery({
    queryKey: ['activity', filters],
    queryFn: ({ pageParam, signal }) => activityApi.list({ ...filters, before: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor ?? undefined,
  })
  const sentinel = useRef<HTMLDivElement>(null)
  const previousIds = useRef<Set<string> | null>(null)
  const liveUpdate = useRef(false)
  const [highlighted, setHighlighted] = useState<Set<string>>(() => new Set())
  const items = uniqueActivity(activity.data?.pages.flatMap(page => page.items) ?? [])
  useEffect(() => {
    const markLive = () => { if (previousIds.current) liveUpdate.current = true }
    const unsubscribe = ['main.updated', 'job.updated', 'dream.updated'].map(type => onLiveEvent(type, markLive))
    return () => unsubscribe.forEach(stop => stop())
  }, [])
  useEffect(() => {
    if (!activity.data) return
    const current = new Set(activity.data.pages.flatMap(page => page.items.map(activityKey)))
    if (liveUpdate.current && previousIds.current) {
      const added = activity.data.pages[0]!.items.map(activityKey).filter(id => !previousIds.current!.has(id))
      if (added.length) setHighlighted(existing => new Set([...existing, ...added]))
    }
    previousIds.current = current
    liveUpdate.current = false
  }, [activity.data, activity.dataUpdatedAt])
  useEffect(() => {
    const node = sentinel.current
    if (!node || !activity.hasNextPage || activity.isFetching || activity.isError || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void activity.fetchNextPage() }, { rootMargin: '160px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [activity.hasNextPage, activity.isFetching, activity.isError, activity.fetchNextPage])
  return <section className="space-y-3" aria-label="활동 기록">
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-muted-foreground">최신 기록부터 표시하며 변경 사항은 실시간으로 갱신합니다.</p>{highlighted.size > 0 && <Button size="sm" variant="ghost" onClick={() => setHighlighted(new Set())}>새 기록 표시 지우기</Button>}</div>
    <p role="status" aria-live="polite" className="sr-only">{highlighted.size > 0 ? `새 활동 기록 ${highlighted.size}개가 표시되었습니다.` : ''}</p>
    {activity.isPending && <Loading label="타임라인을 불러오는 중…" />}
    {activity.isError && <div className="space-y-2"><ErrorNotice error={activity.error} /><Button variant="outline" disabled={activity.isFetching} onClick={() => void (activity.isFetchNextPageError ? activity.fetchNextPage() : activity.refetch())}>다시 시도</Button></div>}
    {!activity.isPending && !activity.isError && items.length === 0 && <EmptyState title="표시할 활동이 없습니다" description="선택한 필터에 맞는 기록이 없습니다. 필터를 바꾸거나 새 변경을 기다려 주세요." />}
    {items.length > 0 && <ol className="divide-y overflow-hidden rounded-lg border bg-card">{items.map(item => <ActivityRow key={activityKey(item)} item={item} fresh={highlighted.has(activityKey(item))} />)}</ol>}
    <div ref={sentinel} aria-hidden="true" className="h-px" />
    {activity.hasNextPage && <Button variant="outline" disabled={activity.isFetching} onClick={() => void activity.fetchNextPage()}>{activity.isFetchingNextPage ? '이전 활동을 불러오는 중…' : '이전 활동 더 보기'}</Button>}
    {!activity.hasNextPage && items.length > 0 && <p className="text-center text-xs text-muted-foreground">모든 활동을 확인했습니다.</p>}
  </section>
}

export function ActivityPage() {
  const params = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()
  const filters: ActivityFilters = { type: (params.get('type') || undefined) as ActivityKind | undefined, source: (params.get('source') || undefined) as ActivitySource | undefined, path: params.get('path') || undefined }
  const filterKey = JSON.stringify(filters)
  return <div className="min-w-0 space-y-6">
    <PageHeader title="전체 타임라인" description="커밋, 쓰기 작업, dreaming과 원격 백업 기록을 한곳에서 확인합니다." actions={<nav aria-label="관련 기록" className="flex flex-wrap gap-3 text-sm"><Link className="hover:underline" href="/jobs">쓰기 작업</Link><Link className="hover:underline" href="/dreams">dreaming 기록</Link><Link className="hover:underline" href="/journal">일기</Link></nav>} />
    <div className="rounded-lg border bg-card p-4"><BackupBadge /></div>
    <form key={`filters:${filterKey}`} className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4" aria-label="타임라인 필터" onSubmit={event => {
      event.preventDefault()
      const form = new FormData(event.currentTarget)
      const next = new URLSearchParams(params.toString())
      next.set('view', 'activity')
      next.delete('before')
      for (const name of ['type', 'source', 'path']) {
        const value = String(form.get(name) ?? '').trim()
        if (value) next.set(name, value)
        else next.delete(name)
      }
      router.push(`${pathname}?${next}`)
    }}>
      <label className="space-y-1 text-xs font-medium"><span className="block">기록 종류</span><NativeSelect size="sm" name="type" defaultValue={filters.type ?? ''}><option value="">전체 종류</option>{Object.entries(activityTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</NativeSelect></label>
      <label className="space-y-1 text-xs font-medium"><span className="block">출처</span><NativeSelect size="sm" name="source" defaultValue={filters.source ?? ''}><option value="">전체 출처</option>{Object.entries(activitySourceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</NativeSelect></label>
      <label className="min-w-0 flex-1 basis-48 space-y-1 text-xs font-medium"><span className="block">노트 또는 파일 경로</span><Input className="h-8" name="path" defaultValue={filters.path ?? ''} placeholder="예: wiki/시작.md" /></label>
      <Button type="submit" variant="outline">필터 적용</Button>
      {(filters.type || filters.source || filters.path) && <Button variant="ghost" nativeButton={false} render={<Link href="/history" />}>초기화</Button>}
    </form>
    {filters.path && <p className="text-sm text-muted-foreground">현재 경로에 대한 활동만 표시합니다. <Link className="underline" href={`/history?path=${encodeURIComponent(filters.path)}&follow=1`}>이름 변경을 따라 노트 이력 보기</Link></p>}
    <ActivityTimeline key={`timeline:${filterKey}`} filters={filters} />
  </div>
}

export default ActivityPage
