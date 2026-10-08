'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useViewLocation } from '@/components/workspace/view-location'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { GitCommitHorizontal, ListTodo, Moon, Cloud } from 'lucide-react'
import { api, activityApi, type ActivityFilters, type ActivityKind, type ActivitySource } from '@/lib/api'
import { onLiveEvent } from '@/lib/events'
import { EmptyState, ErrorNotice, Loading, PageHeader, formatDate, noteHref } from '@/components/common'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { BackupBadge } from '@/components/history/backup-badge'
import { CommitByline, commitHref, historyHref, relativeDate, sourceLabel } from '@/components/history/commit-meta'
import { activityCards, activityKey, activityTypeLabels, activitySourceLabels, activityStatusLabels, groupActivityDays, pushLabels, type ActivityCard } from '@/components/history/activity-helpers'

const icons = { commit: GitCommitHorizontal, job: ListTodo, dream: Moon, backup: Cloud }

function ActivityRow({ card, fresh }: { card: ActivityCard; fresh: boolean }) {
  const { item, commits } = card
  const commit = commits[0]?.commit
  const Icon = icons[commit ? 'commit' : item.type]
  const canOpenJob = item.type === 'job' && item.job?.input !== undefined
  const jobHref = `/jobs/${encodeURIComponent(item.id)}`
  const href = commit ? commitHref(commit.sha) : item.type === 'job' ? jobHref : `/dreams/${encodeURIComponent(item.id)}`
  const status = item.job?.status ?? item.dream?.status ?? item.push?.status ?? (commit ? 'succeeded' : undefined)
  const title = item.job?.summary || commit?.subject || item.summary || (item.type === 'backup' && item.push ? pushLabels[item.push.status] : `${activityTypeLabels[item.type]} 기록`)
  const canOpen = Boolean(commit) || item.type !== 'job' || canOpenJob
  const paths = [...new Set([...item.paths, ...commits.flatMap(member => member.paths)])]
  return <li className={`relative flex gap-1.5 px-2 py-1.5 transition-colors ${canOpen ? 'hover:bg-accent' : ''} ${fresh ? 'bg-primary/5 ring-1 ring-inset ring-primary/30' : ''}`}>
    <Icon aria-hidden="true" className="mt-1 size-3.5 shrink-0 text-muted-foreground" />
    <article className="min-w-0 flex-1 space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline">{activityTypeLabels[commit ? 'commit' : item.type]}</Badge>
        {status && <Badge variant={status === 'failed' ? 'destructive' : 'outline'} className={status === 'succeeded' ? 'border-success/30 bg-success/10 text-success' : status === 'skipped' ? 'border-warning/30 bg-warning/10 text-warning' : undefined}>{item.push ? pushLabels[item.push.status] : activityStatusLabels[status] ?? status}</Badge>}
        {fresh && <Badge>새 기록</Badge>}
        <h3 className="min-w-0 break-words text-label-13 font-semibold" title={title}>{canOpen ? <Link className="rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-ring" href={href}>{title}</Link> : title}</h3>
      </div>
      <div className="text-xs text-muted-foreground">
        {commit ? <CommitByline commit={commit} /> : <p>{sourceLabel({ ...(item.source !== 'git' ? { 'Wiki-Source': item.source } : {}), ...(item.job?.client ? { 'Wiki-Client': item.job.client } : {}) })} · <time dateTime={item.at} title={formatDate(item.at)}>{relativeDate(item.at)}</time></p>}
        {item.type === 'job' && !canOpenJob && <p>작업 상세는 요청자와 관리자만 볼 수 있습니다.</p>}
        {item.push?.status === 'skipped' && <p>원격에 저장되지 않은 로컬 전용 기록입니다.</p>}
      </div>
      {paths.length > 0 && <ul aria-label="변경한 노트 및 파일" className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {paths.map(path => <li key={path} className="flex min-w-0 items-center gap-1.5">
          <Link className="min-w-0 break-all rounded-sm bg-muted px-1.5 py-0.5 hover:underline focus-visible:outline-2 focus-visible:outline-ring" href={path.endsWith('.md') ? historyHref(path) : `/history?view=activity&path=${encodeURIComponent(path)}`}>{path}</Link>
          {path.endsWith('.md') && <Link className="shrink-0 text-muted-foreground hover:underline" href={noteHref(path)} aria-label={`${path} 노트 열기`}>노트 열기</Link>}
        </li>)}
      </ul>}
      <nav aria-label="기록 작업" className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {commit && <Link className="font-medium text-primary hover:underline" href={commitHref(commit.sha)}>변경 내용 보기</Link>}
        {canOpenJob && <Link className={commit ? 'text-muted-foreground hover:underline' : 'hover:underline'} href={jobHref}>작업 상세</Link>}
        {(item.type === 'dream' || item.type === 'backup') && <Link className="text-muted-foreground hover:underline" href={href}>{item.type === 'backup' ? '백업 상세' : '꿈꾸기 상세'}</Link>}
      </nav>
      {commits.length > 1 && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">함께 남긴 변경 {commits.length}개</summary><ul className="space-y-1 pt-1">{commits.map(member => member.commit && <li key={activityKey(member)}><Link className="hover:underline" href={commitHref(member.commit.sha)}>{member.commit.subject}</Link></li>)}</ul></details>}
    </article>
  </li>
}

function ActivityTimeline({ filters, resetHref }: { filters: ActivityFilters; resetHref: string }) {
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
  const items = activityCards(activity.data?.pages.flatMap(page => page.items) ?? [])
  const days = groupActivityDays(items)
  const freshCount = items.filter(card => card.memberKeys.some(key => highlighted.has(key))).length
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
  return <section className="space-y-2" aria-label="활동 기록">
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-muted-foreground">최신 변경부터 표시하며 작업과 변경 기록을 함께 보여 줍니다.</p>{freshCount > 0 && <Button size="sm" variant="ghost" onClick={() => setHighlighted(new Set())}>새 기록 표시 지우기</Button>}</div>
    <p role="status" aria-live="polite" className="sr-only">{freshCount > 0 ? `새 활동 기록 ${freshCount}개가 표시되었습니다.` : ''}</p>
    {activity.isPending && <Loading label="타임라인을 불러오는 중…" />}
    {activity.isError && <div className="space-y-2"><ErrorNotice error={activity.error} /><Button variant="outline" disabled={activity.isFetching} onClick={() => void (activity.isFetchNextPageError ? activity.fetchNextPage() : activity.refetch())}>다시 시도</Button></div>}
    {!activity.isPending && !activity.isError && items.length === 0 && <div>
      <EmptyState title={filters.type || filters.source || filters.path ? '조건에 맞는 변경이 없습니다' : '아직 변경 기록이 없습니다'} description={filters.type || filters.source || filters.path ? '다른 조건을 선택하거나 필터를 초기화해 보세요.' : '노트를 편집하면 변경 내용과 작업 기록이 여기에 표시됩니다.'} />
      {(filters.type || filters.source || filters.path) && <div className="flex justify-center"><Button variant="outline" nativeButton={false} render={<Link href={resetHref} />}>필터 초기화</Button></div>}
    </div>}
    {days.map(day => <section key={day.key} aria-labelledby={`activity-day-${day.key}`}>
      <h2 id={`activity-day-${day.key}`} className="sticky top-0 z-10 border-y bg-background px-2 py-1.5 text-xs font-semibold">{day.label}</h2>
      <ol className="divide-y border-b">{day.cards.map(card => <ActivityRow key={card.key} card={card} fresh={card.memberKeys.some(key => highlighted.has(key))} />)}</ol>
    </section>)}
    <div ref={sentinel} aria-hidden="true" className="h-px" />
    {activity.hasNextPage && <Button variant="outline" disabled={activity.isFetching} onClick={() => void activity.fetchNextPage()}>{activity.isFetchingNextPage ? '이전 활동을 불러오는 중…' : '이전 활동 더 보기'}</Button>}
    {!activity.hasNextPage && items.length > 0 && <p className="text-center text-xs text-muted-foreground">모든 활동을 확인했습니다.</p>}
  </section>
}

export function ActivityPage() {
  const { searchParams: params, pathname, push } = useViewLocation()
  const tree = useQuery({ queryKey: ['notes/tree'], queryFn: api.tree })
  const filters: ActivityFilters = { type: (params.get('type') || undefined) as ActivityKind | undefined, source: (params.get('source') || undefined) as ActivitySource | undefined, path: params.get('path') || undefined }
  const filterKey = JSON.stringify(filters)
  const resetParams = new URLSearchParams(params.toString())
  for (const name of ['type', 'source', 'path', 'before']) resetParams.delete(name)
  resetParams.set('view', 'activity')
  const resetHref = `${pathname}?${resetParams}`
  return <div className="min-w-0 space-y-4">
    <PageHeader title="전체 변경 이력" description="노트 변경과 작업 진행, 꿈꾸기와 백업 기록을 한곳에서 확인합니다." actions={<nav aria-label="관련 기록" className="flex flex-wrap gap-2 text-label-13"><Link className="hover:underline" href="/jobs">쓰기 작업</Link><Link className="hover:underline" href="/dreams">꿈꾸기 기록</Link><Link className="hover:underline" href="/journal">일기</Link></nav>} />
    <div className="text-label-13"><BackupBadge /></div>
    <form key={`filters:${filterKey}`} className="flex flex-wrap items-end gap-2 border-b pb-2" aria-label="타임라인 필터" onSubmit={event => {
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
      push(`${pathname}?${next}`)
    }}>
      <label className="space-y-1 text-xs text-muted-foreground"><span className="block">기록 종류</span><NativeSelect size="sm" name="type" defaultValue={filters.type ?? ''}><option value="">전체 종류</option>{Object.entries(activityTypeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</NativeSelect></label>
      <label className="space-y-1 text-xs text-muted-foreground"><span className="block">출처</span><NativeSelect size="sm" name="source" defaultValue={filters.source ?? ''}><option value="">전체 출처</option>{Object.entries(activitySourceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</NativeSelect></label>
      <label className="min-w-0 flex-1 basis-48 space-y-1 text-xs text-muted-foreground"><span className="block">노트 선택</span><Input className="h-8" name="path" list="activity-note-paths" defaultValue={filters.path ?? ''} placeholder={tree.isPending ? '노트 목록을 불러오는 중…' : '노트 이름 또는 경로 검색'} /></label>
      <datalist id="activity-note-paths">{tree.data?.files.filter(path => path.endsWith('.md')).map(path => <option key={path} value={path}>{path.split('/').pop()?.replace(/\.md$/, '')}</option>)}</datalist>
      <Button type="submit" variant="outline">필터 적용</Button>
      {(filters.type || filters.source || filters.path) && <Button variant="ghost" nativeButton={false} render={<Link href={resetHref} />}>필터 초기화</Button>}
    </form>
    {tree.isError && <p className="text-xs text-muted-foreground">노트 목록을 불러오지 못했습니다. 경로를 입력해 필터링할 수 있습니다.</p>}
    {filters.path && <p className="text-label-13 text-muted-foreground">선택한 경로의 활동만 표시합니다. <Link className="underline" href={historyHref(filters.path)}>이름 변경을 따라 노트 이력 보기</Link></p>}
    <ActivityTimeline key={`timeline:${filterKey}`} filters={filters} resetHref={resetHref} />
  </div>
}

export default ActivityPage
