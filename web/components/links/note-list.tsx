'use client'

import Link from 'next/link'
import { Columns2 } from 'lucide-react'
import { noteHref } from '@/components/common'
import { Button } from '@/components/ui/button'
import { useWorkspace } from '@/components/workspace/context'
import { setNoteDragData } from '@/components/workspace/dnd'

type NoteSummary = { path: string; title: string; score?: number }

export function KnowledgeNoteList({ notes }: { notes: NoteSummary[] }) {
  const { openNote } = useWorkspace()
  return <ul className="divide-y overflow-hidden border-y">
    {notes.map(note => <li key={note.path} className="flex min-w-0 items-start gap-2 px-2 py-1.5">
      <Link href={noteHref(note.path)} draggable onDragStart={event => setNoteDragData(event, note.path, { title: note.title })} onNavigate={event => { event.preventDefault(); openNote(note.path) }} className="min-w-0 flex-1 rounded text-label-13 hover:text-primary focus-visible:outline-2 focus-visible:outline-ring">
        <span className="block break-words font-medium">{note.title || note.path}</span>
        <span className="block break-all text-xs text-muted-foreground">{note.path}</span>
        {note.score !== undefined && <span className="block text-xs text-muted-foreground">의미 유사도 {note.score.toFixed(3)}</span>}
      </Link>
      <Button variant="ghost" size="icon-sm" title="옆 그룹에 열기" aria-label={`${note.title || note.path} 옆 그룹에 열기`} onClick={() => openNote(note.path, { group: 'side' })}><Columns2 aria-hidden="true" /></Button>
    </li>)}
  </ul>
}
