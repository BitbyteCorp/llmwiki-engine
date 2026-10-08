'use client'

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { Columns2, LoaderCircle, Search, SlidersHorizontal, X } from 'lucide-react'
import { api, type SearchFilters } from '@/lib/api'
import { EmptyState, ErrorNotice, Loading, formatDate, noteHref } from '@/components/common'
import { useWorkspace } from '@/components/workspace/context'
import type { GroupId } from '@/components/workspace/layout'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { excerptParts, hashtagAt, normalizeTagName, parseSearchTags, readRecentSearches, rememberSearch, removeHashtag, searchHref, toggleSearchTag, treeFolders, type HashtagToken, type SearchState } from './search-state'
import { SearchTagPicker } from './search-tag-picker'

const KIND_LABELS: Record<string, string> = { wiki: '위키', journal: '일기', raw: '원문', other: '노트' }
const FILTER_LABELS: Record<keyof SearchFilters, string> = { folder: '폴더', tags: '태그', from: '수정일 시작', to: '수정일 종료', author: '마지막 수정자' }
const DEGRADED_REASONS: Record<string, string> = {
  no_api_key: '임베딩 API 키가 설정되지 않아 의미 검색을 사용할 수 없습니다. 키워드 결과를 표시합니다.',
  embedding_error: '임베딩 서비스에 연결하지 못해 의미 검색을 사용할 수 없습니다. 키워드 결과를 표시합니다.',
  vector_mismatch: '임베딩 모델 또는 벡터 차원이 색인과 일치하지 않습니다. 관리자가 전체 재색인을 실행하기 전까지 키워드 결과를 표시합니다.',
  index_stale: '검색 색인이 최신 저장소 변경을 아직 반영하지 못했습니다. 키워드 결과를 표시하며 색인이 갱신되면 자동으로 다시 검색합니다.',
}

type FilterChip = { key: keyof SearchFilters; value: string; label: string }

function filterChips(filters: SearchFilters): FilterChip[] {
  return (Object.keys(FILTER_LABELS) as (keyof SearchFilters)[]).flatMap((key): FilterChip[] => {
    const value = filters[key]
    if (!value) return []
    return key === 'tags'
      ? parseSearchTags(value).map(tag => ({ key, value: tag, label: `#${tag}` }))
      : [{ key, value, label: `${FILTER_LABELS[key]}: ${value}` }]
  })
}

