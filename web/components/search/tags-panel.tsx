'use client'

import Link from 'next/link'
import { TagsDirectory } from './tags-view'

export function TagsPanel() {
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 px-3"><h2 className="text-xs font-semibold text-muted-foreground">태그</h2><Link href="/tags" className="rounded text-xs underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">전체 보기</Link></div>
    <div className="min-h-0 flex-1 overflow-auto overscroll-contain px-2 pb-2">
    <TagsDirectory compact />
    </div>
  </div>
}
