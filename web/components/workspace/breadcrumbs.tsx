'use client'

import { ChevronRight } from 'lucide-react'
import { useWorkspace } from '@/components/workspace/context'

export function Breadcrumbs({ path, title }: { path: string; title: string }) {
  const { revealFolder } = useWorkspace()
  const folders = path.split('/').slice(0, -1)
  return (
    <nav aria-label="노트 경로" className="min-w-0 text-xs text-muted-foreground">
      <ol className="flex flex-wrap items-center gap-1">
        <li><button type="button" onClick={() => revealFolder('')} className="rounded px-1 py-1 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">위키</button></li>
        {folders.map((folder, index) => (
          <li key={folders.slice(0, index + 1).join('/')} className="flex min-w-0 items-center gap-1">
            <ChevronRight aria-hidden="true" className="size-3 shrink-0" />
            <button type="button" onClick={() => revealFolder(folders.slice(0, index + 1).join('/'))} className="break-all rounded px-1 py-1 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">{folder}</button>
          </li>
        ))}
        <li className="flex min-w-0 items-center gap-1"><ChevronRight aria-hidden="true" className="size-3 shrink-0" /><span aria-current="page" className="break-words px-1 text-foreground">{title}</span></li>
      </ol>
    </nav>
  )
}
