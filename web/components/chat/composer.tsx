'use client'

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { Paperclip, Send, Square, X, Pin, CircleHelp } from 'lucide-react'
import { api, request, type CatalogNote } from '@/lib/api'
import { noteHref } from '@/components/common'
import { consumeChatContext, type ChatNoteContext } from '@/lib/chat-context'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { DraftAttachments, useChatAttachments } from './attachments'

export interface ChatComposerInput { content: string; attachments: string[]; context?: ChatNoteContext; model?: string; effort?: 'low' | 'medium' | 'high' }
export interface ChatComposerProps {
  conversationId?: string
  disabled: boolean
  streaming: boolean
  onSubmit: (input: ChatComposerInput) => Promise<boolean>
  onStop: () => void
  edit?: { id: string; content: string } | null
  onCancelEdit?: () => void
  onEditLast?: () => void
  onSaveLast: () => void
}
interface ModelOptions { models: string[]; defaultModel: string; efforts: Array<'low' | 'medium' | 'high'>; defaultEffort: string }
const commands = [
  { name: '/search', description: '대화 안에서 검색 · /search 검색어' },
  { name: '/note', description: '노트 문맥 고정 · /note wiki/노트.md' },
  { name: '/save', description: '마지막 답변을 위키 초안으로 저장' },
  { name: '/help', description: '입력 도움말 표시' },
]
const contextKey = 'llmwiki.chat.pinned.'

