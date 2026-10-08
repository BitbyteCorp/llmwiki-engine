'use client'

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { Columns2, RefreshCw } from 'lucide-react'
import { api } from '@/lib/api'
import type { CatalogNote, DuplicatePair } from '@/lib/api'
import { EmptyState, ErrorNotice, Loading, PageHeader, noteHref } from '@/components/common'
import { useWorkspace } from '@/components/workspace/context'
import { useViewLocation } from '@/components/workspace/view-location'
import { setNoteDragData } from '@/components/workspace/dnd'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

function Passage({ note, passage }: { note: CatalogNote; passage: DuplicatePair['passages'][number]['left'] }) {
  const workspace = useWorkspace()
  const { groupId } = useViewLocation()
  return <div className="min-w-0 space-y-1 border-l pl-2">
    <Link href={noteHref(note.path) + (passage.anchor ? `#${encodeURIComponent(passage.anchor)}` : '')} draggable onDragStart={event => setNoteDragData(event, note.path, { title: note.title })} onClick={event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      workspace.openNote(note.path, { group: groupId, fragment: passage.anchor ?? undefined })
    }} className="break-words text-label-13 font-medium underline underline-offset-4">{note.title || note.path}{passage.anchor ? ` · #${passage.anchor}` : ''}</Link>
    <p className="whitespace-pre-wrap break-words text-label-13 leading-5">{passage.excerpt || '비교할 구절이 제공되지 않았습니다.'}</p>
  </div>
}

export function DuplicatesPage() {
  const workspace = useWorkspace()
  const { groupId } = useViewLocation()
  const duplicates = useQuery({ queryKey: ['duplicates'], queryFn: ({ signal }) => api.duplicates(signal) })
  function compare(pair: DuplicatePair, passage = pair.passages[0]) {
    workspace.openNote(pair.left.path, { pin: true, group: groupId, fragment: passage?.left.anchor ?? undefined })
    workspace.openNote(pair.right.path, { pin: true, group: 'side', fragment: passage?.right.anchor ?? undefined })
  }

  return <div className="space-y-4">
    <PageHeader title="중복 후보" description="정규화된 내용이 같거나 의미가 매우 가까운 노트를 읽기 전용으로 비교합니다. 자동으로 합치거나 삭제하지 않습니다." actions={<Button variant="outline" onClick={() => void duplicates.refetch()} disabled={duplicates.isFetching}><RefreshCw aria-hidden="true" className={duplicates.isFetching ? 'animate-spin motion-reduce:animate-none' : ''} />새로고침</Button>} />
    {duplicates.isPending && <Loading label="중복 후보를 찾는 중" />}
    {duplicates.isError && <div className="space-y-2"><ErrorNotice error={duplicates.error} /><Button variant="outline" onClick={() => void duplicates.refetch()} disabled={duplicates.isFetching}>다시 시도</Button></div>}
    {duplicates.data && (duplicates.data.length === 0 ? <EmptyState title="중복 후보가 없습니다" description="현재 색인에서 내용이 같거나 의미 유사도가 높은 노트 쌍을 찾지 못했습니다. 의미 기반 후보는 임베딩이 준비된 노트만 포함합니다." /> : <section aria-label="중복 후보 목록" className="space-y-2">
      <div className="space-y-1"><p aria-live="polite" className="text-label-13 font-medium">{duplicates.data.length}쌍 · 최대 100쌍 표시</p><p className="text-xs text-muted-foreground">점수는 후보 유사도이며 중복 여부의 확정 판정이 아닙니다. 비교를 누르면 왼쪽 노트가 고정 탭으로 열리고 오른쪽 노트는 분할 화면에 열립니다.</p></div>
      <div className="divide-y border-y">{duplicates.data.map(pair => <article key={`${pair.left.path}:${pair.right.path}`} className="space-y-2 px-2 py-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2"><Badge variant={pair.reason === 'exact' ? 'default' : 'secondary'}>{pair.reason === 'exact' ? '정확히 일치' : '의미 유사'}</Badge><span className="text-label-13 tabular-nums">유사도 {(pair.score * 100).toFixed(2)}%</span></div>
          <Button variant="outline" onClick={() => compare(pair)} aria-label={`${pair.left.title || pair.left.path}와 ${pair.right.title || pair.right.path} 분할 비교`}><Columns2 aria-hidden="true" />비교</Button>
        </div>
        <p className="text-xs text-muted-foreground">{pair.reason === 'exact' ? '정규화된 내용 해시가 같은 노트입니다. 서식 차이는 있을 수 있습니다.' : '노트 임베딩의 코사인 유사도가 0.98 이상인 후보입니다. 아래 구절과 원문을 확인하세요.'}</p>
        <div className="grid gap-x-6 gap-y-1.5 md:grid-cols-2">{[pair.left, pair.right].map((note, index) => <div key={note.path} className="min-w-0 space-y-0.5"><div className="flex flex-wrap items-baseline gap-x-2"><p className="text-xs text-muted-foreground">{index === 0 ? '왼쪽 노트' : '오른쪽 노트'}</p><Link href={noteHref(note.path)} draggable onDragStart={event => setNoteDragData(event, note.path, { title: note.title })} onClick={event => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); workspace.openNote(note.path, { group: groupId }) } }} className="break-words text-label-13 font-semibold underline-offset-4 hover:underline">{note.title || note.path}</Link></div><p className="break-all text-xs text-muted-foreground">{note.path}</p></div>)}</div>
        {pair.passages.length === 0 ? <p className="text-label-13 text-muted-foreground">일치 구절이 제공되지 않았습니다. 비교로 두 노트의 원문을 확인하세요.</p> : <div className="space-y-2">{pair.passages.map((passage, index) => <section key={index} aria-label={`일치 구절 ${index + 1}`} className="space-y-1.5"><div className="grid items-stretch gap-2 md:grid-cols-2"><Passage note={pair.left} passage={passage.left} /><Passage note={pair.right} passage={passage.right} /></div>{pair.passages.length > 1 && <Button variant="ghost" size="sm" onClick={() => compare(pair, passage)}>이 구절부터 비교</Button>}</section>)}</div>}
      </article>)}</div>
    </section>)}
  </div>
}
