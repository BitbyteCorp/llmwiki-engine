'use client'

import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { History, Star, Pencil, Save, MessageCircle, GitCommitHorizontal } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import type { Note } from '@/lib/api'
import { onLiveEvent } from '@/lib/events'
import { askAgent } from '@/lib/chat-context'
import { EmptyState, ErrorNotice, Loading, noteHref } from '@/components/common'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useWorkspace } from '@/components/workspace/context'
import { Breadcrumbs } from '@/components/workspace/breadcrumbs'
import { Outline } from '@/components/workspace/outline'
import { Properties } from '@/components/workspace/properties'
import { notify } from '@/components/notifications'
import { cn } from '@/lib/utils'
import { ReaderDialog } from '@/components/editor/reader-dialog'
import { saveNote, readNoteSnapshot, readCurrentNote, uploadNoteImage } from '@/components/editor/api'
import { registerEditorGuard, setEditorStatus, confirmEditorLeave } from '@/components/editor/state'
import type { EditorStatus, EditorCommand } from '@/components/editor/state'
import { DiffView } from '@/components/history/diff-view'
import { BlameView } from '@/components/history/blame-view'

const MarkdownEditor = dynamic(() => import('@/components/editor/markdown-editor').then(module => module.MarkdownEditor), {
  ssr: false,
  loading: () => <Loading label="편집기를 불러오는 중" />,
})

function urlFragment() {
  try { return decodeURIComponent(window.location.hash.slice(1)) } catch { return window.location.hash.slice(1) }
}
function previewBody(content: string) {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/, '')
}

