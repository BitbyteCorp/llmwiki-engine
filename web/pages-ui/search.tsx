'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { useViewLocation } from '@/components/workspace/view-location'
import { PageHeader } from '@/components/common'
import { Button } from '@/components/ui/button'
import { SearchExperience } from '@/components/search/search-experience'
import { readSearchState, searchHref, searchParams } from '@/components/search/search-state'

export function SearchPage() {
  const { groupId, searchParams: params, push } = useViewLocation()
  const value = useMemo(() => readSearchState(params), [params])

  function submit(next: typeof value) {
    if (searchParams(next).toString() === searchParams(value).toString()) return
    push(searchHref(next))
  }

  return <div className="space-y-4">
    <PageHeader title="검색" description="키워드와 의미를 함께 검색해 관련 지식을 찾습니다." actions={<nav aria-label="지식 탐색" className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/graph" />}>지식 그래프</Button>
      <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/tags" />}>태그 탐색</Button>
      <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/search/duplicates" />}>중복 노트</Button>
    </nav>} />
    <SearchExperience value={value} onSubmit={submit} groupId={groupId} />
  </div>
}
