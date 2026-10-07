'use client'

import Link from 'next/link'
import { TagsDirectory } from './tags-view'

export function TagsPanel() {
  return <div className="h-full min-h-0 space-y-4 overflow-y-auto overscroll-contain p-3">
    <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-bold">태그</h2><Link href="/tags" className="rounded text-xs underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">전체 보기</Link></div>
    <TagsDirectory compact />
  </div>
}