export function SearchExperience({ value, onSubmit, compact = false, groupId }: {
  value: SearchState
  onSubmit(value: SearchState): void
  compact?: boolean
  groupId?: GroupId
}) {
  const id = useId()
  const workspace = useWorkspace()
  const queryClient = useQueryClient()
  const query = value.q.trim()
  const committedKey = searchHref(value)
  const [draft, setDraft] = useState(value.q)
  const [authorDraft, setAuthorDraft] = useState(value.filters.author ?? '')
  const ownCommit = useRef<string | null>(null)
  const compositionRef = useRef(false)
  const [composing, setComposing] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false)
  const [autoLoad, setAutoLoad] = useState(true)
  const sentinel = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [tagToken, setTagToken] = useState<HashtagToken | null>(null)
  const [tagActive, setTagActive] = useState(0)
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  const userId = me.data?.user.id
  const storageKey = userId === undefined ? null : `llmwiki.search.recent.v1.${userId}`
  const recent = useQuery({
    queryKey: ['search/recent', userId],
    enabled: storageKey !== null,
    staleTime: Infinity,
    queryFn: () => {
      try { return readRecentSearches(JSON.parse(window.localStorage.getItem(storageKey!) ?? '[]')) }
      catch { return [] as SearchState[] }
    },
  })
  const tree = useQuery({ queryKey: ['notes/tree'], queryFn: api.tree })
  const tags = useQuery({ queryKey: ['tags'], queryFn: ({ signal }) => api.tags(signal) })
  const folders = useMemo(() => treeFolders(tree.data?.files ?? []), [tree.data])
  const suggest = useQuery({
    queryKey: ['search/suggest', query],
    queryFn: ({ signal }) => api.suggest(query, signal),
    enabled: Boolean(query),
    placeholderData: keepPreviousData,
  })
  const search = useInfiniteQuery({
    queryKey: ['search', query, value.filters],
    queryFn: ({ signal, pageParam }) => api.search(query, { ...value.filters, cursor: pageParam, limit: 20 }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor ?? undefined,
    enabled: Boolean(query),
    placeholderData: keepPreviousData,
    retry: false,
  })
  const hits = useMemo(() => query ? search.data?.pages.flatMap(page => page.hits) ?? [] : [], [search.data, query])
  const suggestions = !query || suggestionsDismissed ? [] : (suggest.data ?? []).slice(0, 5)
  const navigable = [...suggestions.map(item => ({ path: item.path, anchor: null as string | null })), ...hits]
  const activeItem = navigable[active]
  const selectedTags = useMemo(() => parseSearchTags(value.filters.tags), [value.filters.tags])
  const chips = filterChips(value.filters)
  const rankedTags = useMemo(() => [...(tags.data ?? [])].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'ko')), [tags.data])
  const popularTags = rankedTags.filter(item => !selectedTags.includes(item.tag)).slice(0, compact ? 5 : 10)
  const tagSuggestions = useMemo(() => {
    const needle = normalizeTagName(tagToken?.query ?? '')
    return rankedTags.filter(item => !selectedTags.includes(item.tag) && normalizeTagName(item.tag).includes(needle))
      .sort((a, b) => Number(normalizeTagName(b.tag).startsWith(needle)) - Number(normalizeTagName(a.tag).startsWith(needle))
        || b.count - a.count || a.tag.localeCompare(b.tag, 'ko')).slice(0, 8)
  }, [rankedTags, selectedTags, tagToken?.query])
  const tagOpen = tagToken !== null && !composing
  const activeTagIndex = Math.min(tagActive, tagSuggestions.length - 1)
  const metadata = search.data?.pages[0]
  const degraded = search.data?.pages.find(page => page.degraded)?.degraded
  const pendingDraft = draft !== value.q && Boolean(draft.trim())

  useEffect(() => {
    // Deliberate filter commits must not discard an unsubmitted query draft.
    if (ownCommit.current !== committedKey) {
      setDraft(value.q)
      setAuthorDraft(value.filters.author ?? '')
      setTagToken(null)
    }
    ownCommit.current = null
  }, [value, committedKey])
  useEffect(() => {
    setActive(-1)
    setSuggestionsDismissed(false)
    setAutoLoad(true)
  }, [committedKey])
  useEffect(() => {
    if (userId === undefined || !recent.isSuccess || !query) return
    queryClient.setQueryData<SearchState[]>(['search/recent', userId], previous => rememberSearch(previous ?? [], value))
  }, [userId, recent.isSuccess, query, queryClient, value])
  useEffect(() => {
    if (!storageKey || !recent.isSuccess) return
    try { window.localStorage.setItem(storageKey, JSON.stringify(recent.data)) } catch { /* Search also works without browser storage. */ }
  }, [storageKey, recent.isSuccess, recent.data])
  useEffect(() => {
    if (!activeItem) return
    document.getElementById(`${id}-option-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active, activeItem?.path, id])
  useEffect(() => {
    const target = sentinel.current
    if (!target || !query || !autoLoad || search.isPlaceholderData || !search.hasNextPage || search.isFetching || search.isFetchNextPageError || !('IntersectionObserver' in window)) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void search.fetchNextPage()
    }, { rootMargin: '160px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [query, autoLoad, search.isPlaceholderData, search.hasNextPage, search.isFetching, search.isFetchNextPageError, search.fetchNextPage, hits.length])

  function commit(next: SearchState) {
    if (searchHref(next) === committedKey) return
    ownCommit.current = searchHref(next)
    onSubmit(next)
  }
  function submitQuery() {
    if (compositionRef.current) return
    const next = { q: draft.trim(), filters: { ...value.filters, author: authorDraft.trim() || undefined } }
    setDraft(next.q)
    setActive(-1)
    setSuggestionsDismissed(false)
    if (searchHref(next) === committedKey) {
      if (query) { void search.refetch(); void suggest.refetch() }
      if (userId !== undefined && next.q) queryClient.setQueryData<SearchState[]>(['search/recent', userId], previous => rememberSearch(previous ?? [], next))
    } else commit(next)
  }
  function updateFilter(key: keyof SearchFilters, next: string) {
    if (key === 'author') setAuthorDraft(next)
    commit({ ...value, filters: { ...value.filters, author: authorDraft.trim() || undefined, [key]: next.trim() || undefined } })
  }
  function toggleTag(tag: string) {
    updateFilter('tags', toggleSearchTag(value.filters.tags, tag))
  }
  function syncHashtag(target: HTMLInputElement) {
    const next = document.activeElement === target && !compositionRef.current
      ? hashtagAt(target.value, target.selectionStart ?? target.value.length) : null
    if (next?.start !== tagToken?.start || next?.end !== tagToken?.end || next?.query !== tagToken?.query) setTagActive(0)
    setTagToken(next)
  }
  function selectTag(tag: string) {
    if (!tagToken) return
    const next = removeHashtag(draft, tagToken)
    toggleTag(tag)
    setDraft(next.text)
    setTagToken(null)
    input.current?.focus()
    requestAnimationFrame(() => input.current?.setSelectionRange(next.caret, next.caret))
  }
  function resetFilters() {
    setAuthorDraft('')
    commit({ ...value, filters: {} })
  }
  function removeChip(chip: FilterChip) {
    updateFilter(chip.key, chip.key === 'tags' ? toggleSearchTag(value.filters.tags, chip.value) : '')
  }
  function open(path: string, anchor: string | null, split = false) {
    if (split && !workspace.activePath) workspace.openNote(workspace.recentPaths[0] ?? path, { pin: true, group: groupId })
    workspace.openNote(path, { fragment: anchor ?? undefined, group: split ? 'side' : groupId })
  }
  function clickNote(event: MouseEvent<HTMLAnchorElement>, path: string, anchor: string | null) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    open(path, anchor)
  }
  function handleKeys(event: KeyboardEvent<HTMLInputElement>) {
    if (compositionRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      if (event.key === 'Enter') event.preventDefault()
      return
    }
    if (tagOpen) {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setTagToken(null)
        return
      }
      if (tagSuggestions.length) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          setTagActive((activeTagIndex + (event.key === 'ArrowDown' ? 1 : -1) + tagSuggestions.length) % tagSuggestions.length)
          return
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault()
          selectTag(tagSuggestions[activeTagIndex].tag)
          return
        }
      } else if (event.key === 'Enter') {
        event.preventDefault()
        setTagToken(null)
        submitQuery()
        return
      }
    }
    if (event.key === 'Escape') {
      setActive(-1)
      setSuggestionsDismissed(true)
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && navigable.length) {
      event.preventDefault()
      setActive(previous => event.key === 'ArrowDown' ? Math.min(previous + 1, navigable.length - 1) : Math.max(previous - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const split = event.ctrlKey || event.metaKey
      const item = draft === value.q ? activeItem ?? (split ? hits[0] : undefined) : undefined
      if (item) open(item.path, item.anchor, split)
      else submitQuery()
    }
  }

  return <div className="space-y-2">
    <form role="search" className="space-y-2" onSubmit={event => { event.preventDefault(); submitQuery() }}>
      <Label htmlFor={`${id}-query`} className="sr-only">전체 노트 검색</Label>
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input ref={input} id={`${id}-query`} type="search" name="q" value={draft} autoComplete="off"
            maxLength={200} placeholder={compact ? '검색어 또는 질문…' : '찾고 싶은 주제나 질문을 입력하세요'}
            className={`pl-9 [&::-webkit-search-cancel-button]:appearance-none ${pendingDraft ? 'pr-24' : 'pr-9'}`}
            role="combobox" aria-autocomplete="list" aria-expanded={tagOpen || suggestions.length > 0}
            aria-controls={`${id}-suggestions ${id}-results${tagOpen ? ` ${id}-tags` : ''}`}
            aria-activedescendant={tagOpen ? (activeTagIndex >= 0 ? `${id}-tag-${activeTagIndex}` : undefined) : activeItem ? `${id}-option-${active}` : undefined}
            onChange={event => { setDraft(event.target.value); setActive(-1); syncHashtag(event.currentTarget) }}
            onFocus={event => syncHashtag(event.currentTarget)} onBlur={() => setTagToken(null)}
            onClick={event => syncHashtag(event.currentTarget)} onSelect={event => syncHashtag(event.currentTarget)}
            onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) syncHashtag(event.currentTarget) }}
            onCompositionStart={() => { compositionRef.current = true; setComposing(true); setTagToken(null) }}
            onCompositionEnd={event => { compositionRef.current = false; setComposing(false); syncHashtag(event.currentTarget) }} onKeyDown={handleKeys} />
          {pendingDraft && <kbd aria-hidden="true" className="pointer-events-none absolute right-9 top-1/2 -translate-y-1/2 rounded border px-1 text-[10px] text-muted-foreground">Enter ↵</kbd>}
          {draft && <Button type="button" variant="ghost" size="icon-xs" aria-label="검색어 지우기" className="absolute right-1.5 top-1/2 -translate-y-1/2" onClick={() => { setDraft(''); setActive(-1); setTagToken(null); input.current?.focus() }}><X /></Button>}
          {tagOpen && <div id={`${id}-tags`} role="listbox" aria-label="태그 자동완성" className="absolute inset-x-0 top-full z-50 mt-1 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md">
            {tagSuggestions.length ? tagSuggestions.map((item, index) => <button key={item.tag} id={`${id}-tag-${index}`} type="button" role="option" aria-selected={index === activeTagIndex} tabIndex={-1}
              className={`flex w-full min-w-0 items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-xs ${index === activeTagIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent'}`}
              onMouseDown={event => event.preventDefault()} onClick={() => selectTag(item.tag)}>
              <span className="min-w-0 truncate">#{item.tag}</span><span className="shrink-0 text-muted-foreground">{item.count}개 노트</span>
            </button>) : <p className="px-2 py-1.5 text-xs text-muted-foreground">일치하는 태그가 없습니다</p>}
          </div>}
        </div>
        {!compact && <Button type="submit" disabled={!draft.trim() || composing}>검색</Button>}
        <Button type="button" variant="outline" size="sm" aria-expanded={filtersOpen} aria-controls={`${id}-filters`} className={compact ? 'gap-1 px-2' : ''} onClick={() => setFiltersOpen(previous => !previous)}>
          <SlidersHorizontal aria-hidden="true" /><span>필터</span>{chips.length > 0 && <Badge variant="secondary" className="px-1 text-[10px]">{chips.length}</Badge>}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground"># 태그 자동완성</p>
      {chips.length > 0 && <div className="flex flex-wrap items-center gap-1.5" aria-label="적용된 검색 필터">
        {chips.map(chip => <Button key={`${chip.key}:${chip.value}`} type="button" variant="secondary" size="xs" className="h-auto min-h-6 max-w-full whitespace-normal text-left" aria-label={`${chip.key === 'tags' ? '태그 ' : ''}${chip.label} 필터 제거`} onClick={() => removeChip(chip)}><span className="min-w-0 break-all">{chip.label}</span><X aria-hidden="true" /></Button>)}
        <Button type="button" variant="ghost" size="xs" onClick={resetFilters}>모두 지우기</Button>
      </div>}
      {!tags.isPending && !tags.isError && popularTags.length > 0 && <div aria-label="인기 태그" className="flex items-center gap-2 overflow-x-auto pb-1">
        <span className="shrink-0 text-xs text-muted-foreground">인기 태그</span>
        {popularTags.map(item => <Button key={item.tag} type="button" variant="outline" size="xs"
          title={`#${item.tag} · ${item.count}개 노트`} aria-label={`인기 태그 #${item.tag} 필터 추가`} onClick={() => toggleTag(item.tag)}>#{item.tag}</Button>)}
      </div>}
      {filtersOpen && <div id={`${id}-filters`} className={`grid gap-x-4 gap-y-2 border-b pb-2 ${compact ? '' : 'sm:grid-cols-2 lg:grid-cols-3'}`}>
        <div className="space-y-1.5"><Label htmlFor={`${id}-folder`}>폴더</Label>
          <NativeSelect id={`${id}-folder`} className="w-full" value={value.filters.folder ?? ''} onChange={event => updateFilter('folder', event.target.value)}>
            <NativeSelectOption value="">전체 폴더</NativeSelectOption>
            {value.filters.folder && !folders.includes(value.filters.folder) && <NativeSelectOption value={value.filters.folder}>{value.filters.folder}</NativeSelectOption>}
            {folders.map(folder => <NativeSelectOption key={folder} value={folder}>{folder}</NativeSelectOption>)}
          </NativeSelect>
          {tree.isPending && <p className="text-xs text-muted-foreground">폴더를 불러오는 중…</p>}
          {tree.isError && <><ErrorNotice error={tree.error} /><Button type="button" variant="outline" size="sm" onClick={() => void tree.refetch()}>폴더 다시 불러오기</Button></>}
        </div>
        {(['from', 'to'] as const).map(key => <div key={key} className="min-w-0 space-y-1.5">
          <Label htmlFor={`${id}-${key}`}>{key === 'from' ? '수정일 시작' : '수정일 종료'}</Label>
          <Input id={`${id}-${key}`} name={key} type="date" className="min-w-0" value={/^\d{4}-\d{2}-\d{2}$/.test(value.filters[key] ?? '') ? value.filters[key] : ''} onChange={event => updateFilter(key, event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.preventDefault() }} />
        </div>)}
        <div className="space-y-1.5"><Label htmlFor={`${id}-author`}>마지막 수정자</Label>
          <Input id={`${id}-author`} name="author" value={authorDraft} placeholder="이름 또는 이메일" onChange={event => setAuthorDraft(event.target.value)}
            onBlur={() => updateFilter('author', authorDraft)} onKeyDown={event => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              if (!event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) updateFilter('author', authorDraft)
            }} />
        </div>
        <fieldset className={`min-w-0 space-y-2 ${compact ? '' : 'sm:col-span-2 lg:col-span-3'}`}>
          <legend className="text-xs font-medium">태그 (선택한 태그를 모두 포함)</legend>
          <SearchTagPicker id={id} tags={rankedTags} selectedTags={selectedTags} pending={tags.isPending}
            error={tags.isError ? tags.error : null} onRetry={() => void tags.refetch()} onToggle={toggleTag} />
        </fieldset>
        <Button type="button" variant="ghost" size="xs" className="justify-self-start" onClick={resetFilters}>필터 초기화</Button>
      </div>}
    </form>

    {!query && <>
      <EmptyState title="어떤 지식을 찾고 있나요?" description="검색어를 입력하고 Enter를 누르세요." />
      {Boolean(recent.data?.length) && <section aria-label="최근 검색" className="space-y-2">
        <div className="flex items-center justify-between"><h2 className="text-xs font-semibold text-muted-foreground">최근 검색</h2><Button variant="ghost" size="xs" onClick={() => queryClient.setQueryData(['search/recent', userId], [])}>기록 지우기</Button></div>
        <ul className="divide-y border-y">
          {recent.data?.map(item => <li key={searchHref(item)} className="flex items-center gap-1 px-2 py-1">
            <button type="button" className="min-w-0 flex-1 rounded px-1 py-1.5 text-left hover:bg-accent focus-visible:outline focus-visible:outline-ring" onClick={() => { setDraft(item.q); setAuthorDraft(item.filters.author ?? ''); commit(item) }}>
              <span className="block truncate text-label-13">{item.q}</span>{filterChips(item.filters).length > 0 && <span className="block truncate text-xs text-muted-foreground">{filterChips(item.filters).map(chip => chip.label).join(' · ')}</span>}
            </button>
            <Button variant="ghost" size="icon-xs" aria-label={`${item.q} 최근 검색 제거`} onClick={() => queryClient.setQueryData<SearchState[]>(['search/recent', userId], previous => previous?.filter(state => searchHref(state) !== searchHref(item)) ?? [])}><X /></Button>
          </li>)}
        </ul>
      </section>}
    </>}
    {query && <>
      {(hits.length > 0 || suggestions.length > 0) && <p className="text-[11px] text-muted-foreground">↑ ↓ 선택 · Enter 열기 · Ctrl/⌘ Enter 나란히 열기</p>}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b pb-2 text-xs" aria-live="polite">
        <h2 className="min-w-0 break-words font-semibold">“{query}” 결과 {hits.length}건{search.hasNextPage ? '+' : ''}</h2>
        {metadata && <span className="text-muted-foreground">{metadata.mode === 'hybrid' ? '의미 + 키워드' : '키워드'}</span>}
        {(search.isFetching || suggest.isFetching) && <span role="status" className="inline-flex items-center gap-1 text-muted-foreground"><LoaderCircle aria-hidden="true" className="size-3 animate-spin" />검색 중…</span>}
      </div>
      {degraded && <p role="status" className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">{DEGRADED_REASONS[degraded.reason] ?? '의미 검색을 사용할 수 없어 키워드 결과를 표시합니다.'}</p>}
      {!suggestionsDismissed && <section id={`${id}-suggestions`} aria-label="제목 일치" aria-busy={suggest.isFetching} className={`space-y-1 ${suggest.isPlaceholderData ? 'opacity-60' : ''}`}>
        {suggest.isError && <><ErrorNotice error={suggest.error} /><Button variant="outline" size="sm" onClick={() => void suggest.refetch()}>제안 다시 불러오기</Button></>}
        {suggestions.length > 0 && <><h3 className="text-[11px] font-semibold text-muted-foreground">제목 일치</h3><ul className="divide-y border-y">
          {suggestions.map((item, index) => <li key={item.path} id={`${id}-option-${index}`} className={active === index ? 'bg-accent ring-1 ring-inset ring-ring' : ''}>
            <Link href={noteHref(item.path)} className="flex items-baseline gap-2 rounded-sm px-2 py-1.5 text-label-13 hover:bg-accent focus-visible:outline focus-visible:outline-ring" onClick={event => clickNote(event, item.path, null)}>
              <span className="min-w-0 flex-1 truncate font-medium">{item.title || item.path}</span><span className="max-w-[45%] truncate text-[11px] text-muted-foreground">{item.path}</span>
            </Link>
          </li>)}
        </ul></>}
      </section>}
      <section id={`${id}-results`} aria-label="검색 결과" className="space-y-2" aria-busy={search.isFetching}>
        {search.isError && !search.isFetchNextPageError && <><ErrorNotice error={search.error} /><Button variant="outline" size="sm" onClick={() => void search.refetch()}>검색 다시 시도</Button></>}
        {metadata && !hits.length && !search.isFetching && <EmptyState title="검색 결과가 없습니다" description="다른 표현을 사용하거나 필터를 줄여 보세요." />}
        <ul className={`divide-y ${!degraded && suggestions.length === 0 && !(suggest.isError && !suggestionsDismissed) && !(search.isError && !search.isFetchNextPageError) && hits.length > 0 ? 'border-b' : 'border-y'} ${search.isPlaceholderData ? 'opacity-60' : ''}`}>
          {hits.map((hit, index) => {
            const isActive = active === suggestions.length + index
            return <li key={`${hit.path}:${hit.anchor ?? hit.heading}:${index}`} id={`${id}-option-${suggestions.length + index}`} className={`group relative px-2 py-1.5 ${isActive ? 'bg-accent ring-1 ring-inset ring-ring' : 'hover:bg-accent'}`}>
              <Link href={noteHref(hit.path) + (hit.anchor ? `#${encodeURIComponent(hit.anchor)}` : '')} onClick={event => clickNote(event, hit.path, hit.anchor)} className="block space-y-0.5 rounded-sm pr-7 focus-visible:outline focus-visible:outline-ring">
                <div className="flex items-start gap-2"><span className="min-w-0 break-words text-label-13 font-semibold underline-offset-4 group-hover:underline">{hit.title || hit.path.split('/').pop()?.replace(/\.md$/i, '')}</span><Badge variant="outline" className="shrink-0 px-1.5 text-[10px]">{KIND_LABELS[hit.kind] ?? '노트'}</Badge></div>
                <p className="truncate text-[11px] text-muted-foreground" aria-label={`경로: ${hit.path}`}>{hit.path.split('/').join(' / ')}</p>
                {hit.heading && <p className="truncate text-xs font-medium">{hit.heading}</p>}
                <p className={`whitespace-pre-wrap break-words text-label-13 leading-5 text-muted-foreground ${compact ? 'line-clamp-2' : 'line-clamp-3'}`}>{excerptParts(hit.excerpt || hit.snippet, hit.highlights).map((part, partIndex) => part.marked ? <mark key={partIndex} className="rounded-sm bg-warning/15 px-0.5 text-foreground">{part.text}</mark> : part.text)}</p>
              </Link>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {hit.tags.map(tag => <Button key={tag} type="button" variant={selectedTags.includes(tag) ? 'default' : 'secondary'} size="xs"
                  aria-pressed={selectedTags.includes(tag)} title={`#${tag} 태그로 결과 좁히기`} aria-label={`#${tag} 태그로 결과 좁히기`}
                  className="h-auto min-h-6 max-w-full whitespace-normal text-left" onClick={() => toggleTag(tag)}><span className="min-w-0 break-all">#{tag}</span></Button>)}
                {hit.updatedAt && <time dateTime={hit.updatedAt} className="text-[11px] text-muted-foreground">수정 {formatDate(hit.updatedAt)}</time>}
              </div>
              <Button variant="ghost" size="icon-xs" aria-label={`${hit.title || hit.path} 나란히 열기`} title="나란히 열기" className={`absolute right-1 top-1 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 ${isActive ? 'opacity-100' : 'opacity-0'}`} onClick={() => open(hit.path, hit.anchor, true)}><Columns2 /></Button>
            </li>
          })}
        </ul>
        {search.isFetchNextPageError && <div className="space-y-2"><ErrorNotice error={search.error} /><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => void search.fetchNextPage()}>다음 결과 다시 시도</Button><Button variant="ghost" size="sm" onClick={() => void search.refetch()}>커서 만료 시 처음부터 검색</Button></div></div>}
        {search.isFetchingNextPage && <Loading label="다음 검색 결과를 불러오는 중" />}
        {search.hasNextPage && <>
          <div ref={sentinel} aria-hidden="true" className="h-1" />
          <Button className="w-full" variant="outline" size="sm" disabled={search.isFetching || search.isPlaceholderData} onClick={() => void search.fetchNextPage()}>결과 더 불러오기</Button>
          <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={autoLoad} onChange={event => setAutoLoad(event.target.checked)} />스크롤 시 자동으로 불러오기</label>
        </>}
      </section>
    </>}
  </div>
}
