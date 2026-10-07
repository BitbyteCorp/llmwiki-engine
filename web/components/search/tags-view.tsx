'use client'

import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, Hash } from 'lucide-react'
import { api } from '@/lib/api'
import { EmptyState, ErrorNotice, Loading, PageHeader } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { KnowledgeNoteList } from '@/components/links/note-list'

export function TagsDirectory({ compact = false }: { compact?: boolean }) {
  const [filter, setFilter] = useState('')
  const filterId = useId()
  const tags = useQuery({ queryKey: ['tags'], queryFn: ({ signal }) => api.tags(signal) })
  const normalizedFilter = filter.normalize('NFKC').toLowerCase().trim().replace(/^#+/, '').replace(/\s+/g, '-')
  const visible = tags.data?.filter(item => item.tag.includes(normalizedFilter)) ?? []

  return <div className="space-y-4">
    <div className="space-y-2">
      <Label htmlFor={filterId}>태그 필터</Label>
      <Input id={filterId} type="search" value={filter} onChange={event => setFilter(event.target.value)} placeholder="태그 이름으로 찾기" />
    </div>
    {tags.isPending && <Loading label="태그를 불러오는 중" />}
    {tags.isError && <div className="space-y-2"><ErrorNotice error={tags.error} /><Button variant="outline" disabled={tags.isFetching} onClick={() => void tags.refetch()}>태그 다시 시도</Button></div>}
    {tags.data && <>
      <p aria-live="polite" className="text-xs text-muted-foreground">{visible.length}개 태그{normalizedFilter ? ` · 전체 ${tags.data.length}개` : ''} · 숫자는 태그가 포함된 노트 수입니다.</p>
      {visible.length ? <ul className={compact ? 'divide-y rounded-lg border' : 'grid gap-3 sm:grid-cols-2 lg:grid-cols-3'}>
        {visible.map(({ tag, count }) => <li key={tag}>
          <Link href={`/tags/${encodeURIComponent(tag)}`} className={`flex h-full items-center justify-between gap-3 rounded-lg p-3 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring ${compact ? '' : 'border'}`}>
            <span className="flex min-w-0 items-start gap-1.5"><Hash aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><span className="break-all font-medium">{tag}</span></span>
            <span className="shrink-0 rounded bg-muted px-2 py-0.5 text-xs tabular-nums" aria-label={`${count}개 노트`}>{count}</span>
          </Link>
        </li>)}
      </ul> : <EmptyState title={tags.data.length ? '일치하는 태그가 없습니다' : '아직 태그가 없습니다'} description={tags.data.length ? '필터를 바꾸거나 지우고 다시 확인하세요.' : '노트의 frontmatter에 tags를 추가하면 색인이 갱신된 뒤 표시됩니다.'} />}
    </>}
  </div>
}

export function TagsPage() {
  return <div className="space-y-6"><PageHeader title="태그" description="태그별로 노트를 모아 보고 지식 저장소의 주제를 탐색합니다." /><TagsDirectory /></div>
}

export function TagNotesPage() {
  const { tag: encodedTag } = useParams<{ tag: string }>()
  let tag = encodedTag ?? ''
  try { tag = decodeURIComponent(tag) } catch { /* Keep malformed URL text readable without crashing the page. */ }
  const notes = useQuery({ queryKey: ['tags', 'notes', tag], queryFn: ({ signal }) => api.tagNotes(tag, signal), enabled: Boolean(tag) })

  return <div className="space-y-6">
    <PageHeader title={<span className="break-all">#{tag}</span>} description="이 태그가 포함된 노트입니다." actions={<Button variant="outline" nativeButton={false} render={<Link href="/tags" />}><ArrowLeft aria-hidden="true" />모든 태그</Button>} />
    {notes.isPending && <Loading label="태그의 노트를 불러오는 중" />}
    {notes.isError && <div className="space-y-3"><ErrorNotice error={notes.error} /><Button variant="outline" disabled={notes.isFetching} onClick={() => void notes.refetch()}>노트 다시 시도</Button></div>}
    {notes.data && <section aria-label="태그 노트" className="space-y-3">
      <p aria-live="polite" className="text-sm text-muted-foreground">{notes.data.length}개 노트</p>
      {notes.data.length ? <KnowledgeNoteList notes={notes.data} /> : <EmptyState title="이 태그가 포함된 노트가 없습니다" description="태그가 변경되었거나 색인이 갱신되는 중일 수 있습니다. 다른 태그를 선택해 보세요." />}
    </section>}
  </div>
}
