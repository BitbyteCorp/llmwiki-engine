'use client'

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { LoaderCircle, Upload } from 'lucide-react'
import { importsApi, type ImportInput } from '@/lib/api'
import { ErrorNotice } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ImportModal } from './import-modal'

const tabs = [
  { id: 'url', title: 'URL' }, { id: 'text', title: '텍스트' }, { id: 'file', title: '파일' },
  { id: 'obsidian', title: 'Obsidian' }, { id: 'notion', title: 'Notion' },
] as const
type ImportTab = typeof tabs[number]['id']
const MiB = 1024 * 1024

export function ImportDialog({ onClose, onCreated, onFailure }: { onClose: () => void; onCreated: (result: { importId: string; jobId: string }) => void; onFailure: () => void }) {
  const [tab, setTab] = useState<ImportTab>('url')
  const [url, setUrl] = useState('')
  const [text, setText] = useState('')
  const [filename, setFilename] = useState('')
  const [instructions, setInstructions] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [uploaded, setUploaded] = useState<{ file: File; id: string } | null>(null)
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'extracting'>('idle')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<unknown>(null)
  const controller = useRef<AbortController | null>(null)
  const busy = phase !== 'idle'
  const vault = tab === 'obsidian' || tab === 'notion'
  useEffect(() => () => controller.current?.abort(), [])

  function switchTab(next: ImportTab) {
    setTab(next)
    setFile(null)
    setUploaded(null)
    setError(null)
  }

  function moveTab(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
    switchTab(tabs[nextIndex].id)
    const nextTab = document.getElementById(`import-tab-${tabs[nextIndex].id}`)
    nextTab?.focus({ preventScroll: true })
    nextTab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setError(null)
    const extra = instructions.trim() ? { instructions: instructions.trim() } : {}
    try {
      let input: ImportInput
      if (tab === 'url') {
        const parsed = new URL(url.trim())
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('인증 정보가 없는 공개 HTTP 또는 HTTPS URL을 입력해 주세요.')
        input = { kind: 'url', url: url.trim(), ...extra }
      } else if (tab === 'text') {
        if (!text.trim()) throw new Error('가져올 텍스트를 입력해 주세요.')
        if (new TextEncoder().encode(text).byteLength > 20 * MiB) throw new Error('텍스트는 UTF-8 기준 20 MiB 이하여야 합니다.')
        input = { kind: 'text', text, ...(filename.trim() ? { filename: filename.trim() } : {}), ...extra }
      } else {
        if (!file) throw new Error('가져올 파일을 선택해 주세요.')
        if (!(vault ? /\.zip$/i : /\.(pdf|md|txt)$/i).test(file.name)) throw new Error(vault ? '내보낸 ZIP 파일을 선택해 주세요.' : 'PDF, Markdown(.md), 텍스트(.txt) 파일을 선택해 주세요.')
        if (file.size > (vault ? 100 : 20) * MiB) throw new Error(`파일은 ${vault ? 100 : 20} MiB 이하여야 합니다.`)
        let uploadId = uploaded?.file === file ? uploaded.id : undefined
        if (!uploadId) {
          setPhase('uploading')
          setProgress(0)
          controller.current = new AbortController()
          const upload = await importsApi.upload(file, { signal: controller.current.signal, onProgress: setProgress })
          uploadId = upload.id
          setUploaded({ file, id: uploadId })
          controller.current = null
        }
        input = { kind: vault ? tab as 'obsidian' | 'notion' : /\.pdf$/i.test(file.name) ? 'pdf' : 'file', uploadId, ...extra }
      }
      setPhase('extracting')
      const result = await importsApi.create(input)
      onCreated(result)
    } catch (cause) {
      setError(cause instanceof DOMException && cause.name === 'AbortError' ? new Error('업로드를 취소했습니다. 파일은 아직 가져오지 않았습니다.') : cause)
      onFailure()
    } finally {
      controller.current = null
      setPhase('idle')
    }
  }

  return <ImportModal title="원문 가져오기" description="원문을 보관한 뒤 Luna가 위키 지식으로 통합합니다." onClose={onClose} busy={busy}>
    <form onSubmit={submit} className="space-y-3" aria-busy={busy}>
      <div role="tablist" aria-label="원문 종류" className="flex gap-1 overflow-x-auto rounded-lg bg-muted p-1">
        {tabs.map((item, index) => <button type="button" role="tab" id={`import-tab-${item.id}`} aria-selected={tab === item.id} aria-controls={`import-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1} key={item.id} disabled={busy} onKeyDown={(event) => moveTab(event, index)} onClick={() => switchTab(item.id)} className={`min-h-9 shrink-0 whitespace-nowrap rounded-md px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${tab === item.id ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}>{item.title}</button>)}
      </div>
      <div role="tabpanel" id={`import-panel-${tab}`} aria-labelledby={`import-tab-${tab}`} className="space-y-3">
        {tab === 'url' ? <>
          <Label htmlFor="import-url">공개 URL</Label>
          <Input id="import-url" type="url" required maxLength={4096} placeholder="https://example.com/article" value={url} onChange={(event) => setUrl(event.target.value)} disabled={busy} />
          <p className="text-xs leading-5 text-muted-foreground">HTML 기사, PDF, Markdown, 텍스트를 가져옵니다. 사설 네트워크·localhost·메타데이터 주소와 인증 URL은 SSRF 보호로 차단됩니다. 최대 20 MiB, 다운로드 15초, 리다이렉트 5회입니다.</p>
        </> : tab === 'text' ? <>
          <Label htmlFor="import-text">원문 텍스트</Label>
          <Textarea id="import-text" required rows={9} value={text} onChange={(event) => setText(event.target.value)} disabled={busy} placeholder="가져올 원문을 붙여넣으세요." />
          <p className="text-xs text-muted-foreground">UTF-8 기준 최대 20 MiB이며 Markdown도 그대로 보관합니다.</p>
          <Label htmlFor="import-filename">원문 파일명 <span className="text-muted-foreground">(선택)</span></Label>
          <Input id="import-filename" maxLength={255} placeholder="source.md" value={filename} onChange={(event) => setFilename(event.target.value)} disabled={busy} />
        </> : <>
          <Label htmlFor="import-file">{vault ? `${tab === 'obsidian' ? 'Obsidian 볼트' : 'Notion Markdown 내보내기'} ZIP` : 'PDF · Markdown · 텍스트 파일'}</Label>
          <Input key={tab} id="import-file" type="file" required accept={vault ? '.zip,application/zip' : '.pdf,.md,.txt,application/pdf,text/plain,text/markdown'} disabled={busy} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setUploaded(null); setError(null) }} className="h-auto min-h-10 py-2" />
          {file && <p className="break-all text-sm">{file.name} <span className="text-muted-foreground">({(file.size / MiB).toFixed(2)} MiB)</span></p>}
          <p className="text-xs leading-5 text-muted-foreground">{vault ? 'ZIP 압축·전체 해제 크기 각각 최대 100 MiB, 항목 1,000개, 개별 파일 20 MiB입니다. 경로와 첨부를 보관하며 안전하지 않은 ZIP은 거부합니다.' : '최대 20 MiB입니다. PDF는 최대 500페이지이며 OCR을 지원하지 않습니다. 텍스트와 Markdown은 UTF-8이어야 합니다.'}</p>
          {tab === 'notion' && <p className="text-xs text-muted-foreground">Notion의 “Markdown & CSV” 내보내기 ZIP을 사용하세요. 페이지 ID를 제거한 경로가 충돌하면 전체 수집이 실패합니다.</p>}
        </>}
      </div>
      <div className="space-y-3"><Label htmlFor="import-instructions">Luna 통합 지침 <span className="text-muted-foreground">(선택)</span></Label><Textarea id="import-instructions" rows={3} maxLength={10000} placeholder="핵심 개념을 요약하고 기존 노트와 연결해 주세요." value={instructions} onChange={(event) => setInstructions(event.target.value)} disabled={busy} /><p className="text-right text-xs text-muted-foreground">{instructions.length.toLocaleString()} / 10,000자</p></div>
      <div className="rounded-lg border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">원문은 공용 지식 저장소에 보관됩니다. 통합 작업이 실패해도 보관된 원문은 유지됩니다. 민감한 정보는 제출 전에 확인해 주세요.</div>
      {error != null && <ErrorNotice error={error} />}
      {busy && <div role="status" aria-live="polite" className="space-y-3 rounded-lg border bg-card p-4 text-sm">
        <p className="flex items-center gap-2"><LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />{phase === 'uploading' ? progress === 100 ? '파일 검증 및 업로드 저장 중…' : `파일 업로드 중… ${progress}%` : '원문 추출 및 통합 작업 등록 중…'}</p>
        {phase === 'uploading' && <progress aria-label="파일 업로드 진행률" value={progress} max={100} className="h-2 w-full accent-primary" />}
        <p className="text-xs text-muted-foreground">{phase === 'uploading' ? '업로드 후 원문 추출을 시작합니다.' : '서버에서 처리 중입니다. 완료될 때까지 이 창을 유지해 주세요.'}</p>
      </div>}
      <div className="flex flex-wrap justify-end gap-3">
        {phase === 'uploading' ? <Button type="button" variant="outline" onClick={() => controller.current?.abort()}>업로드 취소</Button> : <Button type="button" variant="outline" disabled={busy} onClick={onClose}>닫기</Button>}
        <Button type="submit" disabled={busy}><Upload />{busy ? '처리 중…' : error ? '다시 가져오기' : '가져오기'}</Button>
      </div>
    </form>
  </ImportModal>
}
