'use client'

import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { Copy, FilePlus2, FileText, Pencil, RefreshCw, Sparkles } from 'lucide-react'
import { api, type Message } from '@/lib/api'
import { formatDate, noteHref } from '@/components/common'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { MessageAttachments } from '@/components/chat/attachments'
import { WorkSteps, type WorkStep } from '@/components/chat/work-steps'
import { notify } from '@/components/notifications'

type Citation = Message['citations'][number]

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
      <span className="shrink-0 font-medium">[{number}]</span><span className="truncate">{citation.heading || title}</span>{changed && <span className="shrink-0 text-warning">변경됨</span>}
    </Link>
    {active && <span id={id} role="tooltip" className="absolute bottom-full left-0 z-30 mb-2 flex w-[min(22rem,75vw)] flex-col gap-1.5 rounded-lg border bg-popover px-3 py-2 text-label-13 text-popover-foreground shadow-lg">
      <strong className="break-words">{citation.heading || title}</strong><span className="whitespace-pre-wrap break-words">{citation.excerpt || preview.data?.body.slice(0, 350) || (preview.isError ? '인용한 노트를 읽을 수 없습니다. 인용 버전 링크를 확인하세요.' : '근거를 불러오는 중입니다.')}</span><small className="break-all text-muted-foreground">{citation.path}{citation.sha ? ` · ${citation.sha.slice(0, 8)}` : ''}</small>{changed && <small>답변 이후 저장소가 변경되어 인용 시점 버전으로 이동합니다.</small>}
    </span>}
  </span>
}

