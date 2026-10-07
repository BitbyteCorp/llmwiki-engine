'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { PageHeader } from '@/components/common'
import { Button } from '@/components/ui/button'
import { SearchExperience } from '@/components/search/search-experience'
import { readSearchState, searchHref, searchParams } from '@/components/search/search-state'

export function SearchPage() {
  const params = useSearchParams()
  const router = useRouter()
  const location = params.toString()
  const [value, setValue] = useState(() => readSearchState(params))
  const [composing, setComposing] = useState(false)

  useEffect(() => {
    const next = readSearchState(new URLSearchParams(location))
    setValue(previous => searchParams(previous).toString() === searchParams(next).toString() ? previous : next)
  }, [location])

  useEffect(() => {
    if (composing) return
    const current = searchParams(readSearchState(new URLSearchParams(location))).toString()
    if (searchParams(value).toString() === current) return
    const timer = window.setTimeout(() => router.push(searchHref(value), { scroll: false }), 300)
    return () => window.clearTimeout(timer)
  }, [value, location, router, composing])

  return <div className="space-y-6">
    <PageHeader title="검색" description="키워드와 의미를 함께 검색해 관련 지식을 찾습니다." actions={<nav aria-label="지식 탐색" className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/graph" />}>지식 그래프</Button>
      <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/tags" />}>태그 탐색</Button>
      <Button variant="outline" size="sm" nativeButton={false} render={<Link href="/search/duplicates" />}>중복 노트</Button>
    </nav>} />
    <SearchExperience value={value} onChange={setValue} onCompositionChange={setComposing} />
  </div>
}
