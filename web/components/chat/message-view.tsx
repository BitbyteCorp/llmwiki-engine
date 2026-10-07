'use client'

import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { Copy, Pencil, RefreshCw, Search, FileText } from 'lucide-react'
import { api, type Message } from '@/lib/api'
import { ErrorNotice, formatDate, noteHref } from '@/components/common'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { MessageAttachments } from '@/components/chat/attachments'

type Citation = Message['citations'][number]
type Tool = { name: string; summary?: unknown; status?: string }

function CitationLink({ citation, number }: { citation: Citation; number: number }) {
  const [active, setActive] = useState(false)
  const id = useId()
  const current = useQuery({ queryKey: ['notes/content', citation.path], queryFn: () => api.note(citation.path), staleTime: 60_000, retry: false })
  const historical = Boolean(citation.sha && current.data?.updatedSha !== citation.sha)
  const changed = Boolean(citation.sha && current.data && current.data.updatedSha !== citation.sha)
  const snapshot = useQuery({ queryKey: ['notes/content', citation.path, citation.sha], queryFn: () => api.note(citation.path, citation.sha), enabled: active && historical && !citation.excerpt, staleTime: 60_000, retry: false })
  const preview = historical ? snapshot : current
  const href = noteHref(citation.path) + (historical ? `?ref=${encodeURIComponent(citation.sha!)}` : '') + (citation.anchor ? `#${encodeURIComponent(citation.anchor)}` : '')
  const title = typeof current.data?.frontmatter.title === 'string' ? current.data.frontmatter.title : citation.path
  return <span className="relative inline-block max-w-full" onMouseEnter={() => setActive(true)} onMouseLeave={() => setActive(false)}>
    <Link href={href} prefetch={false} onFocus={() => setActive(true)} onBlur={() => setActive(false)} aria-describedby={active ? id : undefined} className="inline-flex max-w-full items-center gap-1 rounded border px-2 py-1 text-xs hover:bg-muted focus-visible:outline-ring">
      <span className="shrink-0 font-medium">[{number}]</span><span className="truncate">{citation.heading || title}</span>{changed && <span className="shrink-0 text-amber-700 dark:text-amber-400">변경됨</span>}
    </Link>
    {active && <span id={id} role="tooltip" className="absolute bottom-full left-0 z-30 mb-2 flex w-[min(22rem,75vw)] flex-col gap-2 rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-lg">
      <strong className="break-words">{citation.heading || title}</strong><span className="whitespace-pre-wrap break-words">{citation.excerpt || preview.data?.body.slice(0, 350) || (preview.isError ? '인용한 노트를 읽을 수 없습니다. 인용 버전 링크를 확인하세요.' : '근거를 불러오는 중입니다.')}</span><small className="break-all text-muted-foreground">{citation.path}{citation.sha ? ` · ${citation.sha.slice(0, 8)}` : ''}</small>{changed && <small>답변 이후 저장소가 변경되어 인용 시점 버전으로 이동합니다.</small>}
    </span>}
  </span>
}

function toolSummary(summary: unknown): string {
  if (typeof summary === 'string') return summary.slice(0, 240)
  if (!summary || typeof summary !== 'object') return ''
  const value = summary as Record<string, unknown>
  return ['query', 'path'].flatMap(key => typeof value[key] === 'string' ? [value[key].slice(0, 240)] : []).join(' · ')
}

