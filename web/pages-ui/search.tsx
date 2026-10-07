'use client'

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowUpRight, Search } from 'lucide-react'
import { api } from '@/lib/api'
import { EmptyState, ErrorNotice, Loading, PageHeader, noteHref } from '@/components/common'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const KIND_LABELS: Record<string, string> = { wiki: '위키', journal: '일기', raw: '원문', other: '노트' }

export function SearchPage() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const query = (searchParams.get('q') ?? '').trim()
  const [draft, setDraft] = useState(query)
  useEffect(() => setDraft(query), [query])
  const search = useQuery({
    queryKey: ['search', query],
    queryFn: () => api.search(query),
    enabled: Boolean(query),
  })

  return (
    <div className="space-y-6">
      <PageHeader title="검색" description="키워드와 의미를 함께 검색해 관련 지식을 찾습니다." />
      <form
        className="space-y-2"
        role="search"
        onSubmit={(event) => {
          event.preventDefault()
          const nextQuery = draft.trim()
          if (!nextQuery) return
          if (nextQuery === query) {
            void search.refetch()
          } else {
            const next = new URLSearchParams(searchParams.toString())
            next.set('q', nextQuery)
            router.push(`/search?${next.toString()}`)
          }
        }}
      >
        <Label htmlFor="wiki-search">검색어</Label>
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="wiki-search"
              type="search"
              name="q"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="찾고 싶은 주제나 질문을 입력하세요"
              className="h-10 pl-9"
              required
            />
          </div>
          <Button type="submit" className="h-10 px-4" disabled={!draft.trim() || search.isFetching}>
            {search.isFetching ? '검색 중…' : '검색'}
          </Button>
        </div>
      </form>

      {!query && <EmptyState title="어떤 지식을 찾고 있나요?" description="주제, 키워드 또는 질문으로 지식 저장소를 검색하세요." />}
      {query && search.isPending && <Loading label="관련 지식을 검색하는 중" />}
      {query && search.isError && <ErrorNotice error={search.error} />}
      {query && search.data && (
        <section aria-label="검색 결과" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
            <h2 className="text-sm font-semibold">“{query}” 검색 결과</h2>
            <p className="text-sm text-muted-foreground" aria-live="polite">{search.data.hits.length}건</p>
          </div>
          {search.data.hits.length === 0 ? (
            <EmptyState title="검색 결과가 없습니다" description="다른 표현이나 더 넓은 주제의 키워드로 검색해 보세요." />
          ) : (
            <ul className="divide-y rounded-lg border">
              {search.data.hits.map((hit, index) => (
                <li key={`${hit.path}:${hit.heading}:${index}`} className="space-y-3 p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <Link href={noteHref(hit.path)} className="group inline-flex max-w-full items-center gap-1.5 text-base font-semibold underline-offset-4 hover:underline">
                        <span className="break-words">{hit.title || hit.path.split('/').pop()?.replace(/\.md$/i, '')}</span>
                        <ArrowUpRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                      </Link>
                      <p className="break-all text-xs text-muted-foreground">{hit.path}</p>
                    </div>
                    <Badge variant="outline">{KIND_LABELS[hit.kind] ?? '노트'}</Badge>
                  </div>
                  {hit.heading && <p className="text-sm font-medium">{hit.heading}</p>}
                  <p className="whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground">{hit.snippet}</p>
                  {hit.related.length > 0 && (
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
                      <span className="text-muted-foreground">관련 노트</span>
                      {[...new Set(hit.related)].map((related) => (
                        <Link key={related} href={noteHref(related)} title={related} className="break-words underline underline-offset-4 hover:text-muted-foreground">
                          {related.split('/').pop()?.replace(/\.md$/i, '') || related}
                        </Link>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}
