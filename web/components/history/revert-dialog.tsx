"use client"

import { useEffect, useRef } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useRouter } from "next/navigation"
import { api, historyApi, type HistoryRevertResult } from "@/lib/api"
import { ErrorNotice, Loading } from "@/components/common"
import { Button } from "@/components/ui/button"
import { DiffView } from "./diff-view"

export interface RevertDialogProps {
  sha: string
  paths?: string[]
  open: boolean
  onOpenChange(open: boolean): void
  onApplied?(result: HistoryRevertResult): void
}

export function RevertDialog({ sha, paths, open, onOpenChange, onApplied }: RevertDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const cache = useQueryClient()
  const router = useRouter()
  const me = useQuery({ queryKey: ["me"], queryFn: api.me })
  const allowed = me.data?.user.role === "editor" || me.data?.user.role === "admin"
  const preview = useQuery({
    queryKey: ["history", "revert-preview", sha, paths],
    queryFn: () => historyApi.previewRevert(sha, paths),
    enabled: open && allowed,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  })
  const apply = useMutation({
    mutationFn: () => historyApi.revert(sha, paths),
    onSuccess: async result => {
      await Promise.all(["history", "jobs", "activity", "notes/tree", "note"].map(key => cache.invalidateQueries({ queryKey: [key] })))
      onOpenChange(false)
      if (onApplied) onApplied(result)
      else router.push(`/jobs/${encodeURIComponent(result.jobId)}`)
    },
  })
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const element = dialog.current
    element?.showModal()
    return () => { element?.close(); previous?.focus() }
  }, [open])
  useEffect(() => { if (!open) apply.reset() }, [open])
  if (!open) return null
  return <dialog ref={dialog} aria-labelledby="history-revert-title" aria-describedby="history-revert-description" className="fixed inset-0 m-auto max-h-[85dvh] w-[min(64rem,calc(100vw-2rem))] space-y-3 overflow-y-auto rounded-lg border bg-card p-4 text-foreground shadow-lg backdrop:bg-background/80" onCancel={event => { event.preventDefault(); if (!apply.isPending) onOpenChange(false) }}>
    <div className="flex items-start justify-between gap-2"><div className="min-w-0 space-y-1"><h2 id="history-revert-title" className="text-label-13 font-semibold">커밋 되돌리기 미리보기</h2><p className="break-all font-mono text-xs text-muted-foreground">{sha}</p></div><Button variant="ghost" disabled={apply.isPending} onClick={() => onOpenChange(false)}>닫기</Button></div>
    <p id="history-revert-description" className="text-label-13 leading-5 text-muted-foreground">과거 버전을 덮어쓰지 않고, 현재 main 위에 이 커밋의 변경을 반대로 적용합니다. 병합 커밋은 항상 부모 1 기준으로 되돌립니다. 미리보기 이후 다른 변경이 생기면 적용 결과가 달라지거나 충돌할 수 있습니다.</p>
    {paths && <p className="break-all text-label-13">선택 경로: {paths.join(", ")}</p>}
    {me.isPending ? <Loading label="권한을 확인하는 중…" /> : me.isError ? <div className="space-y-2"><ErrorNotice error={me.error}/><Button variant="outline" onClick={() => void me.refetch()}>권한 다시 확인</Button></div> : !allowed ? <p role="alert" className="text-label-13 text-destructive">되돌리기는 편집자와 관리자만 사용할 수 있습니다.</p> : <>
      {preview.isPending && <Loading label="되돌리기 결과를 계산하는 중…"/>}
      {preview.isError && <div className="space-y-2"><ErrorNotice error={preview.error}/><Button variant="outline" onClick={() => void preview.refetch()}>미리보기 다시 시도</Button></div>}
      {preview.data && <DiffView patch={preview.data.patch} mode="split"/>}
    </>}
    {apply.error && <ErrorNotice error={apply.error}/>}
    <div className="flex flex-wrap justify-end gap-2 border-t pt-2"><Button variant="outline" disabled={apply.isPending} onClick={() => onOpenChange(false)}>취소</Button><Button variant="destructive" disabled={!allowed || !preview.data?.patch.trim() || preview.isFetching || preview.isError || apply.isPending} onClick={() => apply.mutate()}>{apply.isPending ? "되돌리는 중…" : "변경 되돌리기 적용"}</Button></div>
  </dialog>
}
