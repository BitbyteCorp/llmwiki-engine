'use client'

import Link from 'next/link'
import { Columns2 } from 'lucide-react'
import { noteHref } from '@/components/common'
import { Button } from '@/components/ui/button'
import { useWorkspace } from '@/components/workspace/context'

type NoteSummary = { path: string; title: string; score?: number }

export function KnowledgeNoteList({ notes }: { notes: NoteSummary[] }) {
  const { openNote, activePath, recentPaths } = useWorkspace()
  return <ul className="divide-y rounded-lg border">
    {notes.map(note => <li key={note.path} className="flex min-w-0 items-start gap-1 p-2">
      <Link href={noteHref(note.path)} onNavigate={event => { event.preventDefault(); openNote(note.path) }} className="min-w-0 flex-1 rounded px-1 py-1 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
        <span className="block break-words font-medium">{note.title || note.path}</span>
        <span className="block break-all text-xs text-muted-foreground">{note.path}</span>
        {note.score !== undefined && <span className="block text-xs text-muted-foreground">의미 유사도 {note.score.toFixed(3)}</span>}
      </Link>
      <Button variant="ghost" size="icon-sm" title="분할 보기로 열기" aria-label={`${note.title || note.path} 분할 보기로 열기`} onClick={() => { if (!activePath) openNote(recentPaths[0] ?? note.path, { pin: true }); openNote(note.path, { split: true }) }}><Columns2 aria-hidden="true" /></Button>
    </li>)}
  </ul>
}
