'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, FileText, ImageIcon, Paperclip, X } from 'lucide-react'
import { api, ApiError, request } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export interface ChatUpload { id: string; name: string; mediaType: string; size: number; purpose: 'chat' | 'import' }
export interface DraftAttachment { key: string; file: File; progress: number; upload?: ChatUpload; error?: string }
const metadata = new Map<string, ChatUpload>()
const storageKey = 'llmwiki.chat.upload.'

function remember(upload: ChatUpload) {
  metadata.set(upload.id, upload)
  try { sessionStorage.setItem(storageKey + upload.id, JSON.stringify(upload)) } catch { /* Private storage is optional. */ }
}
function recalled(id: string): ChatUpload | undefined {
  if (metadata.has(id)) return metadata.get(id)
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey + id) || 'null') as ChatUpload | null
    if (saved?.id === id && typeof saved.name === 'string' && typeof saved.mediaType === 'string') { metadata.set(id, saved); return saved }
  } catch { /* Older browser sessions can still download the file. */ }
}
function filename(header: string | null, fallback: string) {
  const encoded = header?.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  if (encoded) { try { return decodeURIComponent(encoded) } catch { /* Fall back to the ASCII name. */ } }
  return header?.match(/filename="([^"]+)"/i)?.[1] || fallback
}

export function useChatAttachments() {
  const [items, setItems] = useState<DraftAttachment[]>([])
  const itemsRef = useRef(items)
  const uploads = useRef(new Map<string, XMLHttpRequest>())
  itemsRef.current = items
  const [error, setError] = useState('')
  useEffect(() => () => { for (const xhr of uploads.current.values()) xhr.abort() }, [])
  const addFiles = useCallback((files: File[]) => {
    const remaining = 10 - itemsRef.current.length
    if (files.length > remaining) setError('첨부 파일은 최대 10개다. 초과한 파일은 추가하지 않았다.')
    else setError('')
    const additions = files.slice(0, Math.max(0, remaining)).map(file => ({ key: crypto.randomUUID(), file, progress: 0 } satisfies DraftAttachment))
    itemsRef.current = [...itemsRef.current, ...additions]
    setItems(itemsRef.current)
    for (const item of additions) {
      const update = (patch: Partial<DraftAttachment>) => setItems(previous => {
        const next = previous.map(current => current.key === item.key ? { ...current, ...patch } : current)
        itemsRef.current = next
        return next
      })
      if (item.file.size > 20 * 1024 * 1024) { update({ error: '파일 크기는 20 MB 이하여야 한다.' }); continue }
      const xhr = new XMLHttpRequest()
      uploads.current.set(item.key, xhr)
      xhr.open('POST', '/api/uploads')
      xhr.upload.onprogress = event => { if (event.lengthComputable) update({ progress: Math.round(event.loaded / event.total * 100) }) }
      xhr.onload = () => {
        uploads.current.delete(item.key)
        let payload: ChatUpload & { error?: { message?: string } }
        try { payload = JSON.parse(xhr.responseText) } catch { update({ error: `업로드에 실패했다 (${xhr.status}).` }); return }
        if (xhr.status < 200 || xhr.status >= 300) {
          if (xhr.status === 401) window.dispatchEvent(new CustomEvent('session-expired'))
          update({ error: payload.error?.message || `업로드에 실패했다 (${xhr.status}).` }); return
        }
        remember(payload)
        update({ upload: payload, progress: 100 })
      }
      xhr.onerror = () => { uploads.current.delete(item.key); update({ error: '네트워크 오류로 업로드하지 못했다. 파일을 제거한 뒤 다시 첨부한다.' }) }
      const body = new FormData()
      body.append('file', item.file)
      body.append('purpose', 'chat')
      xhr.send(body)
    }
  }, [])
  const remove = useCallback((key: string) => {
    uploads.current.get(key)?.abort()
    uploads.current.delete(key)
    itemsRef.current = itemsRef.current.filter(item => item.key !== key)
    setItems(itemsRef.current)
  }, [])
  const clear = useCallback(() => {
    for (const xhr of uploads.current.values()) xhr.abort()
    uploads.current.clear()
    itemsRef.current = []
    setItems([])
    setError('')
  }, [])
  return { items, addFiles, remove, clear, error, ids: items.flatMap(item => item.upload ? [item.upload.id] : []), pending: items.some(item => !item.upload && !item.error), failed: items.some(item => !!item.error) }
}

