'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Pencil, Plus, Search, Trash2, Users, X } from 'lucide-react'
import { request } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ErrorNotice, Loading } from '@/components/common'
import { confirmEditorLeave } from '@/components/editor/state'
import { useConversationMembers, type ConversationRole } from './sharing'

export interface ConversationThread { id: string; title: string; createdAt: string; updatedAt: string; role?: ConversationRole; snippet?: string }

function ThreadRow({ thread, active, onDelete, onSelect }: { thread: ConversationThread; active: boolean; onDelete(thread: ConversationThread): void; onSelect?: (id: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(thread.title)
  const client = useQueryClient()
  const members = useConversationMembers(thread.id, thread.role === 'owner')
  const shared = thread.role === 'editor' || thread.role === 'viewer' || (members.data?.members.length ?? 0) > 1
  const rename = useMutation({
    mutationFn: () => request<{ conversation: ConversationThread }>(`/api/conversations/${encodeURIComponent(thread.id)}`, { method: 'PATCH', body: JSON.stringify({ title: title.trim() }) }),
    onSuccess: () => {
      setEditing(false)
      void client.invalidateQueries({ queryKey: ['conversations'] })
      void client.invalidateQueries({ queryKey: ['conversation', thread.id] })
    },
  })
  return <li className={`px-2 py-1.5 ${active ? 'bg-accent' : 'hover:bg-accent'}`}>
    {editing ? <form className="space-y-2" onSubmit={event => { event.preventDefault(); if (title.trim()) rename.mutate() }}>
      <Input autoFocus aria-label="대화 제목" maxLength={200} value={title} disabled={rename.isPending} onChange={event => setTitle(event.target.value)} onKeyDown={event => { if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) { if (event.key === 'Enter') event.preventDefault(); return } if (event.key === 'Escape') { event.preventDefault(); setEditing(false) } }} />
      <div className="flex justify-end gap-1"><Button type="submit" size="icon-sm" disabled={rename.isPending || !title.trim()} aria-label="제목 저장"><Check className="size-4" /></Button><Button type="button" variant="ghost" size="icon-sm" disabled={rename.isPending} aria-label="이름 변경 취소" onClick={() => setEditing(false)}><X className="size-4" /></Button></div>
      <ErrorNotice error={rename.error} />
    </form> : <>
      <div className="flex items-start gap-1">{onSelect ? <button className="min-w-0 flex-1 rounded text-left text-label-13 font-medium focus-visible:outline focus-visible:outline-ring" aria-current={active ? 'page' : undefined} onClick={() => onSelect(thread.id)}><span className="line-clamp-1 break-words">{thread.title || '새 대화'}</span></button> : <Link className="min-w-0 flex-1 rounded text-label-13 font-medium focus-visible:outline focus-visible:outline-ring" aria-current={active ? 'page' : undefined} href={`/chat/${encodeURIComponent(thread.id)}`} onClick={event => { if (!event.metaKey && !event.ctrlKey && !confirmEditorLeave()) { event.preventDefault(); return } window.dispatchEvent(new Event('workspace-navigation')) }}><span className="line-clamp-1 break-words">{thread.title || '새 대화'}</span></Link>}
        {(thread.role === 'owner' || thread.role === 'editor') && <Button variant="ghost" size="icon-xs" aria-label={`${thread.title || '새 대화'} 이름 변경`} onClick={() => { setTitle(thread.title); rename.reset(); setEditing(true) }}><Pencil className="size-3" /></Button>}
        {thread.role === 'owner' && <Button variant="ghost" size="icon-xs" aria-label={`${thread.title || '새 대화'} 삭제`} onClick={() => onDelete(thread)}><Trash2 className="size-3" /></Button>}
      </div>
      <div className="mt-0.5 flex items-center gap-x-2 text-xs text-muted-foreground">{thread.snippet && <span className="min-w-0 flex-1 line-clamp-1 break-words">{thread.snippet}</span>}<time className="shrink-0" dateTime={thread.updatedAt}>{new Date(thread.updatedAt).toLocaleDateString('ko-KR')}</time>{shared && <span className="inline-flex shrink-0 items-center gap-1" title={thread.role === 'viewer' ? '공유 대화 · 조회자' : thread.role === 'editor' ? '공유 대화 · 편집자' : '공유 대화 · 소유자'}><Users className="size-3" />공유{thread.role === 'viewer' ? ' · 읽기 전용' : ''}</span>}</div>
    </>}
  </li>
}

export function ThreadsPanel({ activeId, onSelect, onNew, onDeleted, focusSearch = false }: { userId?: number; activeId?: string; onSelect?: (id: string) => void; onNew?: () => void; onDeleted?: (id: string) => void; focusSearch?: boolean } = {}) {
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [deleting, setDeleting] = useState<ConversationThread | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const pathname = usePathname()
  const params = useSearchParams()
  const router = useRouter()
  const client = useQueryClient()
  useEffect(() => { const timer = setTimeout(() => setSearch(query.trim()), 200); return () => clearTimeout(timer) }, [query])
  useEffect(() => { if (focusSearch || (!onSelect && params.get('search') === '1')) searchInput.current?.focus() }, [params, focusSearch, onSelect])
  const list = useQuery({ queryKey: ['conversations', search], queryFn: ({ signal }) => request<{ conversations: ConversationThread[] }>(`/api/conversations${search ? `?q=${encodeURIComponent(search)}` : ''}`, { signal }) })
  const remove = useMutation({
    mutationFn: (id: string) => request<void>(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: (_, id) => {
      setDeleting(null)
      client.removeQueries({ queryKey: ['conversation', id] })
      client.removeQueries({ queryKey: ['conversation-members', id] })
      void client.invalidateQueries({ queryKey: ['conversations'] })
      if (onDeleted) onDeleted(id)
      else if (pathname === `/chat/${encodeURIComponent(id)}`) router.push('/chat')
    },
  })
  useEffect(() => {
    if (!deleting) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const element = dialog.current
    element?.showModal()
    return () => { element?.close(); previous?.isConnected && previous.focus() }
  }, [deleting])
  return <section className="space-y-2 px-2 pb-2" aria-label="대화 목록">
    <div className="flex h-7 items-center justify-between gap-1.5 border-b px-1"><h2 className="text-label-13 font-semibold">대화 기록</h2><Button variant="ghost" size="icon-sm" aria-label="새 대화" onClick={() => { if (onNew) onNew(); else if (confirmEditorLeave()) router.push('/chat?new=1') }}><Plus className="size-3.5" /></Button></div>
    <label className="relative block"><Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-muted-foreground" /><Input ref={searchInput} className="h-8 pl-8" type="search" aria-label="대화 제목과 메시지 검색" placeholder="대화 검색" value={query} onChange={event => setQuery(event.target.value)} /></label>
    {list.isPending ? <Loading label="대화를 불러오는 중…" /> : list.isError ? <div className="space-y-2"><ErrorNotice error={list.error} /><Button variant="outline" size="sm" onClick={() => void list.refetch()}>다시 시도</Button></div> : <>
      <p role="status" className="text-xs text-muted-foreground">{list.data?.conversations.length ? `${list.data.conversations.length}개 대화` : search ? '검색 결과가 없습니다.' : '아직 대화가 없습니다.'}</p>
      <ul className="divide-y border-y">{list.data?.conversations.map(thread => <ThreadRow key={thread.id} thread={thread} active={activeId ? activeId === thread.id : !onSelect && pathname === `/chat/${encodeURIComponent(thread.id)}`} onSelect={onSelect} onDelete={thread => { remove.reset(); setDeleting(thread) }} />)}</ul>
    </>}
    {deleting && <dialog ref={dialog} aria-labelledby="conversation-delete-title" className="workspace-dialog w-[min(28rem,calc(100vw-2rem))] rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg" onCancel={event => { event.preventDefault(); if (!remove.isPending) setDeleting(null) }}>
      <h2 id="conversation-delete-title" className="text-label-13 font-semibold">대화를 삭제하시겠습니까?</h2><p className="my-3 break-words text-label-13 text-muted-foreground">“{deleting.title || '새 대화'}”의 모든 메시지가 삭제됩니다. 공유 구성원도 더 이상 볼 수 없으며 되돌릴 수 없습니다.</p>
      <ErrorNotice error={remove.error} /><div className="mt-3 flex justify-end gap-2"><Button autoFocus variant="outline" disabled={remove.isPending} onClick={() => setDeleting(null)}>취소</Button><Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate(deleting.id)}>{remove.isPending ? '삭제 중…' : '대화 삭제'}</Button></div>
    </dialog>}
  </section>
}