export function ChatMessageView({ message, tools = [], onEdit, onAction, onProposal, disabled = false }: {
  message: Message
  tools?: Tool[]
  onEdit: (message: Message) => void
  onAction: (message: Message, action: 'retry' | 'regenerate') => void
  onProposal: (message: Message, mode: 'new' | 'edit') => void
  disabled?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const assistant = message.role === 'assistant'
  const unfinished = ['failed', 'cancelled', 'interrupted'].includes(message.status)
  async function copy() {
    try { await navigator.clipboard.writeText(message.content); setCopied(true); setError(null) }
    catch { setError(new Error('클립보드에 복사하지 못했습니다. 본문을 선택해 복사하세요.')) }
  }
  function edit() {
    if (window.confirm('이 질문을 수정하면 이후 메시지와 답변이 모두 교체됩니다. 계속하시겠습니까?')) onEdit(message)
  }
  function regenerate() {
    if (window.confirm('이 답변을 다시 생성하면 이후 메시지도 교체됩니다. 계속하시겠습니까?')) onAction(message, 'regenerate')
  }
  return <article aria-label={assistant ? 'Luna 답변' : '사용자 질문'} className={`min-w-0 rounded-xl border p-4 sm:p-5 ${assistant ? 'bg-card' : 'bg-muted/40'}`}>
    <header className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><strong className="text-sm text-foreground">{assistant ? 'Luna' : '나'}</strong><time dateTime={message.createdAt}>{formatDate(message.createdAt)}</time></header>
    {message.context && <details className="mb-3 rounded border p-2 text-xs"><summary className="cursor-pointer">노트 문맥: {message.context.notePath}</summary><Link className="mt-2 inline-block underline" href={noteHref(message.context.notePath) + (message.context.ref ? `?ref=${encodeURIComponent(message.context.ref)}` : '')}>고정 노트 열기</Link>{message.context.selection && <blockquote className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap border-l-2 pl-2">{message.context.selection}</blockquote>}</details>}
    {tools.length > 0 && <details className="mb-3 rounded border p-2 text-xs text-muted-foreground"><summary className="cursor-pointer">근거 확인 과정 · {tools.length}개 활동</summary><ol className="mt-2 space-y-2">{tools.map((tool, index) => <li key={index} className="flex items-start gap-2">{tool.name === 'search' ? <Search className="size-3.5 shrink-0"/> : <FileText className="size-3.5 shrink-0"/>}<span className="min-w-0 break-words"><strong>{tool.name === 'search' ? '검색' : tool.name === 'read_note' ? '노트 읽음' : '근거 확인'}</strong>{tool.status === 'start' || tool.status === 'running' ? ' · 진행 중' : tool.status === 'end' || tool.status === 'completed' ? ' · 완료' : ''}{toolSummary(tool.summary) && <span className="block">{toolSummary(tool.summary)}</span>}</span></li>)}</ol></details>}
    {message.content ? <Markdown content={message.content}/> : message.status === 'running' ? <p role="status" className="text-sm text-muted-foreground">답변을 작성하는 중입니다…</p> : <p className="text-sm text-muted-foreground">저장된 답변 본문이 없습니다.</p>}
    {message.attachments.length > 0 && <div className="mt-3"><MessageAttachments ids={message.attachments}/></div>}
    {message.citations.length > 0 && <section aria-label="답변 근거" className="mt-4 border-t pt-3"><h3 className="mb-2 text-xs font-medium text-muted-foreground">인용 근거</h3><div className="flex flex-wrap gap-2">{message.citations.map((citation, index) => <CitationLink key={`${citation.path}-${citation.anchor ?? ''}-${index}`} citation={citation} number={index + 1}/>)}</div></section>}
    {unfinished && <p role="status" className="mt-3 rounded border border-amber-500/30 bg-amber-500/5 p-2 text-sm">{message.status === 'failed' ? '답변 생성에 실패했습니다.' : message.status === 'cancelled' ? '답변 생성이 중지되었습니다.' : '서버 연결 중단으로 생성이 완료되지 않았습니다.'} 부분 답변이며 다시 시도할 수 있습니다.</p>}
    <footer className="mt-4 flex flex-wrap items-center gap-1 border-t pt-2">
      <Button variant="ghost" size="sm" onClick={() => void copy()} disabled={!message.content}><Copy/>{copied ? '복사됨' : '복사'}</Button>
      {!assistant && <Button variant="ghost" size="sm" onClick={edit} disabled={disabled}><Pencil/>수정</Button>}
      {unfinished && <Button variant="outline" size="sm" disabled={disabled} onClick={() => onAction(message, 'retry')}><RefreshCw/>다시 시도</Button>}
      {assistant && message.status === 'completed' && <><Button variant="ghost" size="sm" disabled={disabled} onClick={regenerate}><RefreshCw/>다시 생성</Button><Button variant="ghost" size="sm" disabled={disabled} onClick={() => onProposal(message, 'new')}>새 노트로 저장</Button><Button variant="ghost" size="sm" disabled={disabled} onClick={() => onProposal(message, 'edit')}>기존 노트에 적용</Button></>}
      {assistant && (message.usage || message.model) && <p className="basis-full pt-1 text-[11px] text-muted-foreground">{[message.model, message.effort ? `추론 ${message.effort}` : '', message.usage ? `입력 ${message.usage.inputTokens.toLocaleString()} · 출력 ${message.usage.outputTokens.toLocaleString()} · 추론 ${message.usage.reasoningTokens.toLocaleString()} 토큰` : ''].filter(Boolean).join(' · ')}</p>}
    </footer><ErrorNotice error={error}/>
  </article>
}
