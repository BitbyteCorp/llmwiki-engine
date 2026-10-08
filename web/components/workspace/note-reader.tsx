'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useSearchParams } from 'next/navigation'
import { History, Star, MessageCircle, GitCommitHorizontal, Ellipsis } from 'lucide-react'
import { api } from '@/lib/api'
import { onLiveEvent } from '@/lib/events'
import { askAgent } from '@/lib/chat-context'
import { EmptyState, ErrorNotice, Loading, noteHref } from '@/components/common'
import { Markdown } from '@/components/markdown'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useWorkspace } from '@/components/workspace/context'
import type { GroupId } from '@/components/workspace/context'
import { Breadcrumbs } from '@/components/workspace/breadcrumbs'
import { Outline, useDomHeadings } from '@/components/workspace/outline'
import { Properties } from '@/components/workspace/properties'
import { notify } from '@/components/notifications'
import { cn } from '@/lib/utils'
import { ReaderDialog } from '@/components/editor/reader-dialog'
import { readNoteSnapshot } from '@/components/editor/api'
import { acquireAutosave, releaseAutosave } from '@/components/editor/autosave'
import type { AutosaveSession } from '@/components/editor/autosave'
import { registerEditorGuard, setEditorStatus, confirmEditorLeave, isDraftTransferring, stashDraft, takeDraft, subscribeDraft } from '@/components/editor/state'
import type { EditorStatus, EditorCommand } from '@/components/editor/state'
import type { EditorHeading, EditorLinkTarget, EditorSelection, MarkdownEditorHandle } from '@/components/editor/markdown-editor'
import { DiffView } from '@/components/history/diff-view'
import { BlameView } from '@/components/history/blame-view'
import { compareHref, historyHref } from '@/components/history/commit-meta'

const MarkdownEditor = dynamic(() => import('@/components/editor/markdown-editor').then(module => module.MarkdownEditor), {
  ssr: false,
  loading: () => <Loading label="편집기를 불러오는 중" />,
})
const RestoreVersionDialog = dynamic(() => import('@/components/history/restore-version-dialog').then(module => module.RestoreVersionDialog))
const noSubscribe = () => () => {}
const emptySnapshot = () => null

function urlFragment() {
  try { return decodeURIComponent(window.location.hash.slice(1)) } catch { return window.location.hash.slice(1) }
}

