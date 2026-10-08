"use client"

import Link from "next/link"
import { type JSX, useEffect, useId, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api, ApiError, historyApi, type FileChange, type HistoryRevertResult } from "@/lib/api"
import { ErrorNotice, Loading, noteHref } from "@/components/common"
import { Button } from "@/components/ui/button"
import { DiffView } from "./diff-view"
import { historyHref } from "./commit-meta"

export interface RevertDialogProps {
  sha: string
  paths?: string[]
  open: boolean
  onOpenChange(open: boolean): void
  onApplied?(result: HistoryRevertResult): void
}

const statusLabel: Record<FileChange["status"], string> = { A: "추가", M: "수정", D: "삭제", R: "이름 변경" }

function revertFailure(error: unknown): Error {
  if (error instanceof ApiError) {
    if (error.code === "revert_conflict") return new Error("이후의 수정과 겹쳐 이 변경을 취소할 수 없습니다. 노트의 최신 내용을 확인하고 직접 수정해 주세요.")
    if (error.status === 403) return new Error("이 노트의 변경을 취소할 권한이 없습니다.")
    if (error.status === 404) return new Error("이 변경 기록을 불러올 수 없습니다. 변경 이력에서 다른 기록을 선택해 주세요.")
  }
  return new Error("변경을 취소하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.")
}

export function RevertDialog(props: RevertDialogProps): JSX.Element | null {
  return props.open ? <RevertSession key={JSON.stringify([props.sha, props.paths])} {...props} /> : null
}

