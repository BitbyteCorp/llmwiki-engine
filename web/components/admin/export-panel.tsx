'use client'

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download, FolderArchive } from 'lucide-react'
import { api, settingsApi } from '@/lib/api'
import { EmptyState, ErrorNotice, Loading } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function ExportPanel({ id = 'export' }: { id?: string } = {}) {
  const tree = useQuery({ queryKey: ['notes/tree'], queryFn: api.tree })
  const [prefix, setPrefix] = useState('')
  const [format, setFormat] = useState<'zip' | 'bundle'>('zip')
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [downloaded, setDownloaded] = useState<{ filename: string; headSha: string | null } | null>(null)
  const activeRequest = useRef<AbortController | null>(null)
  useEffect(() => () => activeRequest.current?.abort(), [])
  const folders = useMemo(() => {
    const paths = new Set<string>()
    for (const file of tree.data?.files ?? []) {
      const parts = file.split('/')
      for (let i = 1; i < parts.length; i++) paths.add(`${parts.slice(0, i).join('/')}/`)
    }
    return Array.from(paths).sort((left, right) => left.localeCompare(right, 'ko'))
  }, [tree.data])
  const files = tree.data?.files ?? []
  const normalizedPrefix = prefix.trim()
  const pickerValue = !normalizedPrefix || folders.includes(normalizedPrefix) || files.includes(normalizedPrefix) ? normalizedPrefix : '__custom__'

  function updatePrefix(value: string) {
    setPrefix(value)
    if (value.trim()) setFormat('zip')
    setDownloaded(null)
    setError(null)
  }

  async function download(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (downloading || (normalizedPrefix && format === 'bundle')) return
    const controller = new AbortController()
    activeRequest.current = controller
    setDownloading(true)
    setError(null)
    setDownloaded(null)
    try {
      const result = await settingsApi.exportFile(normalizedPrefix, format, controller.signal)
      if (controller.signal.aborted) return
      const url = URL.createObjectURL(result.blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = result.filename
      document.body.append(anchor)
      anchor.click()
      anchor.remove()
      // Allow the browser to begin consuming the download before freeing the blob.
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setDownloaded({ filename: result.filename, headSha: result.headSha })
    } catch (cause) { if (!controller.signal.aborted) setError(cause) }
    finally {
      if (!controller.signal.aborted) setDownloading(false)
      if (activeRequest.current === controller) activeRequest.current = null
    }
  }

  return <section id={id} tabIndex={-1} aria-labelledby={`${id}-heading`} className="scroll-mt-6 space-y-3 rounded-lg border bg-card p-4">
    <div><h2 id={`${id}-heading`} className="flex items-center gap-3 text-sm font-semibold"><FolderArchive className="size-4" />지식 내보내기</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">커밋된 main의 지식을 다운로드합니다. ZIP은 선택한 범위의 파일, Git bundle은 전체 main의 이력을 포함합니다.</p></div>
    <form onSubmit={download} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 @2xl/settings-panel:grid-cols-2">
        <div className="space-y-2"><Label htmlFor={`${id}-picker`}>노트 트리에서 범위 선택</Label><select id={`${id}-picker`} value={pickerValue} disabled={downloading || tree.isPending || !tree.data} className="h-9 w-full min-w-0 rounded-md border bg-background px-3 text-sm disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-ring" onChange={(event) => updatePrefix(event.target.value)}><option value="">전체 저장소</option>{pickerValue === '__custom__' && <option value="__custom__" disabled>직접 입력한 경로</option>}<optgroup label="폴더">{folders.map((folder) => <option key={folder} value={folder}>{folder}</option>)}</optgroup><optgroup label="노트">{files.map((file) => <option key={file} value={file}>{file}</option>)}</optgroup></select></div>
        <div className="space-y-2"><Label htmlFor={`${id}-prefix`}>경로 접두사 직접 입력 <span className="text-muted-foreground">(선택)</span></Label><Input id={`${id}-prefix`} value={prefix} autoComplete="off" placeholder="예: wiki/ 또는 assets/" disabled={downloading} onChange={(event) => updatePrefix(event.target.value)} /><p className="text-xs text-muted-foreground">비워 두면 전체 저장소입니다. 폴더는 끝에 /를 붙여 범위를 구분하세요.</p></div>
      </div>
      {tree.isPending && <Loading label="내보낼 노트 트리를 불러오는 중…" />}
      {tree.error && <div className="space-y-3"><ErrorNotice error={tree.error} /><div className="flex flex-wrap items-center gap-3"><Button type="button" variant="outline" disabled={tree.isFetching} onClick={() => void tree.refetch()}>트리 다시 불러오기</Button><p className="text-xs text-muted-foreground">트리를 불러오지 못해도 경로를 직접 입력하거나 전체 저장소를 내보낼 수 있습니다.</p></div></div>}
      {tree.data && files.length === 0 && <EmptyState title="노트 트리가 비어 있습니다" description="커밋된 노트가 없습니다. 다른 파일 경로를 직접 입력해 내보낼 수 있습니다." />}
      <fieldset disabled={downloading} className="space-y-3"><legend className="mb-2 text-sm font-semibold">파일 형식</legend><div className="flex flex-col gap-3 @2xl/settings-panel:flex-row @2xl/settings-panel:flex-wrap"><label className="flex items-center gap-2 text-sm"><input type="radio" name={`${id}-format`} value="zip" checked={format === 'zip'} onChange={() => { setFormat('zip'); setDownloaded(null) }} className="size-4 accent-primary" />ZIP · 파일 스냅샷</label><label className={`flex items-center gap-2 text-sm ${normalizedPrefix ? 'text-muted-foreground' : ''}`}><input type="radio" name={`${id}-format`} value="bundle" checked={format === 'bundle'} disabled={!!normalizedPrefix} aria-describedby={`${id}-bundle-help`} onChange={() => { setFormat('bundle'); setDownloaded(null) }} className="size-4 accent-primary" />Git bundle · 전체 이력</label></div><p id={`${id}-bundle-help`} className="text-xs leading-5 text-muted-foreground">{normalizedPrefix ? '경로를 지정하면 ZIP만 사용할 수 있습니다. Git bundle을 받으려면 경로 입력을 비워 주세요.' : 'Git bundle은 부분 경로를 지원하지 않습니다. ZIP에는 manifest.json이 포함됩니다.'}</p></fieldset>
      <ErrorNotice error={error} />
      <Button type="submit" disabled={downloading || (!!normalizedPrefix && format === 'bundle')}><Download />{downloading ? '파일을 준비하는 중…' : error ? '다운로드 다시 시도' : '다운로드'}</Button>
      {downloading && <p role="status" className="text-xs text-muted-foreground">파일을 모두 받은 뒤 다운로드가 시작됩니다. 크기에 따라 시간이 걸릴 수 있습니다.</p>}
      {downloaded && <div role="status" className="space-y-1 rounded-lg bg-muted/50 p-3 text-sm"><p className="break-all"><strong>{downloaded.filename}</strong> 다운로드를 시작했습니다.</p>{downloaded.headSha && <p className="break-all font-mono text-xs text-muted-foreground">main: {downloaded.headSha}</p>}</div>}
      <p className="text-xs leading-5 text-muted-foreground">내보내기는 지식 저장소 파일만 포함합니다. 사용자·대화·DB와 업로드의 전체 백업은 서버의 llmwiki backup CLI를 사용하세요.</p>
    </form>
  </section>
}
