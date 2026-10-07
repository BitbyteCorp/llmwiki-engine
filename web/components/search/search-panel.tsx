'use client'

import { useState } from 'react'
import Link from 'next/link'
import { SearchExperience } from './search-experience'
import { searchHref, type SearchState } from './search-state'

export function SearchPanel() {
  const [value, setValue] = useState<SearchState>({ q: '', filters: {} })
  return <div className="h-full min-h-0 space-y-4 overflow-y-auto p-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-bold">검색</h2><Link href={searchHref(value)} className="text-xs underline underline-offset-4">전체 화면</Link></div>
    <SearchExperience value={value} onChange={setValue} compact />
    <nav aria-label="지식 탐색" className="flex flex-wrap gap-3 text-xs">
      <Link href="/graph" className="underline underline-offset-4">그래프</Link>
      <Link href="/tags" className="underline underline-offset-4">태그</Link>
      <Link href="/search/duplicates" className="underline underline-offset-4">중복 노트</Link>
    </nav>
  </div>
}