function ImageLightbox({ url, name }: { url: string; name: string }) {
  const dialog = useRef<HTMLDialogElement>(null)
  return <>
    <button type="button" className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => dialog.current?.showModal()} aria-label={`${name} 이미지 확대`}><img src={url} alt={name} className="h-20 w-24 rounded-md object-cover" /></button>
    <dialog ref={dialog} className="m-auto max-h-[90vh] max-w-[95vw] rounded-lg border bg-background p-3 text-foreground shadow-xl backdrop:bg-black/70" onClick={event => { if (event.target === event.currentTarget) dialog.current?.close() }}>
      <div className="mb-2 flex items-center justify-between gap-3"><span className="truncate text-sm">{name}</span><Button type="button" variant="ghost" size="icon-sm" aria-label="이미지 닫기" onClick={() => dialog.current?.close()}><X /></Button></div>
      <img src={url} alt={name} className="max-h-[75vh] max-w-full object-contain" />
    </dialog>
  </>
}

function AssetSave({ id, name }: { id: string; name: string }) {
  const [open, setOpen] = useState(false)
  const [path, setPath] = useState(`assets/${name.replace(/[\\/]/g, '_')}`)
  const [baseSha, setBaseSha] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const client = useQueryClient()
  const baseline = useQuery({
    queryKey: ['chat/asset-baseline'],
    queryFn: async () => {
      const tree = await client.fetchQuery({ queryKey: ['notes/tree'], queryFn: api.tree, staleTime: 0 })
      const notePath = tree.files.includes('index.md') ? 'index.md' : tree.files[0]
      if (notePath) return (await client.fetchQuery({ queryKey: ['notes/content', notePath], queryFn: () => api.note(notePath), staleTime: 0 })).updatedSha
      const latest = await request<{ commits: Array<{ sha: string }> }>('/api/history?limit=1')
      if (!latest.commits[0]) throw new Error('기준 커밋을 찾지 못했다. 저장소 초기화를 확인한다.')
      return latest.commits[0].sha
    },
    enabled: open,
    refetchOnWindowFocus: false,
  })
  useEffect(() => {
    const sha = baseline.data
    if (open && !baseline.isFetching && !baseline.isError && sha) setBaseSha(previous => previous || sha)
  }, [open, baseline.data, baseline.isFetching, baseline.isError])
  return <div className="w-full text-xs">
    <Button type="button" variant="ghost" size="xs" onClick={() => setOpen(value => !value)} aria-expanded={open}><Paperclip /> 위키 자산으로 저장</Button>
    {open && <div className="mt-2 space-y-2 rounded-md border p-2">
      <label className="block">저장 경로<Input value={path} onChange={event => setPath(event.target.value)} placeholder="assets/image.png" aria-label="자산 저장 경로" /></label>
      <label className="block">기준 커밋 SHA<Input value={baseSha} onChange={event => setBaseSha(event.target.value)} placeholder="노트에서 확인한 현재 커밋 SHA" aria-label="자산 기준 커밋 SHA" /></label>
      {baseline.isFetching && <p role="status" className="text-muted-foreground">현재 기준 커밋을 불러오는 중…</p>}
      {baseline.isError && <p role="alert" className="text-destructive">{baseline.error.message}</p>}
      {(baseline.isError || conflict) && <Button type="button" variant="outline" size="xs" disabled={baseline.isFetching} onClick={async () => {
        const result = await baseline.refetch()
        if (result.data && !result.error) { setBaseSha(result.data); setConflict(false); setError('') }
      }}>{conflict ? '최신 기준 SHA 불러오기' : '기준 커밋 다시 불러오기'}</Button>}
      <p className="text-muted-foreground">editor 이상만 저장할 수 있다. 기존 자산 변경은 기준 커밋과 충돌을 검사한다.</p>
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {saved && <p role="status">저장 완료 · {saved.slice(0, 10)}</p>}
      <Button type="button" size="xs" disabled={busy || baseline.isFetching || baseline.isError || conflict || !path.startsWith('assets/') || !baseSha.trim()} onClick={async () => {
        setBusy(true); setError(''); setSaved(null)
        try { const result = await request<{ mergeSha: string }>(`/api/uploads/${encodeURIComponent(id)}/save`, { method: 'POST', body: JSON.stringify({ path, baseSha: baseSha.trim() }) }); setSaved(result.mergeSha); setBaseSha(result.mergeSha) }
        catch (cause) { setError(cause instanceof Error ? cause.message : '저장하지 못했다.'); if (cause instanceof ApiError && cause.status === 409) setConflict(true) }
        finally { setBusy(false) }
      }}>{busy ? '저장 중…' : '저장'}</Button>
    </div>}
  </div>
}