export function ChatComposer({ conversationId, disabled, streaming, onSubmit, onStop, edit, onCancelEdit, onEditLast, onSaveLast }: ChatComposerProps) {
  const textarea = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const previousEdit = useRef<string | null>(null)
  const [content, setContent] = useState('')
  const [caret, setCaret] = useState(0)
  const [context, setContext] = useState<ChatNoteContext | null>(null)
  const pinnedRef = useRef<ChatNoteContext | null>(null)
  const previousConversation = useRef<string | null>(null)
  const currentKey = conversationId || 'new'
  const conversationRef = useRef(currentKey)
  const submissionRef = useRef<symbol | null>(null)
  const draftRef = useRef(content)
  draftRef.current = content
  if (conversationRef.current !== currentKey) {
    conversationRef.current = currentKey
    submissionRef.current = null
  }
  const [submitting, setSubmitting] = useState(false)
  const [help, setHelp] = useState(false)
  const [error, setError] = useState('')
  const [pinning, setPinning] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [modelOptions, setModelOptions] = useState<ModelOptions | null>(null)
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState<'' | 'low' | 'medium' | 'high'>('')
  const [searchQuery, setSearchQuery] = useState('')
  const search = useQuery({ queryKey: ['search', searchQuery], queryFn: ({ signal }) => api.search(searchQuery, { limit: 5 }, signal), enabled: !!searchQuery })
  const attachments = useChatAttachments()
  const [suggestions, setSuggestions] = useState<CatalogNote[]>([])
  const [suggestionError, setSuggestionError] = useState('')
  const [loadingSuggestions, setLoadingSuggestions] = useState(false)
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const listId = useId()
  const mention = content.slice(0, caret).match(/(?:^|\s)@([^\s@]*)$/)
  const noteCommand = content.match(/^\/note\s+(.*)$/)
  const lookup = mention ? mention[1] : noteCommand ? noteCommand[1] : null
  const slash = content.match(/^\/[a-z]*$/i)
  const commandMatches = slash ? commands.filter(command => command.name.startsWith(content)) : []
  const options = lookup !== null ? suggestions.map(note => ({ label: note.title || note.path, description: note.path, note })) : commandMatches.map(command => ({ label: command.name, description: command.description, note: null }))
  const showOptions = !dismissed && !disabled && !streaming && (lookup !== null || commandMatches.length > 0)

  const pin = useCallback((value: ChatNoteContext | null) => {
    pinnedRef.current = value
    setContext(value)
    try { if (value) sessionStorage.setItem(contextKey + currentKey, JSON.stringify(value)); else sessionStorage.removeItem(contextKey + currentKey) } catch { /* The in-memory pin survives follow-up messages. */ }
  }, [currentKey])
  useEffect(() => {
    setSubmitting(false)
    return () => { submissionRef.current = null }
  }, [currentKey])
  useEffect(() => {
    let restored: ChatNoteContext | null = null
    try {
      const pending = consumeChatContext()
      const saved = JSON.parse(sessionStorage.getItem(contextKey + currentKey) || 'null') as ChatNoteContext | null
      if (pending) restored = pending
      else if (previousConversation.current === 'new' && currentKey !== 'new') restored = pinnedRef.current
      else if (saved && typeof saved.notePath === 'string') restored = saved
      if (previousConversation.current === 'new' && currentKey !== 'new') sessionStorage.removeItem(contextKey + 'new')
    } catch { restored = previousConversation.current === 'new' ? pinnedRef.current : null }
    if (previousConversation.current && previousConversation.current !== currentKey && previousConversation.current !== 'new') {
      setContent(''); setCaret(0); setError(''); setDismissed(true); attachments.clear()
    }
    previousConversation.current = currentKey
    pin(restored)
  }, [currentKey, pin, attachments.clear])
  useEffect(() => {
    if (!edit) {
      if (previousEdit.current) { setContent(''); setCaret(0) }
      previousEdit.current = null
      return
    }
    previousEdit.current = edit.id
    setContent(edit.content); setCaret(edit.content.length); setDismissed(true)
    textarea.current?.focus()
  }, [edit?.id, edit?.content])
  useEffect(() => {
    const controller = new AbortController()
    void request<ModelOptions>('/api/luna/models', { signal: controller.signal }).then(setModelOptions).catch(() => { /* Missing discovery still uses configured server defaults. */ })
    return () => controller.abort()
  }, [])
  useEffect(() => {
    if (lookup === null || dismissed || disabled) { setSuggestions([]); setLoadingSuggestions(false); return }
    const controller = new AbortController()
    setLoadingSuggestions(true); setSuggestionError(''); setSuggestions([])
    const timer = window.setTimeout(() => {
      void request<CatalogNote[]>(`/api/search/suggest?q=${encodeURIComponent(lookup)}`, { signal: controller.signal }).then(notes => {
        if (!controller.signal.aborted) { setSuggestions(notes); setActive(0) }
      }).catch(cause => { if (!controller.signal.aborted) setSuggestionError(cause instanceof Error ? cause.message : '노트 제안을 불러오지 못했다.') }).finally(() => { if (!controller.signal.aborted) setLoadingSuggestions(false) })
    }, 150)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [lookup, dismissed, disabled])
  useEffect(() => {
    const receive = (event: Event) => {
      if (disabled || streaming || submissionRef.current || edit) return
      const detail = (event as CustomEvent<File[] | FileList>).detail
      if (detail) attachments.addFiles(Array.from(detail))
    }
    window.addEventListener('chat-files', receive)
    return () => window.removeEventListener('chat-files', receive)
  }, [disabled, streaming, edit, attachments.addFiles])

  async function pinPath(path: string) {
    setPinning(true); setError('')
    try {
      const note = await request<{ path: string }>(`/api/notes/content?path=${encodeURIComponent(path)}`)
      pin({ notePath: note.path })
      return true
    } catch (cause) { setError(cause instanceof Error ? cause.message : '노트를 고정하지 못했다.'); return false }
    finally { setPinning(false) }
  }
  function choose(index: number) {
    const option = options[index]
    if (!option) return
    if (option.note) {
      pin({ notePath: option.note.path })
      const next = mention ? content.slice(0, caret - mention[1].length - 1) + content.slice(caret) : ''
      setContent(next); setCaret(next.length); setDismissed(true)
    } else {
      const next = option.label + (option.label === '/search' || option.label === '/note' ? ' ' : '')
      setContent(next); setCaret(next.length); setDismissed(true)
    }
    textarea.current?.focus()
  }
  async function submit() {
    if (disabled || streaming || submissionRef.current || pinning || attachments.pending || attachments.failed || !content.trim()) return
    const trimmed = content.trim()
    const command = trimmed.match(/^\/(search|note|save|help)(?:\s+([\s\S]*))?$/)
    if (command && !edit) {
      if (command[1] === 'help') setHelp(true)
      else if (command[1] === 'save') onSaveLast()
      else if (command[1] === 'search') {
        if (!command[2]?.trim()) { setError('/search 뒤에 검색어를 입력한다.'); return }
        setSearchQuery(command[2].trim())
      } else {
        if (!command[2]?.trim()) { setError('/note 뒤에 노트 경로를 입력한다.'); return }
        if (!await pinPath(command[2].trim())) return
      }
      setContent(''); setCaret(0); setDismissed(true); setError(''); return
    }
    if (context?.selection && context.selection.length > 32000) {
      setError('선택한 문맥은 32,000자 이하로 보내야 한다. 다시 선택하거나 제거하세요.')
      return
    }
    const identity = Symbol()
    const conversation = currentKey
    const draft = content
    const submittedKeys = attachments.items.map(item => item.key)
    submissionRef.current = identity
    setSubmitting(true)
    setError('')
    try {
      const accepted = await onSubmit({ content: trimmed, attachments: attachments.ids, ...(context ? { context } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) })
      if (!accepted || submissionRef.current !== identity || conversationRef.current !== conversation) return
      if (draftRef.current === draft) { setContent(''); setCaret(0); setDismissed(true) }
      for (const key of submittedKeys) attachments.remove(key)
    } catch (cause) {
      if (submissionRef.current === identity && conversationRef.current === conversation) setError(cause instanceof Error ? cause.message : '메시지를 보내지 못했다.')
    } finally {
      if (submissionRef.current === identity) { submissionRef.current = null; setSubmitting(false) }
    }
  }
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.keyCode === 229) return
    if (event.key === 'Escape') {
      if (showOptions) { event.preventDefault(); event.stopPropagation(); setDismissed(true) }
      else if (streaming) { event.preventDefault(); event.stopPropagation(); onStop() }
      else if (edit) { event.preventDefault(); event.stopPropagation(); onCancelEdit?.() }
      return
    }
    if (showOptions && options.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault(); setActive(value => (value + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length); return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      if (showOptions && options.length) choose(Math.min(active, options.length - 1))
      else void submit()
    } else if (event.key === 'ArrowUp' && !content && !edit && !streaming && !disabled) { event.preventDefault(); onEditLast?.() }
  }
  const blocked = disabled || streaming || submitting || pinning || attachments.pending || attachments.failed || !content.trim()
  return <section data-chat-composer className={`relative space-y-3 rounded-xl border bg-background p-3 ${dragging ? 'ring-2 ring-primary' : ''}`} aria-label="Luna 메시지 작성" onDragOver={event => {
    if (!disabled && !streaming && !submissionRef.current && !edit && event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); setDragging(true) }
  }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }} onDrop={event => {
    if (!event.dataTransfer.files.length) return
    event.preventDefault(); event.stopPropagation(); setDragging(false)
    if (!disabled && !streaming && !submissionRef.current && !edit) attachments.addFiles(Array.from(event.dataTransfer.files))
  }}>
    {edit && <div className="flex items-center justify-between gap-2 text-sm"><span>질문 수정 · 이후 대화는 다시 생성된다.</span><Button type="button" variant="ghost" size="xs" onClick={onCancelEdit}>수정 취소</Button></div>}
    {context && <div className="flex items-start gap-2 rounded-md bg-muted px-2 py-1.5 text-xs"><Pin className="mt-0.5 size-3 shrink-0" /><div className="min-w-0 flex-1"><p className="break-all">고정 문맥 · {context.notePath}{context.ref ? ` @ ${context.ref.slice(0, 10)}` : ''}</p>{context.selection && <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-muted-foreground">선택: {context.selection}</p>}</div><Button type="button" variant="ghost" size="icon-xs" aria-label="고정 문맥 제거" onClick={() => pin(null)}><X /></Button></div>}
    <fieldset disabled={submitting} className="min-w-0"><DraftAttachments items={attachments.items} onRemove={key => { if (!submissionRef.current) attachments.remove(key) }} /></fieldset>
    {(error || attachments.error) && <p role="alert" className="text-sm text-destructive">{error || attachments.error}</p>}
    <div className="relative">
      {showOptions && <div id={listId} role="listbox" aria-label={lookup !== null ? '노트 제안' : '명령 제안'} className="absolute bottom-full z-20 mb-2 max-h-56 w-full overflow-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
        {options.map((option, index) => <button id={`${listId}-${index}`} key={option.description} type="button" role="option" aria-selected={index === active} className={`flex w-full flex-col rounded px-2 py-1.5 text-left text-sm ${index === active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent'}`} onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}><span>{option.label}</span><span className="break-all text-xs text-muted-foreground">{option.description}</span></button>)}
        {lookup !== null && !options.length && <p className="px-2 py-1 text-xs text-muted-foreground">{loadingSuggestions ? '노트 찾는 중…' : suggestionError || '일치하는 노트가 없다.'}</p>}
      </div>}
      <Textarea ref={textarea} value={content} disabled={disabled} rows={3} maxLength={100000} placeholder={disabled ? '조회 권한으로는 메시지를 보낼 수 없다.' : 'Luna에게 질문 · @ 노트 · / 명령'} aria-label="메시지" aria-controls={showOptions ? listId : undefined} aria-expanded={showOptions} aria-activedescendant={showOptions && options.length ? `${listId}-${Math.min(active, options.length - 1)}` : undefined} className="max-h-64 min-h-24 resize-y border-0 shadow-none focus-visible:ring-0" onChange={event => { setContent(event.target.value); setCaret(event.target.selectionStart); setDismissed(false); setActive(0); setError('') }} onSelect={event => setCaret(event.currentTarget.selectionStart)} onKeyDown={keyDown} onPaste={event => {
        if (disabled || streaming || submissionRef.current || edit) return
        const files = Array.from(event.clipboardData.items).filter(item => item.kind === 'file').flatMap(item => { const file = item.getAsFile(); return file ? [file] : [] })
        if (files.length) { event.preventDefault(); attachments.addFiles(files) }
      }} />
    </div>
    {searchQuery && <section className="max-h-72 space-y-2 overflow-auto rounded-lg border p-3" aria-label="대화 안에서 검색 결과">
      <div className="flex items-center gap-2 text-sm"><h3 className="min-w-0 flex-1 truncate font-medium">검색 · {searchQuery}</h3><Link href={`/search?q=${encodeURIComponent(searchQuery)}`} className="shrink-0 text-xs underline">전체 검색</Link><Button type="button" variant="ghost" size="icon-xs" aria-label="검색 결과 닫기" onClick={() => setSearchQuery('')}><X /></Button></div>
      {search.isPending && <p role="status" className="text-xs text-muted-foreground">검색 중…</p>}
      {search.isError && <div><p role="alert" className="text-xs text-destructive">{search.error.message}</p><Button type="button" variant="ghost" size="xs" onClick={() => void search.refetch()}>다시 시도</Button></div>}
      {search.data?.degraded && <p className="text-xs text-muted-foreground">벡터 검색을 사용할 수 없어 키워드 검색으로 표시한다.</p>}
      {search.data && !search.data.hits.length && <p className="text-xs text-muted-foreground">검색 결과가 없다.</p>}
      {search.data?.hits.map(hit => <article key={`${hit.path}:${hit.anchor || hit.heading}`} className="space-y-1 border-t pt-2 text-xs">
        <Link href={noteHref(hit.path) + (hit.anchor ? `#${encodeURIComponent(hit.anchor)}` : '')} className="font-medium underline">{hit.title || hit.path}{hit.heading ? ` · ${hit.heading}` : ''}</Link>
        <p className="break-all text-muted-foreground">{hit.path}</p><p className="line-clamp-3 whitespace-pre-wrap">{hit.excerpt || hit.snippet}</p>
        <Button type="button" variant="ghost" size="xs" disabled={disabled || streaming || !!edit} onClick={() => pin({ notePath: hit.path })}><Pin /> 문맥 고정</Button>
      </article>)}
    </section>}
    <div className="flex flex-wrap items-center gap-2">
      <input ref={fileInput} type="file" multiple hidden accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/markdown,.md" onChange={event => { if (!disabled && !streaming && !submissionRef.current && !edit && event.target.files) attachments.addFiles(Array.from(event.target.files)); event.target.value = '' }} />
      <Button type="button" variant="ghost" size="icon-sm" aria-label="파일 첨부" title="파일 첨부 · 최대 10개, 각 20 MB" disabled={disabled || streaming || submitting || !!edit || attachments.items.length >= 10} onClick={() => fileInput.current?.click()}><Paperclip /></Button>
      <label className="sr-only" htmlFor={`${listId}-model`}>모델</label><select id={`${listId}-model`} value={model} onChange={event => setModel(event.target.value)} disabled={disabled || streaming || !!edit} className="h-7 max-w-44 rounded-md border bg-background px-1 text-xs"><option value="">{modelOptions ? `기본 · ${modelOptions.defaultModel}` : '서버 기본 모델'}</option>{modelOptions?.models.map(value => <option key={value} value={value}>{value}</option>)}</select>
      <label className="sr-only" htmlFor={`${listId}-effort`}>추론 강도</label><select id={`${listId}-effort`} value={effort} onChange={event => setEffort(event.target.value as typeof effort)} disabled={disabled || streaming || !!edit} className="h-7 rounded-md border bg-background px-1 text-xs"><option value="">기본 추론 강도{modelOptions ? ` · ${modelOptions.defaultEffort}` : ''}</option>{(modelOptions?.efforts || ['low', 'medium', 'high']).map(value => <option key={value} value={value}>{value === 'low' ? '낮음' : value === 'medium' ? '보통' : '높음'}</option>)}</select>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="입력 도움말" aria-expanded={help} onClick={() => setHelp(value => !value)}><CircleHelp /></Button>
      <div className="ml-auto">{streaming ? <Button type="button" variant="outline" onClick={onStop}><Square /> 중지</Button> : <Button type="button" disabled={blocked} onClick={() => void submit()}><Send /> {edit ? '수정 후 다시 생성' : '보내기'}</Button>}</div>
    </div>
    <p className="text-xs text-muted-foreground">Enter 전송 · Shift+Enter 줄바꿈 · ↑ 마지막 질문 수정 · Esc 중지</p>
    {help && <div className="space-y-1 rounded-md bg-muted p-3 text-xs"><p>@노트와 /note 경로로 문맥을 고정하며 후속 질문에도 유지한다. 칩의 ×로 제거한다.</p><p>/search 검색어: 대화 안에서 검색 · /save: 마지막 답변의 위키 초안 · /help: 이 도움말</p><p>제안에서 ↑↓ 선택, Enter 적용, Esc 닫기. 파일 드롭·이미지 붙여넣기를 지원한다. 업로드 오류 파일은 제거 후 다시 첨부한다.</p></div>}
  </section>
}
