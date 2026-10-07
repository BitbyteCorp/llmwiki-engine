'use client'

import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Share2, Trash2, X } from 'lucide-react'
import { api, request } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ErrorNotice, Loading } from '@/components/common'

export type ConversationRole = 'owner' | 'editor' | 'viewer'
export interface ConversationMember { userId: number; email: string; name: string | null; role: ConversationRole }
const roleLabels = { owner: '소유자', editor: '편집자', viewer: '조회자' }

export function useConversationMembers(id: string, enabled = true) {
  return useQuery({ queryKey: ['conversation-members', id], queryFn: ({ signal }) => request<{ members: ConversationMember[] }>(`/api/conversations/${encodeURIComponent(id)}/members`, { signal }), enabled })
}

export function ConversationSharing({ id }: { id: string }) {
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'editor' | 'viewer'>('viewer')
  const dialog = useRef<HTMLDialogElement>(null)
  const client = useQueryClient()
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  const members = useConversationMembers(id, open)
  const owner = members.data?.members.some(member => member.userId === me.data?.user.id && member.role === 'owner') ?? false
  const change = useMutation({
    mutationFn: async (input: { email: string; role: 'editor' | 'viewer' } | { userId: number }) => {
      const url = `/api/conversations/${encodeURIComponent(id)}/members`
      if ('userId' in input) await request<void>(`${url}/${input.userId}`, { method: 'DELETE' })
      else await request<{ members: ConversationMember[] }>(url, { method: 'POST', body: JSON.stringify(input) })
    },
    onSuccess: (_, input) => {
      if ('email' in input) setEmail('')
      void client.invalidateQueries({ queryKey: ['conversation-members', id] })
      void client.invalidateQueries({ queryKey: ['conversations'] })
    },
  })
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const element = dialog.current
    element?.showModal()
    return () => { element?.close(); previous?.focus() }
  }, [open])
  useEffect(() => { setOpen(false); setEmail('') }, [id])
  return <>
    <Button variant="outline" size="sm" onClick={() => { change.reset(); setOpen(true) }}><Share2 className="size-4" />공유</Button>
    {open && <dialog ref={dialog} aria-labelledby="conversation-sharing-title" className="workspace-dialog max-h-[85dvh] w-[min(32rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border bg-popover p-5 text-popover-foreground shadow-xl" onCancel={event => { event.preventDefault(); setOpen(false) }}>
      <div className="mb-4 flex items-center justify-between gap-3"><h2 id="conversation-sharing-title" className="font-semibold">대화 공유</h2><Button variant="ghost" size="icon-sm" aria-label="공유 닫기" onClick={() => setOpen(false)}><X className="size-4" /></Button></div>
      <p className="mb-4 text-sm text-muted-foreground">초대한 구성원만 이 대화를 볼 수 있습니다. 편집자는 질문과 제목을 변경할 수 있습니다.</p>
      <ErrorNotice error={members.error || me.error || change.error} />
      {(members.isPending || me.isPending) ? <Loading /> : members.data && <>
        <ul className="divide-y" aria-label="대화 구성원">{members.data.members.map(member => <li key={member.userId} className="flex items-center gap-3 py-3">
          <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{member.name || member.email}</p>{member.name && <p className="truncate text-xs text-muted-foreground">{member.email}</p>}</div>
          <span className="text-xs text-muted-foreground">{roleLabels[member.role]}</span>
          {owner && member.role !== 'owner' && <Button variant="ghost" size="icon-sm" disabled={change.isPending} aria-label={`${member.email} 구성원 제거`} onClick={() => change.mutate({ userId: member.userId })}><Trash2 className="size-4" /></Button>}
        </li>)}</ul>
        {owner ? <form className="mt-4 space-y-3 border-t pt-4" onSubmit={event => { event.preventDefault(); if (email.trim()) change.mutate({ email: email.trim(), role }) }}>
          <label className="block space-y-1 text-sm"><span>초대할 이메일</span><Input type="email" autoComplete="email" required value={email} disabled={change.isPending} onChange={event => setEmail(event.target.value)} placeholder="name@example.com" /></label>
          <div className="flex flex-wrap items-end gap-2"><label className="flex-1 space-y-1 text-sm"><span className="block">대화 권한</span><select className="h-9 w-full rounded-md border bg-background px-3" value={role} disabled={change.isPending} onChange={event => setRole(event.target.value as 'editor' | 'viewer')}><option value="viewer">조회자 — 읽기만</option><option value="editor">편집자 — 질문·편집</option></select></label><Button type="submit" disabled={change.isPending || !email.trim()}>{change.isPending ? '변경 중…' : '추가 / 권한 변경'}</Button></div>
          <p className="text-xs text-muted-foreground">등록된 사용자만 초대할 수 있습니다. 이미 있는 구성원은 권한이 변경됩니다.</p>
        </form> : <p className="mt-4 text-xs text-muted-foreground">구성원 변경은 대화 소유자만 할 수 있습니다.</p>}
      </>}
      {(members.isError || me.isError) && <Button className="mt-3" variant="outline" onClick={() => { void members.refetch(); void me.refetch() }}>다시 시도</Button>}
    </dialog>}
  </>
}
