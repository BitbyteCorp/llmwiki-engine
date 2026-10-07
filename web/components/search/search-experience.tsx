'use client'

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { Search, SlidersHorizontal } from 'lucide-react'
import { api, type SearchFilters, type SearchHit } from '@/lib/api'
import { EmptyState, ErrorNotice, Loading, formatDate, noteHref } from '@/components/common'
import { useWorkspace } from '@/components/workspace/context'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { excerptParts, treeFolders, type SearchState } from './search-state'

const KIND_LABELS: Record<string, string> = { wiki: '위키', journal: '일기', raw: '원문', other: '노트' }
const DEGRADED_REASONS: Record<string, string> = {
  no_api_key: '임베딩 API 키가 설정되지 않아 의미 검색을 사용할 수 없습니다. 키워드 결과를 표시합니다.',
  embedding_error: '임베딩 서비스에 연결하지 못해 의미 검색을 사용할 수 없습니다. 키워드 결과를 표시합니다.',
  vector_mismatch: '임베딩 모델 또는 벡터 차원이 색인과 일치하지 않습니다. 관리자가 전체 재색인을 실행하기 전까지 키워드 결과를 표시합니다.',
  index_stale: '검색 색인이 최신 저장소 변경을 아직 반영하지 못했습니다. 키워드 결과를 표시하며 색인이 갱신되면 자동으로 다시 검색합니다.',
}

function useDebouncedState(value: SearchState, composing: boolean) {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    if (composing) return
    const timer = window.setTimeout(() => setSettled(value), 300)
    return () => window.clearTimeout(timer)
  }, [value, composing])
  return settled
}

function hitHref(hit: SearchHit) {
  return noteHref(hit.path) + (hit.anchor ? `#${encodeURIComponent(hit.anchor)}` : '')
}

