'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, request } from '@/lib/api'
import { ErrorNotice, Loading } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useWorkspace } from '@/components/workspace/context'
import { notify } from '@/components/notifications'
import type { EditorCommand } from './state'
import { confirmEditorLeave } from './state'

type Operation = { kind: 'new' | 'folder' | 'move' | 'delete'; path: string }
type WriteResult = { mergeSha: string; jobId: string }
type Links = { backlinks: { path: string; title: string }[] }

export function parentFolder(path: string) { return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '' }
export function validateNotePath(path: string, folder = false): string | null {
  if (!path || path.length > 4096 || path.startsWith('/') || /^[a-z]:/i.test(path) || /[\\\0]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) return '저장소 기준 상대 경로를 입력하세요. 빈 폴더명, . 또는 .., 절대 경로는 사용할 수 없습니다.'
  if (!folder && !path.endsWith('.md')) return '노트 경로는 .md로 끝나야 합니다.'
  if (path === 'raw' || path.startsWith('raw/')) return 'raw 폴더의 원본 자료는 이동·삭제할 수 없습니다. 다른 폴더를 선택하세요.'
  return null
}

export function useFileOperations(files: string[]) {
  const workspace = useWorkspace()
  const client = useQueryClient()
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  const canWrite = me.data?.user.role === 'editor' || me.data?.user.role === 'admin'
  const [operation, setOperation] = useState<Operation | null>(null)
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  const [value, setValue] = useState('')
  const [title, setTitle] = useState('')
  const [tags, setTags] = useState('')
  const [folder, setFolder] = useState('')
  const [virtualFolders, setVirtualFolders] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<unknown>(null)
  const [overwrite, setOverwrite] = useState<string | null>(null)
  const [replacementRemoved, setReplacementRemoved] = useState<string | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const pendingFocus = useRef<HTMLElement | null>(null)
  const links = useQuery({ queryKey: ['links', operation?.path], queryFn: () => request<Links>(`/api/links?${new URLSearchParams({ path: operation!.path })}`), enabled: operation?.kind === 'delete' })
  const folders = [...new Set([...virtualFolders, ...files.flatMap(path => path.split('/').slice(0, -1).map((_, index) => path.split('/').slice(0, index + 1).join('/')))])].sort((a, b) => a.localeCompare(b, 'ko'))

  function start(kind: Operation['kind'], path = '', destination?: string) {
    if (!canWrite || busyRef.current) return
    pendingFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setError(null); setOverwrite(null); setReplacementRemoved(null)
    setValue(kind === 'move' ? (destination ?? path) : kind === 'new' ? (destination ?? `${path ? `${path}/` : ''}새 노트.md`) : path)
    setFolder(kind === 'move' ? parentFolder(destination ?? path) : path)
    setTitle(kind === 'new' && destination ? destination.split('/').pop()!.replace(/\.md$/, '') : ''); setTags(''); setOperation({ kind, path })
  }
  function dismiss() {
    if (busyRef.current) return
    setOperation(null); setOverwrite(null)
  }
  useEffect(() => {
    if (!operation) return
    const element = dialog.current
    element?.showModal()
    element?.querySelector<HTMLInputElement>('input')?.select()
    return () => { element?.close(); pendingFocus.current?.focus() }
  }, [operation])

  async function refresh() {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['notes/tree'] }),
      client.invalidateQueries({ queryKey: ['notes/content'] }),
      client.invalidateQueries({ queryKey: ['history'] }),
      client.invalidateQueries({ queryKey: ['links'] }),
      client.invalidateQueries({ queryKey: ['notes/resolve'] }),
    ])
  }
  async function currentHead(path?: string) {
    if (path) return (await api.note(path)).updatedSha
    const existing = (await api.tree()).files[0]
    if (existing) return (await api.note(existing)).updatedSha
    const latest = await request<{ commits: { sha: string }[] }>('/api/history?limit=1')
    if (!latest.commits[0]) throw new Error('저장소의 초기 커밋을 찾을 수 없습니다. 관리자에게 저장소 초기화를 요청하세요.')
    return latest.commits[0].sha
  }
  async function moveNote(from: string, to: string, replace = false) {
    if (from === to) throw new Error('현재 경로와 다른 경로를 입력하세요.')
    const validation = validateNotePath(to)
    if (validation) throw new Error(validation)
    const latestFiles = (await api.tree()).files
    const exists = latestFiles.includes(to)
    if (exists && !replace) { setOverwrite(to); return false }
    if (!confirmEditorLeave(exists ? [from, to] : [from])) return false
    let baseSha = await currentHead(from)
    if (exists) {
      const removed = await request<WriteResult>(`/api/notes?${new URLSearchParams({ path: to, baseSha })}`, { method: 'DELETE' })
      baseSha = removed.mergeSha
      setReplacementRemoved(to)
      workspace.removeNotePath(to)
      await refresh()
    }
    await request<WriteResult>('/api/notes/move', { method: 'POST', body: JSON.stringify({ from, to, baseSha }) })
    workspace.renameNotePath(from, to)
    notify({ title: `노트를 ${to}(으)로 이동했습니다.`, tone: 'success' })
    await refresh()
    return true
  }
  async function submit(replace = false) {
    if (!operation || busyRef.current) return
    setError(null); busyRef.current = true; setBusy(true)
    try {
      const path = value.trim()
      if (operation.kind === 'delete') {
        if (!confirmEditorLeave([operation.path])) return
        const baseSha = await currentHead(operation.path)
        await request<WriteResult>(`/api/notes?${new URLSearchParams({ path: operation.path, baseSha })}`, { method: 'DELETE' })
        workspace.removeNotePath(operation.path)
        notify({ title: '노트를 삭제했습니다. 변경 이력에서 복원할 수 있습니다.', tone: 'success' })
        await refresh()
      } else if (operation.kind === 'move') {
        if (!await moveNote(operation.path, path, replace)) return
      } else {
        const validation = validateNotePath(path, operation.kind === 'folder')
        if (validation) throw new Error(validation)
        if (operation.kind === 'folder') {
          if (folders.includes(path)) throw new Error('같은 폴더가 이미 있습니다.')
          if (files.includes(path)) throw new Error('같은 경로에 노트가 있습니다.')
          setVirtualFolders(previous => [...previous, path])
          workspace.revealFolder(path)
          notify({ title: '가상 폴더를 준비했습니다. 이 폴더에 첫 노트를 저장하면 저장소에 생성됩니다.' })
        } else {
          if (!title.trim()) throw new Error('노트 제목을 입력하세요.')
          const baseSha = await currentHead()
          const tagList = [...new Set(tags.split(',').map(tag => tag.trim()).filter(Boolean))]
          const content = `---\ntitle: ${JSON.stringify(title.trim())}\ntags: ${JSON.stringify(tagList)}\nupdated: ${JSON.stringify(new Date().toISOString())}\n---\n\n# ${title.trim()}\n\n`
          await request<WriteResult>('/api/notes', { method: 'PUT', body: JSON.stringify({ path, content, baseSha, create: true, message: `새 노트: ${title.trim()}` }) })
          await refresh()
          workspace.openNote(path, { pin: true })
          workspace.revealFolder(path)
          notify({ title: '새 노트를 만들었습니다. 노트의 편집 버튼으로 내용을 작성하세요.', tone: 'success' })
        }
      }
      setOperation(null); setOverwrite(null); setReplacementRemoved(null)
    } catch (failure) {
      setError(failure)
    } finally { busyRef.current = false; setBusy(false) }
  }
  async function renameInline(path: string, name: string): Promise<boolean> {
    if (!canWrite || busyRef.current) return false
    if (name === path.split('/').pop()) return true
    if (name.includes('/')) { setError(new Error('이름에는 /를 사용할 수 없습니다. 폴더 이동 메뉴를 이용하세요.')); return false }
    const to = `${parentFolder(path) ? `${parentFolder(path)}/` : ''}${name.trim()}`
    setError(null); busyRef.current = true; setBusy(true)
    try {
      const result = await moveNote(path, to)
      if (!result) {
        if ((await api.tree()).files.includes(to)) {
          setValue(to); setFolder(parentFolder(to)); setOperation({ kind: 'move', path })
        }
      }
      return result
    } catch (failure) { setError(failure); return false }
    finally { busyRef.current = false; setBusy(false) }
  }
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ command: EditorCommand; path?: string; exactPath?: boolean }>).detail
      if (!detail || !canWrite) return
      const path = detail.path ?? workspace.activePath
      if (detail.command === 'new') {
        if (detail.exactPath && detail.path) start('new', parentFolder(detail.path), detail.path)
        else start('new', path ? parentFolder(path) : '')
      }
      else if (detail.command === 'rename' && path && !path.startsWith('raw/')) start('move', path)
      else if (detail.command === 'delete' && path && !path.startsWith('raw/')) start('delete', path)
    }
    window.addEventListener('workspace-editor-command', listener)
    return () => window.removeEventListener('workspace-editor-command', listener)
  })
  async function copy(path: string, wikilink = false) {
    try {
      await navigator.clipboard.writeText(wikilink ? `[[${path.replace(/\.md$/, '')}]]` : path)
      notify({ title: wikilink ? '위키링크를 복사했습니다.' : '경로를 복사했습니다.', tone: 'success' }); setError(null)
    } catch { notify({ title: '클립보드에 접근할 수 없습니다. 아래 내용을 선택해 직접 복사하세요.', description: wikilink ? `[[${path.replace(/\.md$/, '')}]]` : path, tone: 'error' }) }
  }

  const panel = <>
    {!operation && error != null && <div className="px-2 pb-2"><ErrorNotice error={error} /><p className="mt-1 text-xs text-muted-foreground">입력 내용을 확인하고 같은 작업을 다시 시도하세요.</p><Button variant="ghost" size="sm" onClick={() => setError(null)}>닫기</Button></div>}
    {operation && mounted && createPortal(<dialog ref={dialog} aria-labelledby="editor-file-operation-title" className="workspace-dialog max-h-[85dvh] w-[min(32rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg" onCancel={event => { event.preventDefault(); dismiss() }}>
      <form className="space-y-3" onSubmit={event => { event.preventDefault(); void submit() }}>
        <h2 id="editor-file-operation-title" className="text-lg font-semibold">{operation.kind === 'new' ? '새 노트' : operation.kind === 'folder' ? '새 폴더' : operation.kind === 'move' ? '이름 변경 · 폴더 이동' : '노트 삭제'}</h2>
        {(operation.kind === 'delete' || operation.kind === 'move') && <p className="break-all text-label-13 text-muted-foreground">{operation.path}</p>}
        {operation.kind === 'folder' && <p className="text-label-13 text-muted-foreground">Git은 빈 폴더를 저장하지 않습니다. 여기서는 가상 폴더만 준비하며, 첫 노트를 만들 때 실제 폴더가 저장됩니다. 새로고침하면 빈 가상 폴더는 사라집니다.</p>}
        {operation.kind === 'move' && <div className="space-y-2"><Label htmlFor="editor-move-folder">대상 폴더</Label><select id="editor-move-folder" className="h-9 w-full rounded-md border bg-background px-2 text-sm" disabled={busy} value={folder} onChange={event => { setFolder(event.target.value); setValue(`${event.target.value ? `${event.target.value}/` : ''}${value.split('/').pop()}`); setOverwrite(null) }}><option value="">저장소 루트</option>{folders.map(path => <option key={path} value={path}>{path}</option>)}</select><p className="text-label-13 text-muted-foreground">아래 경로를 직접 입력하면 새 폴더로도 이동할 수 있습니다. 기존 위키링크는 자동 변경되지 않습니다.</p></div>}
        {operation.kind !== 'delete' && <div className="space-y-2"><Label htmlFor="editor-file-path">{operation.kind === 'folder' ? '폴더 경로' : '노트 경로 (.md)'}</Label><Input id="editor-file-path" required disabled={busy} value={value} onChange={event => { setValue(event.target.value); setOverwrite(null) }} autoComplete="off" /><p className="text-label-13 text-muted-foreground">예: wiki/주제/{operation.kind === 'folder' ? '새 폴더' : '새 노트.md'}</p></div>}
        {operation.kind === 'new' && <><div className="space-y-2"><Label htmlFor="editor-new-title">제목</Label><Input id="editor-new-title" required disabled={busy} value={title} onChange={event => setTitle(event.target.value)} /></div><div className="space-y-2"><Label htmlFor="editor-new-tags">태그 (쉼표로 구분)</Label><Input id="editor-new-tags" disabled={busy} value={tags} onChange={event => setTags(event.target.value)} /></div><p className="text-label-13 text-muted-foreground">title, tags, updated 메타데이터를 포함한 Markdown 노트로 저장됩니다.</p></>}
        {operation.kind === 'delete' && <><p className="text-label-13">이 노트를 삭제하시겠습니까? 내용은 변경 이력에 남으며 복원할 수 있습니다.</p>{links.isPending && <Loading label="이 노트를 참조하는 링크 확인 중…" />}{links.error && <div className="space-y-2"><ErrorNotice error={links.error} /><Button type="button" variant="outline" onClick={() => void links.refetch()}>링크 다시 확인</Button></div>}{links.data && <p className={links.data.backlinks.length ? 'rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-label-13' : 'text-label-13 text-muted-foreground'}>이 노트를 참조하는 노트 {links.data.backlinks.length}개{links.data.backlinks.length > 0 && '의 링크가 끊어집니다. 위키링크는 자동 수정되지 않습니다.'}</p>}</>}
        {replacementRemoved && <p role="alert" className="rounded-md border border-warning/40 px-3 py-2 text-label-13">대상 노트 {replacementRemoved}는 삭제 커밋으로 이력에 남았습니다. 원본 {operation.path}는 이동이 성공할 때까지 보존됩니다. 다시 시도하면 최신 저장소 기준으로 이동합니다. 취소 시 대상 노트는 변경 이력에서 복원하세요.</p>}
        {overwrite && <div role="alert" className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-label-13"><p>{overwrite} 노트가 이미 있습니다. 교체하면 대상 노트 삭제와 원본 이동이 별도 두 커밋으로 실행됩니다. 중간 실패 시 원본은 유지되지만 대상 노트는 이력에서 복원해야 합니다. 대상 노트를 삭제하고 이동하시겠습니까?</p><div className="flex flex-wrap gap-2"><Button type="button" variant="destructive" disabled={busy} onClick={() => void submit(true)}>대상 삭제 후 이동</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setOverwrite(null)}>다른 경로 선택</Button></div></div>}
        <ErrorNotice error={error} />
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={busy} onClick={dismiss}>취소</Button><Button type="submit" variant={operation.kind === 'delete' ? 'destructive' : 'default'} disabled={busy || Boolean(overwrite) || (operation.kind === 'delete' && !links.data)}>{busy ? '처리 중…' : error ? '다시 시도' : operation.kind === 'delete' ? '삭제' : operation.kind === 'folder' ? '가상 폴더 준비' : operation.kind === 'move' ? '이동' : '노트 만들기'}</Button></div>
      </form>
    </dialog>, document.body)}
  </>
  return { canWrite, me, busy, panel, virtualFolders, newNote: (path = '') => start('new', path), newFolder: (path = '') => start('folder', path ? `${path}/새 폴더` : '새 폴더'), move: (path: string, destination?: string) => start('move', path, destination), remove: (path: string) => start('delete', path), renameInline, copy }
}
