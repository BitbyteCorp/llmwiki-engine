"use client"

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import Link from "next/link"
import dynamic from "next/dynamic"
import { useViewLocation } from "@/components/workspace/view-location"
import { api, ApiError, historyApi } from "@/lib/api"
import type { FileChange } from "@/lib/api"
import { EmptyState, ErrorNotice, Loading, PageHeader } from "@/components/common"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CommitByline, CommitTechnicalDetails, historyHref, versionHref } from "@/components/history/commit-meta"

const DiffView = dynamic(() => import("@/components/history/diff-view").then(module => module.DiffView), { loading: () => <Loading label="변경 비교를 준비하는 중…"/> })
const RevertDialog = dynamic(() => import("@/components/history/revert-dialog").then(module => module.RevertDialog), { loading: () => <Loading label="변경 취소 미리보기를 준비하는 중…"/> })
const fileLabels: Record<FileChange["status"], string> = { A: "추가", M: "수정", D: "삭제", R: "이름 변경" }
const selectClass = "h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-label-13 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"

export function FileList({ files, versionSha, deletedVersionSha, selected, onSelect, className = "divide-y border-y" }: { files: FileChange[]; versionSha: string; deletedVersionSha?: string; selected?: string[]; onSelect?(path: string, checked: boolean): void; className?: string }) {
  return files.length ? <ul className={className}>{files.map(file => <li key={`${file.status}-${file.path}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5 text-label-13 hover:bg-accent">
    {onSelect && <input type="checkbox" className="size-4 shrink-0 accent-primary" aria-label={`${file.path} 변경 취소 선택`} checked={selected?.includes(file.path) ?? false} onChange={event => onSelect(file.path, event.target.checked)}/>}
    <Badge variant="outline" className={file.status === "A" ? "border-success/30 bg-success/10 text-success" : file.status === "D" ? "border-destructive/30 bg-destructive/5 text-destructive" : undefined}>{fileLabels[file.status]}</Badge>
    <span className="min-w-0 flex-1 break-all">{file.oldPath && <span className="text-muted-foreground">{file.oldPath} → </span>}{file.path}</span>
    {file.path.endsWith(".md") && <span className="flex shrink-0 flex-wrap gap-x-2 text-xs">{(file.status !== "D" || deletedVersionSha) && <Link className="underline underline-offset-4" href={versionHref(file.path, file.status === "D" ? deletedVersionSha! : versionSha)}>{file.status === "D" ? "삭제 전 버전 보기" : "이 버전 보기"}</Link>}<Link className="underline underline-offset-4" href={historyHref(file.path)}>노트 이력</Link></span>}
  </li>)}</ul> : <EmptyState title="변경된 파일이 없습니다"/>
}

export function CommitPage() {
  const { pathname } = useViewLocation()
  const encodedSha = pathname.split("/")[3]
  const sha = encodedSha === undefined ? "" : decodeURIComponent(encodedSha)
  return <CommitDetail key={sha} sha={sha}/>
}

function CommitDetail({ sha }: { sha: string }) {
  const [parent, setParent] = useState(1)
  const [selected, setSelected] = useState<string[]>([])
  const [revert, setRevert] = useState<{ paths?: string[] } | null>(null)
  const me = useQuery({ queryKey: ["me"], queryFn: api.me })
  const allowed = me.data?.user.role === "editor" || me.data?.user.role === "admin"
  const query = useQuery({ queryKey: ["history", "commit", sha, parent], queryFn: ({ signal }) => historyApi.commit(sha, parent, signal), enabled: !!sha, retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 3 })
  if (!sha) return <EmptyState title="변경 기록을 선택해 주세요"/>
  if (query.isPending) return <Loading label="변경 기록을 불러오는 중…"/>
  if (query.isError) return <div className="space-y-2">{query.error instanceof ApiError && query.error.status === 404 ? <><EmptyState title="이 변경 기록을 찾을 수 없습니다" description="읽을 수 있는 변경 기록인지 확인해 주세요."/><Button variant="outline" nativeButton={false} render={<Link href="/history"/>}>전체 변경 이력</Button></> : <><ErrorNotice error={query.error}/><Button variant="outline" onClick={() => void query.refetch()}>다시 불러오기</Button></>}</div>
  const { commit, files, patch, job } = query.data
  const selectedFiles = files.filter(file => selected.includes(file.path))
  const selectedPaths = [...new Set(selectedFiles.flatMap(file => file.oldPath ? [file.path, file.oldPath] : [file.path]))]
  return <div className="min-w-0 space-y-3">
    <PageHeader title="변경 상세" actions={<Button variant="outline" nativeButton={false} render={<Link href="/history"/>}>전체 변경 이력</Button>}/>
    <section className="space-y-1"><h2 className="break-words text-base font-semibold">{commit.subject || "제목 없는 변경"}</h2><CommitByline commit={commit}/></section>
    <section className="min-w-0 space-y-1.5" aria-label="변경 내용"><DiffView patch={patch} beforeLabel="이전 버전" afterLabel="선택한 버전"/></section>
    <section className="space-y-1.5"><h2 className="flex h-7 items-center justify-between gap-1.5 border-b text-label-13 font-semibold"><span>변경된 노트와 파일</span><span className="text-xs tabular-nums text-muted-foreground">{files.length}개</span></h2><FileList className="divide-y border-b" files={files} versionSha={commit.sha} deletedVersionSha={commit.parents[parent - 1]} selected={selected} onSelect={allowed && parent === 1 ? (path, checked) => setSelected(previous => checked ? [...previous, path] : previous.filter(value => value !== path)) : undefined}/></section>
    {allowed && <div className="space-y-1.5"><div className="flex flex-wrap gap-1.5"><Button variant="outline" onClick={() => setRevert({})}>이 변경만 취소…</Button><Button variant="outline" disabled={parent !== 1 || !selectedPaths.length} onClick={() => setRevert({ paths: selectedPaths })}>선택한 파일만 취소…{selectedFiles.length > 0 && <span className="tabular-nums"> ({selectedFiles.length})</span>}</Button></div>{commit.parents.length > 1 && <p className="text-xs text-muted-foreground">변경 취소는 첫 번째 병합 기준으로 적용합니다. 일부 파일만 취소하려면 고급 변경 비교에서 기준 1을 선택하세요.</p>}</div>}
    {job && <Link className="inline-block text-label-13 underline underline-offset-4" href={`/jobs/${encodeURIComponent(job.id)}`}>관련 작업 보기</Link>}
    <CommitTechnicalDetails commit={commit}/>
    {commit.parents.length > 1 && <details className="space-y-1.5"><summary className="h-7 cursor-pointer border-b text-label-13 font-semibold leading-7">고급 변경 비교</summary><label className="block space-y-1 text-xs text-muted-foreground">병합 비교 기준<select className={selectClass} value={parent} onChange={event => { setParent(Number(event.target.value)); setSelected([]) }}>{commit.parents.map((parentSha, index) => <option key={parentSha} value={index + 1}>기준 {index + 1}{index === 0 ? " (변경 취소 기준)" : ""}</option>)}</select></label></details>}
    {revert && <RevertDialog sha={commit.sha} paths={revert.paths} open onOpenChange={open => { if (!open) setRevert(null) }}/>} 
  </div>
}
