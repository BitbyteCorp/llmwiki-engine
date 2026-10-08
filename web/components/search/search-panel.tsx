'use client'

import { useState } from 'react'
import Link from 'next/link'
import { SearchExperience } from './search-experience'
import { searchHref, type SearchState } from './search-state'

export function SearchPanel() {
  const [value, setValue] = useState<SearchState>({ q: '', filters: {} })
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 px-3"><h2 className="text-xs font-semibold text-muted-foreground">검색</h2><Link href={searchHref(value)} className="rounded text-xs underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">전체 화면</Link></div>
    <div className="min-h-0 flex-1 space-y-2 overflow-auto overscroll-contain px-2 pb-2">
    <SearchExperience value={value} onSubmit={setValue} compact />
    <nav aria-label="지식 탐색" className="flex flex-wrap gap-2 text-xs">
      <Link href="/graph" className="underline underline-offset-4">그래프</Link>
      <Link href="/tags" className="underline underline-offset-4">태그</Link>
      <Link href="/search/duplicates" className="underline underline-offset-4">중복 노트</Link>
    </nav>
    </div>
  </div>
}