export function NoteReader({ path, split = false, revisionRef, className }: { path: string; split?: boolean; revisionRef?: string; className?: string }) {
  const { favoritePaths, toggleFavorite, rememberTitle, setNoteInfo, activePath } = useWorkspace()
  const queryClient = useQueryClient()
  const queryKey = revisionRef ? ['notes/content', path, revisionRef] : ['notes/content', path]
  const note = useQuery({ queryKey, queryFn: () => api.note(path, revisionRef), enabled: Boolean(path) })
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  const tree = useQuery({ queryKey: ['notes/tree'], queryFn: api.tree })
  const commit = useQuery({ queryKey: ['commit', note.data?.updatedSha], queryFn: () => api.commit(note.data!.updatedSha), enabled: Boolean(revisionRef && note.data) })
  const ownsStatus = !split || activePath !== path
  const canEdit = ownsStatus && (me.data?.user.role === 'admin' || me.data?.user.role === 'editor')
  const scrollerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const baseline = useRef<Note | null>(null)
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<EditorStatus['mode']>('view')
  const [phase, setPhase] = useState<EditorStatus['phase']>('idle')
  const [cursor, setCursor] = useState<EditorStatus['cursor']>()
  const [message, setMessage] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [uploading, setUploading] = useState(false)
  const [preparingRestore, setPreparingRestore] = useState(false)
  const [external, setExternal] = useState<Note | null>(null)
  const [conflict, setConflict] = useState<{ base: Note; theirs: Note; mine: string } | null>(null)
  const [restore, setRestore] = useState<Note | null>(null)
  const [blame, setBlame] = useState(false)
  const [fragment, setFragment] = useState<{ path: string; id: string } | null>(null)
  const [selection, setSelection] = useState<{ text: string; top: number; left: number } | null>(null)
  const frontmatter = note.data?.frontmatter ?? {}
  const title = typeof frontmatter.title === 'string' && frontmatter.title.trim()
    ? frontmatter.title.trim() : path.split('/').pop()?.replace(/\.md$/i, '') || '노트'
  const defaultMessage = `docs(wiki): update ${title}`
  const favorite = favoritePaths.includes(path)
  const Heading = split ? 'h2' : 'h1'
  const dirty = Boolean(baseline.current && draft !== baseline.current.content)
  const busy = phase === 'saving' || uploading || preparingRestore
  const latest = useRef({ dirty, busy, mode, draft })
  latest.current = { dirty, busy, mode, draft }

  function acceptSnapshot(snapshot: Note) {
    baseline.current = snapshot
    latest.current.dirty = false
    setDraft(snapshot.content)
    setExternal(null)
    setConflict(null)
    setCursor(undefined)
  }
  function discard() {
    if (latest.current.busy) { window.alert('저장 또는 이미지 업로드가 끝날 때까지 기다려 주세요.'); return false }
    if (latest.current.dirty && !window.confirm('저장하지 않은 변경사항을 버리시겠습니까?')) return false
    if (baseline.current) acceptSnapshot(external ?? baseline.current)
    setMode('view'); setPhase('idle'); setError(null)
    if (ownsStatus) setEditorStatus(path, { dirty: false, mode: 'view', phase: 'idle' })
    return true
  }
  const discardRef = useRef(discard)
  discardRef.current = discard
  useEffect(() => {
    if (ownsStatus) return registerEditorGuard(path, () => discardRef.current())
  }, [path, ownsStatus])
  useEffect(() => {
    if (ownsStatus) setEditorStatus(path, { dirty, mode, phase, cursor })
  }, [path, dirty, mode, phase, cursor, ownsStatus])
  useEffect(() => () => { if (ownsStatus) setEditorStatus(path, null) }, [path, ownsStatus])

  useEffect(() => {
    if (!note.data) return
    if (latest.current.busy) return
    if (!baseline.current || !latest.current.dirty) {
      const changed = baseline.current && baseline.current.content !== note.data.content
      acceptSnapshot(note.data)
      if (changed && ownsStatus) notify({ title: '최신 변경사항을 불러왔습니다.' })
    } else if (note.data.content !== baseline.current.content) setExternal(note.data)
  }, [note.data])
  useEffect(() => {
    if (note.data) rememberTitle(note.data.path, title)
  }, [note.data, title, rememberTitle])
  useEffect(() => {
    if (split) return
    setNoteInfo(note.data ? { path: note.data.path, updatedSha: note.data.updatedSha, body: note.data.body } : null)
    return () => setNoteInfo(null)
  }, [split, note.data, setNoteInfo])
  useEffect(() => {
    if (revisionRef) return
    return onLiveEvent('main.updated', event => {
      if (Array.isArray(event.paths) && !event.paths.includes(path)) return
      if (latest.current.busy) return
      void readNoteSnapshot(path).then(snapshot => {
        queryClient.setQueryData(['notes/content', path], snapshot)
        if (latest.current.dirty && baseline.current?.content !== snapshot.content) setExternal(snapshot)
        else if (!latest.current.dirty) { acceptSnapshot(snapshot); if (ownsStatus) notify({ title: '최신 변경사항을 불러왔습니다.' }) }
      }).catch(setError)
    })
  }, [path, revisionRef, queryClient, ownsStatus])
  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: 0 })
    if (!split) setFragment({ path, id: urlFragment() })
  }, [path, split])
  useEffect(() => {
    if (!split) {
      const changed = () => setFragment({ path, id: urlFragment() })
      window.addEventListener('hashchange', changed)
      return () => window.removeEventListener('hashchange', changed)
    }
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ path: string; fragment: string }>).detail
      if (detail && typeof detail.path === 'string' && typeof detail.fragment === 'string') setFragment({ path: detail.path, id: detail.fragment })
    }
    window.addEventListener('workspace-split-fragment', changed)
    return () => window.removeEventListener('workspace-split-fragment', changed)
  }, [path, split])
  useEffect(() => {
    if (!note.data || fragment?.path !== path || !fragment.id) return
    const frame = requestAnimationFrame(() => {
      const scroller = scrollerRef.current
      const target = Array.from(contentRef.current?.querySelectorAll<HTMLElement>('[id]') ?? []).find(element => element.id === fragment.id)
      if (!scroller || !target) return
      scroller.scrollTo({ top: scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16 })
      target.setAttribute('tabindex', '-1'); target.focus({ preventScroll: true })
      target.addEventListener('blur', () => target.removeAttribute('tabindex'), { once: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [path, fragment, note.data, mode])

  async function write(content = latest.current.draft, snapshot = baseline.current, commitMessage = message.trim() || defaultMessage) {
    if (!canEdit || revisionRef || latest.current.busy || !snapshot) return
    latest.current.busy = true
    setPhase('saving'); setError(null)
    try {
      const result = await saveNote(path, content, snapshot.updatedSha, commitMessage)
      const saved = await readNoteSnapshot(path, result.mergeSha)
      acceptSnapshot(saved)
      queryClient.setQueryData(['notes/content', path], saved)
      setPhase('saved'); setMessage(''); notify({ title: '노트를 저장했습니다.', tone: 'success' })
      void queryClient.invalidateQueries({ queryKey: ['notes/tree'] })
    } catch (failure) {
      setPhase('idle')
      if (failure instanceof ApiError && failure.status === 409 && failure.code === 'stale_note') {
        try {
          const theirs = await readCurrentNote(path)
          setConflict({ base: snapshot, theirs, mine: content }); setPhase('conflict')
        } catch (refreshFailure) { setError(refreshFailure) }
      } else setError(failure)
    } finally { latest.current.busy = false }
  }
  const actions = useRef({ write, discard, canEdit, revisionRef, ask: (text?: string) => {
    if (confirmEditorLeave()) askAgent({ notePath: path, ref: revisionRef, selection: text })
  } })
  actions.current = { write, discard, canEdit, revisionRef, ask: (text?: string) => {
    if (confirmEditorLeave()) askAgent({ notePath: path, ref: revisionRef, selection: text })
  } }
  useEffect(() => {
    const command = (event: Event) => {
      const detail = (event as CustomEvent<{ command: EditorCommand; path?: string; exactPath?: boolean }>).detail
      if (!detail || !ownsStatus || (detail.path ? detail.path !== path : split) || latest.current.busy) return
      switch (detail.command) {
        case 'view':
          setMode('view'); setBlame(false); setSelection(null)
          break
        case 'edit':
        case 'preview':
          if (actions.current.canEdit && !actions.current.revisionRef) {
            setMode(detail.command === 'preview' ? 'split' : 'edit'); setBlame(false); setSelection(null)
          }
          break
        case 'discard':
          actions.current.discard()
          break
        case 'save':
          if (latest.current.dirty) void actions.current.write()
          break
        case 'blame':
          if (latest.current.mode === 'view' || actions.current.discard()) { setBlame(value => !value); setSelection(null) }
          break
        case 'ask':
          actions.current.ask()
          break
        case 'new':
        case 'rename':
        case 'delete':
          break // File operations are handled once by the explorer.
      }
    }
    window.addEventListener('workspace-editor-command', command)
    return () => window.removeEventListener('workspace-editor-command', command)
  }, [path, split, ownsStatus])
  function captureSelection() {
    const selected = window.getSelection()
    if (!selected || selected.isCollapsed || !contentRef.current?.contains(selected.anchorNode) || !contentRef.current.contains(selected.focusNode)) { setSelection(null); return }
    const rect = selected.getRangeAt(0).getBoundingClientRect()
    setSelection({ text: selected.toString(), top: Math.max(8, Math.min(window.innerHeight - 56, rect.bottom + 8)), left: Math.max(8, Math.min(window.innerWidth - 200, rect.left)) })
  }
  async function images(files: File[]) {
    if (!canEdit || revisionRef || latest.current.busy || !baseline.current) return
    latest.current.busy = true; setUploading(true); setError(null)
    const links: string[] = []
    try {
      let assetBase = baseline.current.updatedSha
      for (const file of files) {
        const uploaded = await uploadNoteImage(file, path, assetBase)
        assetBase = uploaded.mergeSha
        const snapshot = await readNoteSnapshot(path, uploaded.mergeSha)
        if (snapshot.content === baseline.current.content) baseline.current = { ...baseline.current, updatedSha: uploaded.mergeSha }
        else setExternal(snapshot)
        links.push(uploaded.markdown)
      }
      notify({ title: '이미지를 첨부했습니다. 노트를 저장하면 링크가 반영됩니다.', tone: 'success' })
    } catch (failure) { setError(failure) }
    finally { latest.current.busy = false; setUploading(false) }
    return links.length ? `\n${links.join('\n')}\n` : undefined
  }
  async function prepareRestore() {
    if (!canEdit || !revisionRef || latest.current.busy) return
    latest.current.busy = true; setPreparingRestore(true); setError(null)
    try { setRestore(await readCurrentNote(path)) }
    catch (failure) { setError(failure) }
    finally { latest.current.busy = false; setPreparingRestore(false) }
  }
  async function restoreVersion() {
    if (!canEdit || !revisionRef || !note.data || !restore || latest.current.busy) return
    if (!window.confirm('현재 노트 내용을 이 버전으로 복원하시겠습니까? 새 커밋이 생성됩니다.')) return
    latest.current.busy = true; setPhase('saving'); setError(null)
    try {
      const result = await saveNote(path, note.data.content, restore.updatedSha, `revert(wiki): restore ${path} to ${note.data.updatedSha.slice(0, 8)}`)
      const saved = await readNoteSnapshot(path, result.mergeSha)
      queryClient.setQueryData(['notes/content', path], saved)
      setRestore(null); setPhase('saved'); notify({ title: '현재 버전을 복원했습니다. 현재 노트에서 확인해 주세요.', tone: 'success' })
    } catch (failure) {
      setPhase('idle')
      if (failure instanceof ApiError && failure.code === 'stale_note') {
        try { setRestore(await readCurrentNote(path)); notify({ title: '현재 노트가 변경되었습니다. 최신 차이를 확인하고 다시 복원해 주세요.' }) }
        catch (refreshFailure) { setError(refreshFailure) }
      } else setError(failure)
    }
    finally { latest.current.busy = false }
  }
  const preview = mode === 'view' ? note.data?.body ?? '' : previewBody(draft)

  return <section aria-label={split ? '분할 노트 본문' : '노트 본문'} className={cn('relative flex h-full min-h-0 min-w-0 flex-col rounded-lg border', className)} onKeyDown={event => {
    if ((event.target as HTMLElement).closest('[role="dialog"]')) return
    if (event.key === 'Escape' && (mode !== 'view' || dirty) && !(event.target as HTMLElement).closest('.cm-editor')) { event.preventDefault(); discard() }
  }}>
    <header className={cn('shrink-0 space-y-2 border-b sm:p-4', blame ? 'p-2' : 'p-3')}>
      <div className={blame ? 'hidden sm:block' : undefined}><Breadcrumbs path={path} title={title} /></div>
      <div className="flex items-start justify-between gap-2">
        <Heading className={cn('min-w-0 break-words text-xl font-bold tracking-tight', blame && 'sr-only sm:not-sr-only')}>{title}{dirty && <span className="ml-2 text-sm text-warning" aria-label="저장하지 않은 변경사항">●</span>}</Heading>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="icon-sm" aria-label={favorite ? '즐겨찾기에서 제거' : '즐겨찾기에 추가'} aria-pressed={favorite} title="즐겨찾기" onClick={() => toggleFavorite(path)}><Star aria-hidden="true" className={favorite ? 'fill-current text-warning' : ''} /></Button>
          <Button variant="ghost" size="icon-sm" nativeButton={false} aria-label="이 노트의 변경 이력" title="변경 이력" render={<Link href={`/history?path=${encodeURIComponent(path)}`} />}><History aria-hidden="true" /></Button>
        </div>
      </div>
      <p className={cn('break-all text-xs text-muted-foreground', blame && 'hidden sm:block')}>{path}{split && <span className="ml-2">· 분할 보기</span>}</p>
      {note.data && <div className="flex flex-wrap gap-2">
        {canEdit && !revisionRef && <div role="group" aria-label="노트 보기 모드" className="flex gap-1">
          {(['view', 'edit', 'split'] as const).map(value => <Button key={value} size="sm" variant={mode === value ? 'secondary' : 'ghost'} aria-pressed={mode === value} disabled={busy} onClick={() => { setMode(value); setBlame(false); setSelection(null) }}>{value === 'view' ? '읽기' : value === 'edit' ? <><Pencil aria-hidden="true" />편집</> : '편집 + 미리보기'}</Button>)}
        </div>}
        <Button size="sm" variant={blame ? 'secondary' : 'ghost'} aria-pressed={blame} disabled={busy} onClick={() => { if (mode === 'view' || discard()) setBlame(value => !value) }}><GitCommitHorizontal aria-hidden="true" />줄별 이력</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => actions.current.ask()}><MessageCircle aria-hidden="true" /><span className={blame ? 'sr-only sm:not-sr-only' : undefined}>이 노트에 대해 묻기</span></Button>
        {dirty && canEdit && !revisionRef && <><Button size="sm" disabled={busy} onClick={() => void write()}><Save aria-hidden="true" />{phase === 'saving' ? '저장 중…' : '저장'}</Button><Button size="sm" variant="outline" disabled={busy} onClick={discard}>변경 버리기</Button></>}
      </div>}
      {mode !== 'view' && <div className="space-y-1"><Label htmlFor={`commit-message-${split ? 'split' : 'main'}`}>커밋 메시지</Label><Input id={`commit-message-${split ? 'split' : 'main'}`} value={message} maxLength={2000} placeholder={defaultMessage} disabled={busy} onChange={event => setMessage(event.target.value)} /><p className="text-xs text-muted-foreground">Ctrl/Cmd + S 저장 · Esc 변경 버리기 · [[ 노트 링크 자동완성 · 이미지 붙여넣기/끌어놓기{uploading && ' · 이미지 업로드 중…'}</p></div>}
      {revisionRef && note.data && <div role="status" className="space-y-2 rounded-md border bg-muted/50 p-3 text-sm">
        <p>과거 버전 <code>{note.data.updatedSha.slice(0, 8)}</code> · 읽기 전용{commit.data && <> · {commit.data.commit.authorName} · {new Date(commit.data.commit.date).toLocaleString('ko-KR')}</>}</p>
        {commit.isPending && <p>커밋 정보를 불러오는 중…</p>}
        {commit.isError && <><ErrorNotice error={commit.error} /><Button size="sm" variant="outline" onClick={() => void commit.refetch()}>커밋 정보 다시 시도</Button></>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" nativeButton={false} render={<Link href={noteHref(path)} />}>현재 버전 열기</Button>
          <Button size="sm" variant="outline" nativeButton={false} render={<Link href={`/history/compare?base=${encodeURIComponent(note.data.updatedSha)}&head=main&path=${encodeURIComponent(path)}`} />}>현재와 비교</Button>
          {canEdit && <Button size="sm" disabled={busy} onClick={() => void prepareRestore()}>{preparingRestore ? '현재 버전 불러오는 중…' : '이 버전으로 복원'}</Button>}
        </div>
      </div>}
      {external && dirty && <div role="alert" className="space-y-2 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm"><p className="font-medium">다른 곳에서 변경됨</p><p>다른 사용자가 이 노트를 변경했습니다. 내 편집 내용은 유지됩니다.</p><Button size="sm" variant="outline" disabled={busy} onClick={() => { if (baseline.current) { setConflict({ base: baseline.current, theirs: external, mine: draft }); setPhase('conflict') } }}>변경사항 비교</Button></div>}
      {error != null && <ErrorNotice error={error} />}
    </header>
    <div ref={scrollerRef} tabIndex={0} aria-label={split ? '분할 노트 읽기 영역' : '노트 읽기 영역'} className={cn('min-h-0 flex-1 overscroll-contain focus-visible:outline-2 focus-visible:outline-ring', blame ? 'flex min-w-0 flex-col overflow-hidden p-3' : 'overflow-auto p-3 sm:p-5')}>
      {note.isPending && <Loading label="노트를 불러오는 중" />}
      {note.isError && <div className="mb-4 space-y-3"><ErrorNotice error={note.error} /><Button variant="outline" disabled={note.isFetching} onClick={() => void note.refetch()}>다시 시도</Button></div>}
      {note.data && (blame ? <BlameView className="min-h-0 flex-1" path={path} ref={note.data.updatedSha} content={note.data.content} /> : <div className={`grid min-w-0 gap-5 ${mode === 'split' ? 'xl:grid-cols-2' : ''}`}>
        {mode !== 'view' && <div className="min-w-0 overflow-hidden rounded-md border"><MarkdownEditor value={draft} files={tree.data?.files ?? []} disabled={busy || !canEdit} onChange={value => { setDraft(value); setPhase('idle') }} onDiscard={discard} onCursor={setCursor} onSelection={text => setSelection(text ? { text, top: 80, left: 16 } : null)} onImages={images} /></div>}
        {mode !== 'edit' && <article className="min-w-0 space-y-5"><Properties frontmatter={frontmatter} /><Outline contentRef={contentRef} scrollerRef={scrollerRef} revision={`${path}:${note.data.updatedSha}:${mode === 'split' ? draft : ''}`} /><div ref={contentRef} onMouseUp={captureSelection} onKeyUp={captureSelection}>{preview.trim() ? <Markdown content={preview} path={path} split={split} ref={revisionRef ? note.data.updatedSha : baseline.current?.updatedSha ?? note.data.updatedSha} /> : <EmptyState title="본문이 없는 노트입니다" />}</div></article>}
      </div>)}
    </div>
    {selection && <Button className="fixed z-40 shadow-lg" style={{ top: selection.top, left: selection.left }} size="sm" disabled={busy} onMouseDown={event => event.preventDefault()} onClick={() => actions.current.ask(selection.text)}><MessageCircle aria-hidden="true" />도니에게 묻기</Button>}
    <ReaderDialog open={Boolean(conflict)} onClose={() => { if (!busy) { setConflict(null); setPhase('idle') } }} title="노트 변경사항 충돌" description="편집을 시작한 버전, 내 변경사항, 저장소의 최신 변경사항을 비교한 뒤 선택하세요.">
      {error != null && <ErrorNotice error={error} />}
      {conflict && <><section><h3 className="mb-2 font-medium">기준 버전 → 내 변경사항</h3><DiffView before={conflict.base.content} after={conflict.mine} mode="split" /></section><section><h3 className="mb-2 font-medium">기준 버전 → 최신 저장소 버전</h3><DiffView before={conflict.base.content} after={conflict.theirs.content} mode="split" /></section><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => { if (!window.confirm('내 변경사항을 버리고 최신 버전을 불러오시겠습니까?')) return; acceptSnapshot(conflict.theirs); setPhase('idle'); notify({ title: '최신 버전을 불러왔습니다.' }) }}>최신 버전 불러오기</Button><Button variant="outline" onClick={() => { void navigator.clipboard.writeText(conflict.mine).then(() => notify({ title: '내 변경사항을 복사했습니다.', tone: 'success' })).catch(setError) }}>내 내용 복사</Button><Button variant="destructive" disabled={busy || !canEdit || Boolean(revisionRef)} onClick={() => { if (!window.confirm('최신 저장소 내용을 내 변경사항으로 덮어쓰시겠습니까? 다른 사용자의 변경사항이 대체됩니다.')) return; void write(conflict.mine, conflict.theirs) }}>내 내용으로 덮어쓰기</Button></div></>}
    </ReaderDialog>
    <ReaderDialog open={Boolean(restore)} onClose={() => { if (!busy) setRestore(null) }} title="과거 버전 복원 미리보기" description="현재 노트와 복원할 버전을 비교합니다. 복원은 이력을 삭제하지 않고 새 커밋을 만듭니다.">
      {error != null && <ErrorNotice error={error} />}
      {restore && note.data && <><DiffView before={restore.content} after={note.data.content} mode="split" /><div className="flex gap-2"><Button disabled={busy} onClick={() => void restoreVersion()}>{phase === 'saving' ? '복원 중…' : '이 버전으로 복원'}</Button><Button variant="outline" disabled={busy} onClick={() => setRestore(null)}>취소</Button></div></>}
    </ReaderDialog>
  </section>
}