export function NoteReader({ path, groupId, revisionRef, className }: { path: string; groupId: GroupId; revisionRef?: string; className?: string }) {
  const { favoritePaths, toggleFavorite, rememberTitle, setNoteInfo, activeGroupId, isEditorOwner, openNote, groupOrder } = useWorkspace()
  const isActive = activeGroupId === groupId
  const searchParams = useSearchParams()
  const targetPath = revisionRef ? searchParams.get('current') || path : path
  const queryClient = useQueryClient()
  const queryKey = revisionRef ? ['notes/content', path, revisionRef] : ['notes/content', path]
  const note = useQuery({ queryKey, queryFn: () => api.note(path, revisionRef), enabled: Boolean(path) })
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  const tree = useQuery({ queryKey: ['notes/tree'], queryFn: api.tree })
  const commit = useQuery({ queryKey: ['commit', note.data?.updatedSha], queryFn: () => api.commit(note.data!.updatedSha), enabled: Boolean(revisionRef && note.data) })
  const ownsStatus = isEditorOwner(groupId, path)
  const canRestore = me.data?.user.role === 'admin' || me.data?.user.role === 'editor'
  const editable = ownsStatus && canRestore && !revisionRef
  const scrollerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<MarkdownEditorHandle>(null)
  const [session, setSession] = useState<AutosaveSession | null>(null)
  const snapshot = useSyncExternalStore(session?.subscribe ?? noSubscribe, session?.getSnapshot ?? emptySnapshot, emptySnapshot)
  const [variant, setVariant] = useState<'live' | 'source'>('live')
  const variantRef = useRef(variant)
  variantRef.current = variant
  const mode: EditorStatus['mode'] = editable ? variant : 'view'
  const draft = snapshot?.draft ?? note.data?.content ?? ''
  const phase = snapshot?.phase ?? 'idle'
  const busy = snapshot?.busy ?? false
  const dirty = Boolean(snapshot?.baseline && draft !== snapshot.baseline.content)
  const savedNote = editable ? snapshot?.baseline ?? note.data : note.data
  const frontmatter = savedNote?.frontmatter ?? {}
  const title = typeof frontmatter.title === 'string' && frontmatter.title.trim()
    ? frontmatter.title.trim() : path.split('/').pop()?.replace(/\.md$/i, '') || '노트'
  const [cursor, setCursor] = useState<EditorStatus['cursor']>()
  const [readerError, setReaderError] = useState<unknown>(null)
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [blame, setBlame] = useState(false)
  const [conflictDismissed, setConflictDismissed] = useState(false)
  const [fragment, setFragment] = useState<{ path: string; id: string } | null>(null)
  const [selection, setSelection] = useState<{ text: string; top: number; left: number } | null>(null)
  const [headings, setHeadings] = useState<EditorHeading[]>([])
  const [activeHeading, setActiveHeading] = useState('')
  const dom = useDomHeadings(contentRef, scrollerRef, !editable && !blame && note.data ? `${path}:${note.data.updatedSha}` : null)
  const favorite = favoritePaths.includes(path)
  const Heading = isActive ? 'h1' : 'h2'
  const error = snapshot?.error ?? readerError
  const conflict = snapshot?.conflict
  const external = snapshot?.external
  useEffect(() => { setConflictDismissed(false) }, [conflict?.theirs])

  useEffect(() => {
    if (!editable) { setSession(null); return }
    const transfer = takeDraft(path)
    const acquired = acquireAutosave(path, transfer ? { baseline: transfer.baseline, draft: transfer.draft } : undefined)
    if (transfer?.mode === 'source' || transfer?.mode === 'live') setVariant(transfer.mode)
    setSession(acquired)
    // The old owner may unmount after the new owner mounts. Only transfer display
    // preference here: the shared session already owns the latest draft and SHA.
    const unsubscribe = subscribeDraft(path, () => {
      const incoming = takeDraft(path)
      if (incoming?.mode === 'source' || incoming?.mode === 'live') setVariant(incoming.mode)
    })
    return () => {
      unsubscribe()
      const value = acquired.getSnapshot()
      if (isDraftTransferring(path)) stashDraft(path, { baseline: value.baseline, draft: value.draft, mode: variantRef.current })
      releaseAutosave(acquired)
    }
  }, [path, editable])
  useEffect(() => {
    if (note.data && session) session.observeSnapshot(note.data)
  }, [note.data, session])
  useEffect(() => {
    if (!session || !snapshot?.baseline) return
    queryClient.setQueryData(['notes/content', path], snapshot.baseline)
    void queryClient.invalidateQueries({ queryKey: ['notes/tree'] })
  }, [session, snapshot?.baseline, path, queryClient])
  useEffect(() => {
    if (!ownsStatus) return
    setEditorStatus(path, { dirty, mode, phase, cursor })
  }, [path, dirty, mode, phase, cursor, ownsStatus])
  useEffect(() => {
    if (ownsStatus) return () => setEditorStatus(path, null)
  }, [path, ownsStatus])
  useEffect(() => {
    if (!session) return
    return registerEditorGuard(path, () => {
      const value = session.getSnapshot()
      if (!value.baseline || value.draft === value.baseline.content) return true
      if (value.phase === 'conflict' || value.phase === 'error') {
        if (!window.confirm('저장하지 않은 변경사항을 잃게 됩니다. 이동하시겠습니까?')) return false
        session.acceptSnapshot(value.external ?? value.baseline)
      } else void session.flush()
      return true
    })
  }, [path, session])
  useEffect(() => { setRestoreOpen(false) }, [path, revisionRef, targetPath])
  useEffect(() => { if (savedNote) rememberTitle(savedNote.path, title) }, [savedNote, title, rememberTitle])
  useEffect(() => {
    if (!isActive) return
    const previous = document.title
    document.title = `${title} · LLM Wiki`
    return () => { document.title = previous }
  }, [isActive, title])
  useEffect(() => {
    if (!isActive) return
    setNoteInfo(savedNote ? { path: savedNote.path, updatedSha: savedNote.updatedSha, body: savedNote.body } : null)
    return () => setNoteInfo(null)
  }, [isActive, savedNote, setNoteInfo])
  useEffect(() => {
    if (revisionRef) return
    return onLiveEvent('main.updated', event => {
      if (Array.isArray(event.paths) && !event.paths.includes(path)) return
      if (session?.getSnapshot().busy) return
      void readNoteSnapshot(path).then(value => {
        if (session?.getSnapshot().busy) return
        if (session) session.observeSnapshot(value)
        queryClient.setQueryData(['notes/content', path], value)
        if (!session || session.getSnapshot().draft === value.content) notify({ title: '최신 변경사항을 불러왔습니다.' })
      }).catch(setReaderError)
    })
  }, [path, revisionRef, queryClient, session])
  useEffect(() => { scrollerRef.current?.scrollTo({ top: 0 }); setFragment({ path, id: '' }) }, [path])
  useEffect(() => {
    if (!isActive) return
    const changed = () => setFragment({ path, id: urlFragment() })
    changed()
    window.addEventListener('hashchange', changed)
    return () => window.removeEventListener('hashchange', changed)
  }, [path, isActive])
  useEffect(() => {
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ groupId: GroupId; path: string; fragment: string }>).detail
      if (detail?.groupId === groupId && detail.path === path && typeof detail.fragment === 'string') setFragment({ path, id: detail.fragment })
    }
    window.addEventListener('workspace-group-fragment', changed)
    return () => window.removeEventListener('workspace-group-fragment', changed)
  }, [path, groupId])
  useEffect(() => {
    if (!note.data) return
    const frame = requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('workspace-reader-ready', { detail: { groupId, path } })))
    return () => cancelAnimationFrame(frame)
  }, [note.data, path, groupId, isActive])
  function scrollToHeading(id: string) {
    if (editable) return editorRef.current?.scrollToHeading(id) ?? false
    const scroller = scrollerRef.current
    const target = Array.from(contentRef.current?.querySelectorAll<HTMLElement>('[id]') ?? []).find(element => element.id === id)
    if (!scroller || !target) return false
    scroller.scrollTo({ top: scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16 })
    target.setAttribute('tabindex', '-1'); target.focus({ preventScroll: true })
    target.addEventListener('blur', () => target.removeAttribute('tabindex'), { once: true })
    return true
  }
  useEffect(() => {
    if (!note.data || fragment?.path !== path || !fragment.id || blame) return
    const frame = requestAnimationFrame(() => scrollToHeading(fragment.id))
    return () => cancelAnimationFrame(frame)
  }, [path, fragment, note.data, mode, headings, blame])
  function selectHeading(id: string) {
    scrollToHeading(id)
    setActiveHeading(id)
    if (!isActive) openNote(path, { group: groupId, fragment: id, ref: revisionRef })
    else window.history.replaceState(window.history.state, '', `#${encodeURIComponent(id)}`)
  }
  function navigate(target: EditorLinkTarget, options: { alt: boolean }) {
    if (target.kind === 'note') openNote(target.path, { fragment: target.fragment, pin: target.path !== path, group: options.alt ? groupOrder.find(id => id !== groupId) ?? 'side' : groupId })
    else if (target.kind === 'fragment') selectHeading(target.id)
    else window.open(target.href, '_blank', 'noopener,noreferrer')
  }
  function ask(text?: string) { if (confirmEditorLeave()) askAgent({ notePath: path, ref: revisionRef, selection: text }) }
  async function toggleBlame() {
    if (session && session.getSnapshot().baseline && session.getSnapshot().draft !== session.getSnapshot().baseline!.content) {
      await session.flush()
      const value = session.getSnapshot()
      if (value.phase === 'conflict' || value.phase === 'error' || value.draft !== value.baseline?.content) return
    }
    setBlame(value => !value); setSelection(null)
  }
  function toggleSource() { setVariant(value => value === 'live' ? 'source' : 'live'); setBlame(false); setSelection(null) }
  const actions = useRef({ session, ask, toggleBlame, toggleSource, editable })
  actions.current = { session, ask, toggleBlame, toggleSource, editable }
  useEffect(() => {
    const command = (event: Event) => {
      const detail = (event as CustomEvent<{ command: EditorCommand; path?: string; exactPath?: boolean }>).detail
      if (!detail) return
      if (detail.exactPath) { if (!ownsStatus || detail.path !== path) return }
      else if (!isActive || (detail.path && detail.path !== path)) return
      switch (detail.command) {
        case 'source': if (actions.current.editable) actions.current.toggleSource(); break
        case 'save': void actions.current.session?.flush(); break
        case 'blame': void actions.current.toggleBlame(); break
        case 'ask': actions.current.ask(); break
        case 'new': case 'rename': case 'delete': break // The explorer owns file operations.
      }
    }
    window.addEventListener('workspace-editor-command', command)
    return () => window.removeEventListener('workspace-editor-command', command)
  }, [path, isActive, ownsStatus])
  function editorSelection(value: EditorSelection | null) {
    setSelection(value?.text ? { text: value.text, top: Math.max(8, Math.min(window.innerHeight - 56, value.rect.bottom + 8)), left: Math.max(8, Math.min(window.innerWidth - 200, value.rect.left)) } : null)
  }
  function captureSelection() {
    const selected = window.getSelection()
    if (!selected || selected.isCollapsed || !contentRef.current?.contains(selected.anchorNode) || !contentRef.current.contains(selected.focusNode)) { setSelection(null); return }
    editorSelection({ text: selected.toString(), rect: selected.getRangeAt(0).getBoundingClientRect() })
  }
  useEffect(() => {
    const clear = () => setSelection(null)
    const scroller = scrollerRef.current
    scroller?.addEventListener('scroll', clear, { passive: true })
    window.addEventListener('resize', clear)
    return () => { scroller?.removeEventListener('scroll', clear); window.removeEventListener('resize', clear) }
  }, [])

  return <section aria-label="노트 본문" className={cn('relative flex h-full min-h-0 min-w-0 flex-col rounded-lg border', className)}>
    <header className={cn('shrink-0 space-y-1.5 border-b px-3 sm:px-4 sm:py-2.5', blame ? 'py-1.5' : 'py-2')}>
      <div className="flex items-center gap-2">
        <div className={cn('min-w-0 flex-1', blame && 'hidden sm:block')}><Breadcrumbs path={path} title={title} /></div>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Button variant="ghost" size="icon-xs" aria-label={favorite ? '즐겨찾기에서 제거' : '즐겨찾기에 추가'} aria-pressed={favorite} title="즐겨찾기" onClick={() => toggleFavorite(path)}><Star aria-hidden="true" className={favorite ? 'fill-current text-warning' : ''} /></Button>
          <Button variant="ghost" size="icon-xs" nativeButton={false} aria-label="변경 이력" title="변경 이력" render={<Link href={historyHref(targetPath)} />}><History aria-hidden="true" /></Button>
          <Button size="icon-xs" variant={blame ? 'secondary' : 'ghost'} aria-label="줄별 작성자" aria-pressed={blame} title="줄별 작성자" onClick={() => void toggleBlame()}><GitCommitHorizontal aria-hidden="true" /></Button>
          <Button size="icon-xs" variant="ghost" aria-label="이 노트에 대해 묻기" title="이 노트에 대해 묻기" onClick={() => ask()}><MessageCircle aria-hidden="true" /></Button>
          {editable && <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label="노트 더보기" title="노트 더보기" />}><Ellipsis aria-hidden="true" /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={toggleSource}>{variant === 'live' ? '원문 편집' : '라이브 편집'}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Heading className={cn('min-w-0 break-words text-lg font-bold leading-tight tracking-tight', blame && 'sr-only sm:not-sr-only')}>{title}{dirty && <span className="ml-2 text-sm text-warning" aria-label="저장하지 않은 변경사항">●</span>}</Heading>
        {editable && <span role="status" className="text-xs text-muted-foreground">{phase === 'saving' ? '저장 중…' : phase === 'saved' ? '저장됨' : phase === 'conflict' ? '충돌' : phase === 'error' ? <button type="button" className="text-destructive hover:underline" onClick={() => void session?.flush({ retry: true })}>저장 실패 · 다시 시도</button> : null}</span>}
      </div>
      {!ownsStatus && <p className="text-xs text-muted-foreground">다른 그룹에서 편집 중 · 읽기 전용</p>}
      {revisionRef && note.data && <div role="status" className="space-y-1.5 rounded-md border bg-muted/50 px-2 py-1.5 text-label-13">
        <p>{commit.data ? new Date(commit.data.commit.committedAt).toLocaleString('ko-KR') : note.data.updatedSha.slice(0, 8)}의 과거 버전을 보고 있습니다</p>
        {path !== targetPath && <p className="break-all text-xs text-muted-foreground">이 버전의 당시 이름: {path}</p>}
        <div className="flex flex-wrap gap-1">
          {canRestore && <Button size="xs" onClick={() => setRestoreOpen(true)}>이 버전으로 복원…</Button>}
          <Button size="xs" variant="outline" nativeButton={false} render={<Link href={compareHref(note.data.updatedSha, 'main', targetPath)} />}>현재와 비교</Button>
          <Button size="xs" variant="outline" nativeButton={false} render={<Link href={noteHref(targetPath)} />}>현재 버전 열기</Button>
        </div>
      </div>}
      {external && dirty && <div role="alert" className="space-y-2 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm"><p className="font-medium">다른 곳에서 변경됨</p><p>다른 사용자가 이 노트를 변경했습니다. 내 편집 내용은 유지됩니다.</p>{conflict && <Button size="xs" variant="outline" onClick={() => setConflictDismissed(false)}>변경사항 비교</Button>}</div>}
      {error != null && <ErrorNotice error={error} />}
    </header>
    <div ref={scrollerRef} tabIndex={0} aria-label={editable ? '노트 편집 영역' : '노트 읽기 영역'} className={cn('min-h-0 flex-1 overscroll-contain focus-visible:outline-2 focus-visible:outline-ring', blame ? 'flex min-w-0 flex-col overflow-hidden p-3' : 'overflow-auto p-3 sm:p-5')}>
      {note.isPending && <Loading label="노트를 불러오는 중" />}
      {note.isError && <div className="mb-4 space-y-3"><ErrorNotice error={note.error} /><Button variant="outline" disabled={note.isFetching} onClick={() => void note.refetch()}>다시 시도</Button></div>}
      {note.data && (blame ? <BlameView className="min-h-0 flex-1" path={path} ref={savedNote?.updatedSha ?? note.data.updatedSha} content={savedNote?.content ?? note.data.content} /> : editable ? <div className="min-w-0 space-y-5">
        <Outline headings={headings} active={activeHeading} onSelect={selectHeading} />
        {session && <MarkdownEditor ref={editorRef} value={draft} variant={variant} path={path} assetRef={savedNote?.updatedSha} frontmatter={frontmatter} files={tree.data?.files ?? []} readOnly={false} scrollerRef={scrollerRef} onChange={session.setDraft} onCursor={setCursor} onSelection={editorSelection} onImages={session.images} onHeadings={setHeadings} onActiveHeading={setActiveHeading} onNavigate={navigate} />}
      </div> : <article className="min-w-0 space-y-5"><Properties frontmatter={frontmatter} /><Outline headings={dom.headings} active={dom.active} onSelect={selectHeading} /><div ref={contentRef} onMouseUp={captureSelection} onKeyUp={captureSelection}>{note.data.body.trim() ? <Markdown content={note.data.body} path={path} groupId={groupId} ref={note.data.updatedSha} /> : <EmptyState title="본문이 없는 노트입니다" />}</div></article>)}
    </div>
    {selection && <Button className="fixed z-40 shadow-lg" style={{ top: selection.top, left: selection.left }} size="sm" onMouseDown={event => event.preventDefault()} onClick={() => ask(selection.text)}><MessageCircle aria-hidden="true" />도니에게 묻기</Button>}
    <ReaderDialog open={Boolean(conflict) && !conflictDismissed} onClose={() => { if (!busy) setConflictDismissed(true) }} title="노트 변경사항 충돌" description="편집을 시작한 버전, 내 변경사항, 저장소의 최신 변경사항을 비교한 뒤 선택하세요.">
      {error != null && <ErrorNotice error={error} />}
      {conflict && <><section><h3 className="mb-2 font-medium">기준 버전 → 내 변경사항</h3><DiffView before={conflict.base.content} after={conflict.mine} /></section><section><h3 className="mb-2 font-medium">기준 버전 → 최신 저장소 버전</h3><DiffView before={conflict.base.content} after={conflict.theirs.content} /></section><div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy} onClick={() => { if (!window.confirm('내 변경사항을 버리고 최신 버전을 불러오시겠습니까?')) return; session?.acceptSnapshot(conflict.theirs); notify({ title: '최신 버전을 불러왔습니다.' }) }}>최신 버전 불러오기</Button>
        <Button variant="outline" onClick={() => { void navigator.clipboard.writeText(conflict.mine).then(() => notify({ title: '내 변경사항을 복사했습니다.', tone: 'success' })).catch(setReaderError) }}>내 내용 복사</Button>
        <Button disabled={busy} onClick={() => { if (window.confirm('최신 저장소 내용을 내 내용으로 덮어쓰시겠습니까?')) void session?.flush({ overwrite: conflict.theirs }) }}>내 내용으로 덮어쓰기</Button>
      </div></>}
    </ReaderDialog>
    {revisionRef && note.data && <RestoreVersionDialog targetPath={targetPath} historicalPath={path} versionSha={note.data.updatedSha} versionLabel={commit.data ? `${commit.data.commit.subject} · ${new Date(commit.data.commit.committedAt).toLocaleString('ko-KR')}` : undefined} open={restoreOpen} onOpenChange={setRestoreOpen} />}
  </section>
}