function RevertSession({ sha, paths, onOpenChange, onApplied }: RevertDialogProps): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const cache = useQueryClient()
  const [completed, setCompleted] = useState<{ result: HistoryRevertResult; files: FileChange[] } | null>(null)
  const me = useQuery({ queryKey: ["me"], queryFn: api.me })
  const allowed = me.data?.user.role === "editor" || me.data?.user.role === "admin"
  const commit = useQuery({
    queryKey: ["history", "commit", sha, 1],
    queryFn: ({ signal }) => historyApi.commit(sha, 1, signal),
    enabled: allowed,
    retry: false,
  })
  const preview = useQuery({
    queryKey: ["history", "revert-preview", sha, paths],
    queryFn: () => historyApi.previewRevert(sha, paths),
    enabled: allowed && !completed,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  const apply = useMutation({
    mutationFn: () => historyApi.revert(sha, paths),
    onSuccess: async result => {
      const files = preview.data?.files ?? []
      setCompleted({ result, files })
      const notePaths = [...new Set(files.flatMap(file => file.oldPath ? [file.path, file.oldPath] : [file.path]))]
      await Promise.all([
        ...["history", "jobs", "activity", "notes/tree", "note"].map(key => cache.invalidateQueries({ queryKey: [key] })),
        ...notePaths.map(path => cache.invalidateQueries({ queryKey: ["notes/content", path], exact: true })),
      ])
      if (onApplied) { onOpenChange(false); onApplied(result) }
    },
  })
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const element = dialog.current
    element?.showModal()
    return () => { element?.close(); previous?.focus() }
  }, [])
  return <dialog ref={dialog} role="dialog" aria-labelledby={titleId} aria-describedby={descriptionId} className="fixed inset-0 m-auto max-h-[85dvh] w-[min(64rem,calc(100vw-2rem))] space-y-3 overflow-y-auto rounded-lg border bg-card p-4 text-foreground shadow-lg backdrop:bg-background/80" onCancel={event => { event.preventDefault(); if (!apply.isPending) onOpenChange(false) }}>
    <div className="flex items-start justify-between gap-2"><div className="min-w-0 space-y-1"><h2 id={titleId} className="text-label-13 font-semibold">선택한 변경 취소</h2>{commit.data ? <p className="break-words text-label-13 text-muted-foreground">{commit.data.commit.subject}</p> : <p className="font-mono text-xs text-muted-foreground">{sha.slice(0, 8)}</p>}</div><Button variant="ghost" disabled={apply.isPending} onClick={() => onOpenChange(false)}>닫기</Button></div>
    <p id={descriptionId} className="text-label-13 leading-5 text-muted-foreground">이 변경만 반대로 적용합니다. 이후의 다른 변경은 유지되며, 겹치는 수정이 있으면 취소할 수 없습니다.</p>
    {completed ? <div className="space-y-3">
      <p role="status" className="text-label-13 font-medium">선택한 변경을 취소했습니다. 아래 노트에서 결과를 확인하세요.</p>
      <ul aria-label="변경 취소 결과" className="divide-y border-y">
        {completed.files.map(file => <li key={file.path} className="flex flex-wrap items-center justify-between gap-2 px-2 py-1.5">
          <div className="min-w-0 space-y-0.5"><p className="break-words text-label-13 font-medium">{file.path.split("/").pop()?.replace(/\.md$/i, "") || file.path} <span className="text-xs font-normal text-muted-foreground">· {statusLabel[file.status]}</span></p><p className="break-all text-xs text-muted-foreground">{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</p></div>
          <div className="flex gap-2">{/\.md$/i.test(file.path) && <Button size="sm" nativeButton={false} render={<Link href={noteHref(file.path)} />} onClick={() => onOpenChange(false)}>노트 열기</Button>}<Button size="sm" variant="outline" nativeButton={false} render={<Link href={historyHref(file.path)} />} onClick={() => onOpenChange(false)}>변경 기록 보기</Button></div>
        </li>)}
      </ul>
      <Button variant="outline" nativeButton={false} render={<Link href={`/jobs/${encodeURIComponent(completed.result.jobId)}`} />} onClick={() => onOpenChange(false)}>작업 상세</Button>
    </div> : <>
      <p className="text-label-13 leading-5 text-warning">미리본 뒤 노트가 바뀌면 실제 결과가 달라지거나 변경을 취소할 수 없을 수 있습니다.</p>
      {commit.data && commit.data.commit.parents.length > 1 && <p className="text-xs text-muted-foreground">여러 변경을 합친 기록입니다. 처음 기준이 된 버전과의 차이를 취소합니다.</p>}
      {paths && <p className="text-label-13 text-muted-foreground">선택한 노트의 변경만 취소합니다.</p>}
      {me.isPending ? <Loading label="권한을 확인하는 중…" /> : me.isError ? <div className="space-y-2"><ErrorNotice error={me.error}/><Button variant="outline" onClick={() => void me.refetch()}>권한 다시 확인</Button></div> : !allowed ? <p role="alert" className="text-label-13 text-destructive">변경 취소는 편집자와 관리자만 사용할 수 있습니다.</p> : <>
        {preview.isFetching && <Loading label="변경 취소 결과를 계산하는 중…"/>}
        {preview.isError && <div className="space-y-2"><ErrorNotice error={revertFailure(preview.error)}/><Button variant="outline" onClick={() => void preview.refetch()}>미리보기 다시 시도</Button></div>}
        {preview.data && !preview.isError && <>
          <ul aria-label="변경될 노트" className="divide-y border-y">{preview.data.files.map(file => <li key={file.path} className="px-2 py-1.5 text-label-13"><span className="mr-2 text-xs text-muted-foreground">{statusLabel[file.status]}</span><span className="break-all">{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span></li>)}</ul>
          {preview.data.patch.trim() ? <DiffView patch={preview.data.patch} beforeLabel="현재 내용" afterLabel="취소 후 내용"/> : <p className="text-label-13">취소할 변경이 없습니다.</p>}
        </>}
      </>}
      {apply.error && <ErrorNotice error={revertFailure(apply.error)}/>}
      <div className="flex flex-wrap justify-end gap-2 border-t pt-2"><Button variant="outline" disabled={apply.isPending} onClick={() => onOpenChange(false)}>닫기</Button><Button variant="destructive" disabled={!allowed || !preview.data?.patch.trim() || preview.isFetching || preview.isError || apply.isPending} onClick={() => apply.mutate()}>{apply.isPending ? "변경을 취소하는 중…" : "이 변경만 취소"}</Button></div>
    </>}
  </dialog>
}
