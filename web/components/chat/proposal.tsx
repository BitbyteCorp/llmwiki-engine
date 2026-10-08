'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { X, RefreshCw } from 'lucide-react'
import { api, ApiError, request } from '@/lib/api'
import { ErrorNotice, Loading, noteHref } from '@/components/common'
import { DiffView } from '@/components/history/diff-view'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { notify } from '@/components/notifications'

export interface NoteProposal { path: string; baseSha: string; original: string | null; proposed: string }

export function ChatProposal({ conversationId, messageId, mode, onClose }: {
  conversationId: string
  messageId: string
  mode: 'new' | 'edit'
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const prefix = useId()
  const [path, setPath] = useState('')
  const [proposal, setProposal] = useState<NoteProposal | null>(null)
  const [content, setContent] = useState('')
  const [saved, setSaved] = useState<{ path: string; jobId: string; mergeSha: string } | null>(null)
  const tree = useQuery({ queryKey: ['notes/tree'], queryFn: api.tree, enabled: mode === 'edit' })
  const draft = useMutation({
    mutationFn: (target: string) => request<NoteProposal>(`/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/proposal`, { method: 'POST', body: JSON.stringify({ mode, ...(target.trim() ? { path: target.trim() } : {}) }) }),
    onSuccess: result => { setProposal(result); setPath(result.path); setContent(result.proposed); setSaved(null); save.reset() },
  })
  const save = useMutation({
    mutationFn: () => {
      if (!proposal) throw new Error('먼저 초안을 생성하세요.')
      return request<{ jobId: string; mergeSha: string }>('/api/notes', { method: 'PUT', body: JSON.stringify({ path: path.trim(), content, baseSha: proposal.baseSha, create: mode === 'new' }) })
    },
    onSuccess: result => {
      setSaved({ ...result, path: path.trim() })
      notify({ title: '노트가 저장되었습니다.', description: path.trim(), tone: 'success', action: {label: '노트 열기', href: noteHref(path.trim())} })
      void queryClient.invalidateQueries({ queryKey: ['notes/content', path.trim()] })
      void queryClient.invalidateQueries({ queryKey: ['notes/tree'] })
      void queryClient.invalidateQueries({ queryKey: ['history'] })
      void queryClient.invalidateQueries({ queryKey: ['jobs'] })
    },
  })
  const busy = draft.isPending || save.isPending
  const busyRef = useRef(busy)
  busyRef.current = busy
  const stale = save.error instanceof ApiError && save.error.status === 409
  const results = tree.data?.files.filter(file => file.toLocaleLowerCase().includes(path.toLocaleLowerCase())) ?? []
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const element = dialog.current
    element?.showModal()
    input.current?.focus()
    return () => { element?.close(); previousFocus?.focus() }
  }, [])
  function updatePath(value: string) {
    setPath(value)
    setSaved(null)
    save.reset()
    if (mode === 'edit') { setProposal(null); setContent(''); draft.reset() }
  }
  function propose() {
    if (proposal && content !== proposal.proposed && !window.confirm('초안을 다시 만들면 직접 편집한 내용이 교체됩니다. 계속하시겠습니까?')) return
    draft.mutate(path)
  }
  return <dialog ref={dialog} aria-labelledby={`${prefix}-title`} aria-describedby={`${prefix}-description`} className="workspace-dialog max-h-[92dvh] w-[min(68rem,calc(100vw-1rem))] overflow-auto rounded-xl border bg-popover p-0 text-popover-foreground shadow-lg" onCancel={event => { event.preventDefault(); if (!busyRef.current) onClose() }}>
    <div className="sticky top-0 z-10 flex items-start justify-between gap-2 border-b bg-popover px-3 py-2"><div><h2 id={`${prefix}-title`} className="text-label-13 font-semibold">{mode === 'new' ? '답변을 새 노트로 저장' : '답변을 기존 노트에 적용'}</h2><p id={`${prefix}-description`} className="mt-1 text-xs text-muted-foreground">도니의 제안은 아직 저장되지 않습니다. 원문과 차이를 검토하고 내용을 편집한 뒤 저장하세요.</p></div><Button variant="ghost" size="icon" aria-label="제안 닫기" onClick={onClose} disabled={busy}><X/></Button></div>
    <div className="space-y-3 p-4">
      <div className="space-y-2"><Label htmlFor={`${prefix}-path`}>{mode === 'new' ? '새 노트 경로' : '수정할 노트 찾기'}</Label><div className="flex flex-col gap-2 sm:flex-row"><Input ref={input} id={`${prefix}-path`} value={path} onChange={event => updatePath(event.target.value)} placeholder={mode === 'new' ? '비워 두면 도니가 경로를 제안합니다' : '폴더 또는 노트 경로를 입력하세요'} disabled={busy || Boolean(saved)} className="min-w-0 flex-1"/><Button variant="outline" onClick={propose} disabled={busy || Boolean(saved) || (mode === 'edit' && !tree.data?.files.includes(path.trim()))}><RefreshCw/>{proposal ? '초안 다시 만들기' : '초안 만들기'}</Button></div><p className="text-xs text-muted-foreground">{mode === 'new' ? '저장소 상대 경로와 .md 확장자를 사용합니다. 제안된 경로도 저장 전에 바꿀 수 있습니다.' : '기존 노트를 선택하면 원문을 보존하는 수정 초안을 생성합니다.'}</p></div>
      {mode === 'edit' && !proposal && <div className="max-h-48 overflow-auto border-y" aria-label="수정 대상 노트 목록">{tree.isPending ? <Loading label="노트 목록을 불러오는 중입니다."/> : tree.isError ? <><ErrorNotice error={tree.error}/><Button variant="outline" size="sm" onClick={() => void tree.refetch()}>목록 다시 불러오기</Button></> : results.length ? <ul className="divide-y">{results.map(file => <li key={file}><Button className="h-auto w-full justify-start whitespace-normal break-all px-2 py-1.5 text-left" variant={path === file ? 'secondary' : 'ghost'} size="sm" onClick={() => updatePath(file)} disabled={busy}>{file}</Button></li>)}</ul> : <p className="px-2 py-1.5 text-label-13 text-muted-foreground">일치하는 노트가 없습니다.</p>}</div>}
      <ErrorNotice error={draft.error}/>{draft.isPending && <Loading label="도니가 노트 초안을 작성하고 있습니다…"/>}
      {proposal && <>
        <div className="space-y-2"><Label htmlFor={`${prefix}-content`}>제안 내용 · 편집 가능</Label><Textarea id={`${prefix}-content`} value={content} onChange={event => { setContent(event.target.value); if (!stale) save.reset() }} disabled={busy || Boolean(saved)} className="min-h-64 font-mono text-xs"/><p className="text-xs text-muted-foreground">기준 버전 {proposal.baseSha.slice(0, 8)} · {proposal.original === null ? '새 파일' : '기존 파일 수정'}</p></div>
        <section aria-label="노트 변경 미리보기" className="min-w-0 space-y-2"><h3 className="flex h-7 items-center gap-1.5 border-b text-label-13 font-semibold">변경 미리보기</h3><DiffView before={proposal.original ?? ''} after={content}/></section>
        <ErrorNotice error={save.error}/>
        {stale && <div role="alert" className="space-y-1.5 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-label-13"><p>대상 노트가 변경되었거나 같은 경로가 생겼습니다. 현재 초안은 유지됩니다. 최신 원문으로 다시 제안받은 뒤 차이를 확인하세요.</p><Button variant="outline" size="sm" onClick={propose} disabled={busy}>최신 버전으로 다시 제안</Button></div>}
        {saved ? <div role="status" className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-label-13"><p className="mb-1.5 font-medium">노트가 저장되었습니다.</p><div className="flex flex-wrap gap-2"><Link className="underline" href={noteHref(saved.path)} onClick={onClose}>노트 열기</Link><Link className="underline" href={`/jobs/${encodeURIComponent(saved.jobId)}`} onClick={onClose}>쓰기 작업 확인</Link><Link className="underline" href={`/history/commits/${encodeURIComponent(saved.mergeSha)}`} onClick={onClose}>변경 이력</Link></div></div> : <div className="flex flex-wrap justify-end gap-2"><Button variant="outline" disabled={busy} onClick={onClose}>취소</Button><Button disabled={busy || !path.trim() || stale || (mode === 'edit' && content === proposal.original)} onClick={() => save.mutate()}>{save.isPending ? '저장 중…' : mode === 'new' ? '새 노트 저장' : '변경 적용'}</Button></div>}
      </>}
    </div>
  </dialog>
}