function Attachment({ id }: { id: string }) {
  const [upload, setUpload] = useState<ChatUpload | undefined>(() => recalled(id))
  const [url, setUrl] = useState<string>()
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let objectUrl: string | undefined
    setError('')
    void (async () => {
      try {
        const response = await fetch(`/api/uploads/${encodeURIComponent(id)}`, { credentials: 'same-origin', signal: controller.signal })
        if (!response.ok) {
          if (response.status === 401) window.dispatchEvent(new CustomEvent('session-expired'))
          const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null
          throw new Error(payload?.error?.message || `첨부 파일을 읽을 수 없다 (${response.status}). 소유자만 다운로드할 수 있다.`)
        }
        const blob = await response.blob()
        if (controller.signal.aborted) return
        const details: ChatUpload = { id, name: filename(response.headers.get('Content-Disposition'), recalled(id)?.name || id), mediaType: blob.type, size: blob.size, purpose: 'chat' }
        remember(details)
        setUpload(details)
        if (blob.type.startsWith('image/')) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl) }
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '첨부 파일을 읽을 수 없다.') }
    })()
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [id, attempt])
  return <div className="flex w-full max-w-sm flex-wrap items-center gap-2 rounded-lg border bg-background/50 p-2 text-sm">
    {url && upload ? <ImageLightbox url={url} name={upload.name} /> : upload?.mediaType.startsWith('image/') ? <ImageIcon className="size-5 shrink-0" /> : <FileText className="size-5 shrink-0" />}
    <div className="min-w-0 flex-1"><div className="truncate">{upload?.name || '첨부 파일'}</div><div className="text-xs text-muted-foreground">{upload ? `${(upload.size / 1024).toFixed(1)} KB` : '파일 정보 읽는 중…'}</div></div>
    {!error && <a href={`/api/uploads/${encodeURIComponent(id)}`} download={upload?.name} className="rounded p-1 focus-visible:ring-2 focus-visible:ring-ring" aria-label={`${upload?.name || '첨부'} 다운로드`}><Download className="size-4" /></a>}
    {error ? <div className="w-full"><p role="alert" className="text-xs text-destructive">{error}</p><Button type="button" size="xs" variant="ghost" onClick={() => setAttempt(value => value + 1)}>다시 시도</Button></div> : upload && <AssetSave id={id} name={upload.name} />}
  </div>
}

export function MessageAttachments({ ids }: { ids: string[] }) {
  return ids.length ? <div className="mt-2 flex flex-wrap gap-2">{ids.map(id => <Attachment key={id} id={id} />)}</div> : null
}

function DraftPreview({ item }: { item: DraftAttachment }) {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    if (!item.file.type.startsWith('image/')) return
    const objectUrl = URL.createObjectURL(item.file)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [item.file])
  return url ? <ImageLightbox url={url} name={item.file.name} /> : <FileText className="size-5 shrink-0" />
}

export function DraftAttachments({ items, onRemove }: { items: DraftAttachment[]; onRemove: (key: string) => void }) {
  return <div className="flex flex-wrap gap-2">{items.map(item => <div key={item.key} className="flex max-w-full items-start gap-2 rounded-md border p-2">
    <DraftPreview item={item} />
    <div className="min-w-0 max-w-48 text-xs"><p className="truncate">{item.file.name}</p>{item.error ? <p role="alert" className="text-destructive">{item.error}</p> : item.upload ? <p className="text-muted-foreground">첨부 준비됨</p> : <><progress value={item.progress} max={100} aria-label={`${item.file.name} 업로드 진행률`} className="w-full" /><p>{item.progress === 100 ? '파일 확인 중…' : `${item.progress}%`}</p></>}</div>
    <Button type="button" variant="ghost" size="icon-xs" aria-label={`${item.file.name} 제거`} onClick={() => onRemove(item.key)}><X /></Button>
  </div>)}</div>
}