export function SearchExperience({ value, onChange, compact = false, onCompositionChange }: {
  value: SearchState
  onChange(value: SearchState): void
  compact?: boolean
  onCompositionChange?(composing: boolean): void
}) {
  const id = useId()
  const workspace = useWorkspace()
  const [composing, setComposing] = useState(false)
  const compositionRef = useRef(false)
  const settled = useDebouncedState(value, composing)
  const query = settled.q.trim()
  const updating = value !== settled || composing
  const [active, setActive] = useState(-1)
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false)
  const sentinel = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const tree = useQuery({ queryKey: ['notes/tree'], queryFn: api.tree })
  const tags = useQuery({ queryKey: ['tags'], queryFn: ({ signal }) => api.tags(signal) })
  const folders = useMemo(() => treeFolders(tree.data?.files ?? []), [tree.data])
  const suggest = useQuery({
    queryKey: ['search/suggest', value.q.trim()],
    queryFn: ({ signal }) => api.suggest(value.q.trim(), signal),
    enabled: Boolean(query) && !updating,
  })
  const search = useInfiniteQuery({
    // Move the observer immediately so TanStack aborts superseded requests;
    // the debounce only controls when the replacement request may start.
    queryKey: ['search', value.q.trim(), value.filters],
    queryFn: ({ signal, pageParam }) => api.search(value.q.trim(), { ...value.filters, cursor: pageParam, limit: 20 }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor ?? undefined,
    enabled: Boolean(query) && !updating,
    retry: false,
  })
  const hits = useMemo(() => search.data?.pages.flatMap(page => page.hits) ?? [], [search.data])
  const suggestions = !updating && !suggestionsDismissed ? suggest.data ?? [] : []
  const navigable = [...suggestions.map(item => ({ path: item.path, anchor: null as string | null })), ...hits]
  const activeItem = !updating ? navigable[active] : undefined
  const selectedTags = value.filters.tags?.split(',').map(tag => tag.trim()).filter(Boolean) ?? []
  const metadata = search.data?.pages[0]
  const degraded = search.data?.pages.find(page => page.degraded)?.degraded
  const [autoLoad, setAutoLoad] = useState(true)

  useEffect(() => {
    setActive(-1)
    setSuggestionsDismissed(false)
    setAutoLoad(true)
  }, [query, settled.filters])
  useEffect(() => {
    if (!activeItem) return
    document.getElementById(`${id}-option-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active, activeItem?.path, id])
  useEffect(() => {
    const target = sentinel.current
    if (!target || !autoLoad || updating || !search.hasNextPage || search.isFetching || search.isFetchNextPageError || !('IntersectionObserver' in window)) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void search.fetchNextPage()
    }, { rootMargin: '160px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [autoLoad, updating, search.hasNextPage, search.isFetching, search.isFetchNextPageError, search.fetchNextPage, hits.length])

  function updateFilter(key: keyof SearchFilters, next: string) {
    onChange({ ...value, filters: { ...value.filters, [key]: next || undefined } })
  }
  function changeComposition(next: boolean) {
    compositionRef.current = next
    setComposing(next)
    onCompositionChange?.(next)
  }
  function open(path: string, anchor: string | null, split = false) {
    if (split && !workspace.activePath) workspace.openNote(workspace.recentPaths[0] ?? path, { pin: true })
    workspace.openNote(path, { fragment: anchor ?? undefined, split })
  }
  function clickNote(event: MouseEvent<HTMLAnchorElement>, path: string, anchor: string | null) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    open(path, anchor)
  }
  function handleKeys(event: KeyboardEvent<HTMLInputElement>) {
    if (compositionRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    if (event.key === 'Escape') {
      setActive(-1)
      setSuggestionsDismissed(true)
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !updating && navigable.length) {
      event.preventDefault()
      setActive(previous => event.key === 'ArrowDown' ? Math.min(previous + 1, navigable.length - 1) : Math.max(previous - 1, 0))
    } else if (event.key === 'Enter') {
      if (updating) { event.preventDefault(); return }
      const item = activeItem ?? ((event.ctrlKey || event.metaKey) ? hits[0] : undefined)
      if (item) {
        event.preventDefault()
        open(item.path, item.anchor, event.ctrlKey || event.metaKey)
      }
    }
  }

  return <div className="space-y-4">
    <form role="search" className="space-y-3" onSubmit={event => {
      event.preventDefault()
      if (!compositionRef.current && query && !updating) void search.refetch()
    }}>
      <Label htmlFor={`${id}-query`}>{compact ? '전체 노트 검색' : '검색어'}</Label>
      <div className={`flex gap-2 ${compact ? 'flex-col' : ''}`}>
        <div className="relative min-w-0 flex-1">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input ref={input} id={`${id}-query`} type="search" name="q" value={value.q} autoComplete="off"
            maxLength={200} placeholder={compact ? '검색어 또는 질문…' : '찾고 싶은 주제나 질문을 입력하세요'} className="h-10 pl-9"
            aria-controls={`${id}-suggestions ${id}-results`} aria-activedescendant={activeItem ? `${id}-option-${active}` : undefined}
            onChange={event => { setActive(-1); setSuggestionsDismissed(false); onChange({ ...value, q: event.target.value }) }}
            onCompositionStart={() => changeComposition(true)} onCompositionEnd={() => changeComposition(false)} onKeyDown={handleKeys} />
        </div>
        <Button type="submit" className="h-10" disabled={!value.q.trim() || composing}>검색</Button>
      </div>
      <p className="text-xs text-muted-foreground">↑ ↓ 결과 선택 · Enter 열기 · Ctrl/⌘ Enter 나란히 열기</p>
      <details className="rounded-lg border p-3">
        <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium"><SlidersHorizontal aria-hidden="true" className="size-4" />검색 필터{Object.values(value.filters).filter(Boolean).length > 0 && <Badge variant="secondary">{Object.values(value.filters).filter(Boolean).length}</Badge>}</summary>
        <div className={`mt-4 grid gap-4 ${compact ? '' : 'sm:grid-cols-2 lg:grid-cols-3'}`}>
          <div className="space-y-2"><Label htmlFor={`${id}-folder`}>폴더</Label>
            <NativeSelect id={`${id}-folder`} className="w-full" value={value.filters.folder ?? ''} onChange={event => updateFilter('folder', event.target.value)}>
              <NativeSelectOption value="">전체 폴더</NativeSelectOption>
              {value.filters.folder && !folders.includes(value.filters.folder) && <NativeSelectOption value={value.filters.folder}>{value.filters.folder}</NativeSelectOption>}
              {folders.map(folder => <NativeSelectOption key={folder} value={folder}>{folder}</NativeSelectOption>)}
            </NativeSelect>
            {tree.isPending && <p className="text-xs text-muted-foreground">폴더를 불러오는 중…</p>}
            {tree.isError && <><ErrorNotice error={tree.error} /><Button type="button" variant="outline" size="sm" onClick={() => void tree.refetch()}>폴더 다시 불러오기</Button></>}
          </div>
          {(['from', 'to', 'author'] as const).map(key => <div key={key} className="space-y-2">
            <Label htmlFor={`${id}-${key}`}>{key === 'from' ? '수정일 시작' : key === 'to' ? '수정일 종료' : '마지막 수정자'}</Label>
            <Input id={`${id}-${key}`} name={key} value={value.filters[key] ?? ''} placeholder={key === 'author' ? '이름 또는 이메일' : 'YYYY-MM-DD 또는 ISO 날짜/시간'} onChange={event => updateFilter(key, event.target.value)} />
          </div>)}
          <fieldset className={`min-w-0 space-y-2 ${compact ? '' : 'sm:col-span-2 lg:col-span-3'}`}>
            <legend className="text-sm font-medium">태그 (선택한 태그를 모두 포함)</legend>
            {tags.isPending && <Loading label="태그를 불러오는 중" />}
            {tags.isError && <><ErrorNotice error={tags.error} /><Button type="button" variant="outline" size="sm" onClick={() => void tags.refetch()}>태그 다시 불러오기</Button></>}
            {tags.data?.length === 0 && !selectedTags.length && <p className="text-xs text-muted-foreground">색인된 태그가 없습니다.</p>}
            <div className="flex max-h-48 flex-wrap gap-2 overflow-auto">
              {[...(tags.data ?? []), ...selectedTags.filter(tag => !tags.data?.some(item => item.tag === tag)).map(tag => ({ tag, count: null }))].map(item => <label key={item.tag} className="flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs">
                <input type="checkbox" className="accent-primary" checked={selectedTags.includes(item.tag)} onChange={event => updateFilter('tags', (event.target.checked ? [...selectedTags, item.tag] : selectedTags.filter(tag => tag !== item.tag)).join(','))} />
                <span className="break-all">#{item.tag}</span><span className="text-muted-foreground">{item.count === null ? '미색인' : `${item.count}개`}</span>
              </label>)}
            </div>
          </fieldset>
          <Button type="button" variant="outline" size="sm" onClick={() => onChange({ ...value, filters: {} })}>필터 초기화</Button>
        </div>
      </details>
    </form>

    {!value.q.trim() && <EmptyState title="어떤 지식을 찾고 있나요?" description="주제, 키워드 또는 질문으로 검색하세요." />}
    {value.q.trim() && (updating || search.isPending) && <Loading label={composing ? '검색어 입력을 마치면 검색합니다' : '관련 지식을 검색하는 중'} />}
    {value.q.trim() && !updating && <>
      {!suggestionsDismissed && <section id={`${id}-suggestions`} aria-label="노트 제목 및 경로 제안" className="space-y-2">
        {suggest.isPending && <p role="status" className="text-xs text-muted-foreground">제목 제안을 불러오는 중…</p>}
        {suggest.isError && <><ErrorNotice error={suggest.error} /><Button variant="outline" size="sm" onClick={() => void suggest.refetch()}>제안 다시 불러오기</Button></>}
        {suggestions.length > 0 && <><h2 className="text-xs font-semibold text-muted-foreground">제목 · 경로 제안</h2><ul className="max-h-60 overflow-auto rounded-lg border">
          {suggestions.map((item, index) => <li key={item.path} id={`${id}-option-${index}`} className={active === index ? 'bg-accent' : ''}>
            <Link href={noteHref(item.path)} className="block px-3 py-2 text-sm hover:bg-accent focus-visible:outline focus-visible:outline-ring" onClick={event => clickNote(event, item.path, null)}>
              <span className="block break-words font-medium">{item.title || item.path}</span><span className="block break-all text-xs text-muted-foreground">{item.path}</span>
            </Link>
          </li>)}
        </ul></>}
      </section>}
      <section id={`${id}-results`} aria-label="검색 결과" className="space-y-3" aria-busy={search.isFetching}>
        {metadata && <>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2"><h2 className="text-sm font-semibold">“{query}” 검색 결과</h2><span aria-live="polite" className="text-xs text-muted-foreground">{hits.length}건{search.hasNextPage ? '+' : ''} · {metadata.mode === 'hybrid' ? '의미 + 키워드' : '키워드'}</span></div>
          {(degraded || metadata.mode === 'keyword') && <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">{degraded ? DEGRADED_REASONS[degraded.reason] ?? '의미 검색을 사용할 수 없어 키워드 결과를 표시합니다.' : '키워드 검색 결과를 표시합니다. 제목과 본문의 일치하는 단어로 검색합니다.'}</p>}
        </>}
        {search.isError && !search.isFetchNextPageError && <><ErrorNotice error={search.error} /><Button variant="outline" onClick={() => void search.refetch()}>검색 다시 시도</Button></>}
        {metadata && !hits.length && <EmptyState title="검색 결과가 없습니다" description="다른 표현을 사용하거나 폴더·태그·날짜 필터를 줄여 보세요." />}
        <ul className="space-y-3">
          {hits.map((hit, index) => <li key={`${hit.path}:${hit.anchor ?? hit.heading}:${index}`} id={`${id}-option-${suggestions.length + index}`} className={`space-y-2 rounded-lg border p-3 ${active === suggestions.length + index ? 'border-ring bg-accent/40' : ''}`}>
            <Link href={hitHref(hit)} onClick={event => clickNote(event, hit.path, hit.anchor)} className="group block space-y-2 rounded-sm focus-visible:outline focus-visible:outline-ring">
            <div className="flex items-start justify-between gap-2"><span className="min-w-0 break-words font-semibold underline-offset-4 group-hover:underline">{hit.title || hit.path.split('/').pop()?.replace(/\.md$/i, '')}</span><Badge variant="outline">{KIND_LABELS[hit.kind] ?? '노트'}</Badge></div>
            <p className="break-all text-xs text-muted-foreground" aria-label={`경로: ${hit.path}`}>{hit.path.split('/').join(' / ')}</p>
            {hit.heading && <p className="break-words text-sm font-medium">{hit.heading}</p>}
            <p className="whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground">{excerptParts(hit.excerpt || hit.snippet, hit.highlights).map((part, partIndex) => part.marked ? <mark key={partIndex} className="rounded-sm bg-yellow-200 px-0.5 text-yellow-950 dark:bg-yellow-500/30 dark:text-yellow-100">{part.text}</mark> : part.text)}</p>
            <div className="flex flex-wrap items-center gap-2">{hit.tags.map(tag => <Badge key={tag} variant="secondary">#{tag}</Badge>)}{hit.updatedAt && <time dateTime={hit.updatedAt} className="text-xs text-muted-foreground">수정 {formatDate(hit.updatedAt)}</time>}</div>
            </Link>
            <Button variant="ghost" size="sm" onClick={() => open(hit.path, hit.anchor, true)}>나란히 열기</Button>
          </li>)}
        </ul>
        {search.isFetching && !search.isPending && !search.isFetchingNextPage && <p role="status" className="text-xs text-muted-foreground">검색 결과를 갱신하는 중…</p>}
        {search.isFetchNextPageError && <><ErrorNotice error={search.error} /><Button variant="outline" onClick={() => void search.fetchNextPage()}>다음 결과 다시 시도</Button><Button variant="ghost" size="sm" onClick={() => void search.refetch()}>커서 만료 시 처음부터 검색</Button></>}
        {search.isFetchingNextPage && <Loading label="다음 검색 결과를 불러오는 중" />}
        {search.hasNextPage && <>
          <div ref={sentinel} aria-hidden="true" className="h-1" />
          <Button className="w-full" variant="outline" disabled={search.isFetching} onClick={() => void search.fetchNextPage()}>결과 더 불러오기</Button>
          <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={autoLoad} onChange={event => setAutoLoad(event.target.checked)} />스크롤 시 자동으로 불러오기</label>
        </>}
      </section>
    </>}
  </div>
}