export function ChatMessageView({ message, steps = [], onEdit, onAction, onProposal, disabled = false }: {
  message: Message
  steps?: WorkStep[]
  onEdit: (message: Message) => void
  onAction: (message: Message, action: 'retry' | 'regenerate') => void
  onProposal: (message: Message, mode: 'new' | 'edit') => void
  disabled?: boolean
}) {
  const assistant = message.role === 'assistant'
  const running = assistant && message.status === 'running'
  const unfinished = ['failed', 'cancelled', 'interrupted'].includes(message.status)
  const noteCount = new Set(message.citations.map(citation => citation.path)).size
  async function copy() {
    try {
      await navigator.clipboard.writeText(message.content)
      notify({ title: '메시지를 복사했습니다.', tone: 'success' })
    } catch {
      notify({ title: '클립보드에 복사하지 못했습니다.', description: '본문을 선택해 복사해 주세요.', tone: 'error' })
    }
  }
  function edit() {
    if (window.confirm('이 질문을 수정하면 이후 메시지와 답변이 모두 교체됩니다. 계속하시겠습니까?')) onEdit(message)
  }
  function regenerate() {
    if (window.confirm('이 답변을 다시 생성하면 이후 메시지도 교체됩니다. 계속하시겠습니까?')) onAction(message, 'regenerate')
  }
  return <article aria-label={assistant ? '도니 답변' : '사용자 질문'} className={`group/message min-w-0 ${assistant ? 'w-full py-1' : 'ml-auto w-fit max-w-[90%] rounded-2xl rounded-tr-sm bg-secondary px-3 py-2'}`}>
    {assistant && <header className="mb-2 flex items-center gap-2">
      <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Sparkles className="size-3.5"/></span>
      <strong className="text-xs font-semibold">도니</strong>
      <time dateTime={message.createdAt} className="ml-auto text-[10px] text-muted-foreground">{formatDate(message.createdAt)}</time>
    </header>}
    {message.context && <details className="mb-2 rounded-lg border border-border/70 px-2 py-1.5 text-xs">
      <summary className="cursor-pointer break-all text-muted-foreground">노트 문맥: {message.context.notePath}</summary>
      <Link className="mt-2 inline-block underline" href={noteHref(message.context.notePath) + (message.context.ref ? `?ref=${encodeURIComponent(message.context.ref)}` : '')}>고정 노트 열기</Link>
      {message.context.selection && <blockquote className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words border-l-2 pl-2">{message.context.selection}</blockquote>}
    </details>}
    {assistant && (running || steps.length > 0 || noteCount > 0) && <div className="mb-2"><WorkSteps steps={steps} running={running} noteCount={noteCount}/></div>}
    {message.content ? <div className={`min-w-0 break-words text-sm ${running ? "[&>.markdown>:last-child]:after:ml-1 [&>.markdown>:last-child]:after:inline-block [&>.markdown>:last-child]:after:h-4 [&>.markdown>:last-child]:after:w-1 [&>.markdown>:last-child]:after:align-text-bottom [&>.markdown>:last-child]:after:bg-primary [&>.markdown>:last-child]:after:content-[''] motion-safe:[&>.markdown>:last-child]:after:animate-pulse" : ''}`}>
      <Markdown content={message.content}/>
      {running && <span role="status" className="sr-only">답변을 작성하고 있습니다.</span>}
    </div> : running ? <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">답변을 작성하고 있습니다.<span aria-hidden="true" className="inline-block h-3.5 w-1 bg-primary motion-safe:animate-pulse"/></p> : <p className="text-xs text-muted-foreground">저장된 답변 본문이 없습니다.</p>}
    {message.attachments.length > 0 && <div className="mt-2"><MessageAttachments ids={message.attachments}/></div>}
    {message.citations.length > 0 && <section aria-label="답변 근거" className="mt-3">
      <h3 className="sr-only">인용 근거</h3>
      <div className="flex flex-wrap gap-1.5">{message.citations.map((citation, index) => <CitationLink key={`${citation.path}-${citation.anchor ?? ''}-${index}`} citation={citation} number={index + 1}/>)}</div>
    </section>}
    {unfinished && <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-warning/30 bg-warning/5 px-2 py-1.5">
      <p role="status" className="min-w-0 flex-1 text-xs text-muted-foreground">{message.status === 'failed' ? '답변 생성에 실패했습니다.' : message.status === 'cancelled' ? '답변 생성이 중지되었습니다.' : '서버 연결 중단으로 생성이 완료되지 않았습니다.'} 부분 답변입니다.</p>
      <Button variant="ghost" size="xs" disabled={disabled} onClick={() => onAction(message, 'retry')}><RefreshCw/>다시 시도</Button>
    </div>}
    <footer className="mt-1.5">
      <div className={`flex flex-wrap items-center gap-0.5 ${assistant ? '' : 'justify-end'}`}>
        {!assistant && <time dateTime={message.createdAt} className="mr-1 text-[10px] text-muted-foreground">{formatDate(message.createdAt)}</time>}
        <div role="group" aria-label="메시지 동작" className="flex items-center gap-0.5 text-muted-foreground transition-opacity group-hover/message:opacity-100 group-focus-within/message:opacity-100 [@media(hover:hover)]:opacity-0">
          <Button variant="ghost" size="icon-xs" title="복사" aria-label="메시지 복사" onClick={() => void copy()} disabled={!message.content}><Copy/></Button>
          {!assistant && <Button variant="ghost" size="icon-xs" title="질문 수정" aria-label="질문 수정" onClick={edit} disabled={disabled}><Pencil/></Button>}
          {assistant && message.status === 'completed' && <>
            <Button variant="ghost" size="icon-xs" title="다시 생성" aria-label="답변 다시 생성" disabled={disabled} onClick={regenerate}><RefreshCw/></Button>
            <Button variant="ghost" size="icon-xs" title="새 노트로 저장" aria-label="새 노트로 저장" disabled={disabled} onClick={() => onProposal(message, 'new')}><FilePlus2/></Button>
            <Button variant="ghost" size="icon-xs" title="기존 노트에 적용" aria-label="기존 노트에 적용" disabled={disabled} onClick={() => onProposal(message, 'edit')}><FileText/></Button>
          </>}
        </div>
      </div>
      {assistant && (message.usage || message.model || message.effort) && <p className="mt-1 break-words text-[10px] leading-relaxed text-muted-foreground">{[message.model, message.effort ? `추론 ${message.effort}` : '', message.usage ? `입력 ${message.usage.inputTokens.toLocaleString()} · 출력 ${message.usage.outputTokens.toLocaleString()} · 추론 ${message.usage.reasoningTokens.toLocaleString()} 토큰` : ''].filter(Boolean).join(' · ')}</p>}
    </footer>
  </article>
}
