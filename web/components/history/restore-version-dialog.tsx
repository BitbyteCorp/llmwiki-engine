"use client"

import Link from "next/link"
import { type JSX, useEffect, useId, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api, ApiError, historyApi } from "@/lib/api"
import { ErrorNotice, Loading, noteHref } from "@/components/common"
import { Button } from "@/components/ui/button"
import { readCurrentNote, readNoteSnapshot, saveNote } from "@/components/editor/api"
import { historyHref } from "./commit-meta"
import { DiffView } from "./diff-view"

export interface RestoreVersionDialogProps {
  targetPath: string
  historicalPath: string
  versionSha: string
  versionLabel?: string
  open: boolean
  onOpenChange(open: boolean): void
  onApplied?(result: { jobId: string; mergeSha: string | null; path: string }): void
}

function restoreFailure(error: unknown): Error {
  if (error instanceof ApiError) {
    if (error.status === 403) return new Error("이 노트를 읽거나 복원할 권한이 없습니다.")
    if (error.status === 404) return new Error("선택한 버전의 내용을 불러올 수 없습니다. 변경 이력에서 다른 버전을 선택해 주세요.")
  }
  return new Error("내용을 불러오거나 복원하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.")
}

export function RestoreVersionDialog(props: RestoreVersionDialogProps): JSX.Element | null {
  return props.open ? <RestoreSession key={`${props.targetPath}\0${props.historicalPath}\0${props.versionSha}`} {...props} /> : null
}

function RestoreSession({ targetPath, historicalPath, versionSha, versionLabel, onOpenChange, onApplied }: RestoreVersionDialogProps): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const cache = useQueryClient()
  const [needsReview, setNeedsReview] = useState(false)
  const [reviewed, setReviewed] = useState(false)
  const me = useQuery({ queryKey: ["me"], queryFn: api.me })
  const allowed = me.data?.user.role === "editor" || me.data?.user.role === "admin"
  const version = useQuery({
    queryKey: ["history", "commit", versionSha, 1],
    queryFn: ({ signal }) => historyApi.commit(versionSha, 1, signal),
    enabled: allowed,
    retry: false,
  })
  const preview = useQuery({
    queryKey: ["restore-preview", targetPath, historicalPath, versionSha],
    queryFn: async () => {
      const [current, historical] = await Promise.all([readCurrentNote(targetPath), readNoteSnapshot(historicalPath, versionSha)])
      return { current, historical }
    },
    enabled: allowed,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  const identical = !!preview.data && preview.data.current.content === preview.data.historical.content
  const apply = useMutation({
    mutationFn: async () => {
      if (!allowed || !preview.data || preview.isFetching || preview.isError || identical || (needsReview && !reviewed)) throw new Error("복원할 내용을 먼저 확인하세요.")
      return saveNote(targetPath, preview.data.historical.content, preview.data.current.updatedSha, "선택한 버전으로 복원")
    },
    onSuccess: async result => {
      await Promise.all([
        cache.invalidateQueries({ queryKey: ["notes/content", targetPath], exact: true }),
        ...["history", "activity", "notes/tree", "note", "jobs"].map(key => cache.invalidateQueries({ queryKey: [key] })),
      ])
      if (onApplied) {
        onOpenChange(false)
        onApplied({ ...result, path: targetPath })
      }
    },
    onError: async error => {
      if (error instanceof ApiError && error.code === "stale_note") {
        setNeedsReview(true)
        setReviewed(false)
        await preview.refetch()
      }
    },
  })
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const element = dialog.current
    element?.showModal()
    return () => { element?.close(); previous?.focus() }
  }, [])
  const frontmatter = preview.data?.current.missing ? preview.data.historical.frontmatter : preview.data?.current.frontmatter
  const title = typeof frontmatter?.title === "string" && frontmatter.title.trim() ? frontmatter.title.trim() : targetPath.split("/").pop()?.replace(/\.md$/i, "") || "노트"
  const date = version.data ? new Date(version.data.commit.committedAt).toLocaleString("ko-KR") : version.isError ? "날짜를 불러오지 못했습니다" : "날짜 확인 중…"
  const staleError = apply.error instanceof ApiError && apply.error.code === "stale_note"
  return <dialog ref={dialog} role="dialog" aria-labelledby={titleId} aria-describedby={descriptionId} className="fixed inset-0 m-auto max-h-[85dvh] w-[min(64rem,calc(100vw-2rem))] space-y-3 overflow-y-auto rounded-lg border bg-card p-4 text-foreground shadow-lg backdrop:bg-background/80" onCancel={event => { event.preventDefault(); if (!apply.isPending) onOpenChange(false) }}>
    <div className="flex items-start justify-between gap-2"><div className="min-w-0 space-y-1"><h2 id={titleId} className="text-label-13 font-semibold">이 버전으로 노트 복원</h2>{(versionLabel || version.data) && <p className="break-words text-label-13 text-muted-foreground">{versionLabel || version.data?.commit.subject}</p>}</div><Button size="sm" variant="ghost" disabled={apply.isPending} onClick={() => onOpenChange(false)}>닫기</Button></div>
    <p id={descriptionId} className="text-label-13 leading-5 text-muted-foreground">현재 내용을 선택한 버전으로 바꾸고 새 이력을 남깁니다. 기존 이력은 지워지지 않습니다.</p>
    {apply.isSuccess ? <div role="status" className="space-y-3 border-y py-3">
      <p className="text-label-13 font-medium">{title}을(를) 선택한 버전으로 복원했습니다</p>
      <div className="flex flex-wrap gap-2"><Button nativeButton={false} render={<Link href={noteHref(targetPath)} />} onClick={() => onOpenChange(false)}>복원된 노트 열기</Button><Button variant="outline" nativeButton={false} render={<Link href={historyHref(targetPath)} />} onClick={() => onOpenChange(false)}>변경 기록 보기</Button></div>
    </div> : <>
      {historicalPath !== targetPath ? <div className="space-y-1 border-y px-2 py-1.5 text-label-13"><p className="break-all">불러온 버전: {historicalPath} · {date}</p><p className="break-all font-medium">복원할 노트: {targetPath}</p></div> : <p className="break-all text-label-13">복원할 노트: {targetPath}</p>}
      {me.isPending ? <Loading label="권한을 확인하는 중…" /> : me.isError ? <div className="space-y-2"><ErrorNotice error={me.error} /><Button variant="outline" onClick={() => void me.refetch()}>권한 다시 확인</Button></div> : !allowed ? <p role="alert" className="text-label-13 text-destructive">복원은 편집자와 관리자만 사용할 수 있습니다.</p> : <>
        {preview.isFetching && <Loading label="복원할 내용을 불러오는 중…" />}
        {preview.isError && <div className="space-y-2"><ErrorNotice error={restoreFailure(preview.error)} /><Button variant="outline" disabled={preview.isFetching} onClick={() => { setReviewed(false); void preview.refetch() }}>내용 다시 불러오기</Button></div>}
        {needsReview && <p role="alert" className="text-label-13 text-warning">그 사이 노트가 바뀌었습니다. 최신 내용으로 다시 확인하세요</p>}
        {preview.data && !preview.isError && <>
          {preview.data.current.missing && <p className="break-all text-label-13">현재 이 노트는 삭제되어 있습니다. 복원하면 {targetPath}에 노트를 다시 만듭니다.</p>}
          {identical ? <p role="status" className="text-label-13">이미 이 버전과 같습니다</p> : <DiffView before={preview.data.current.content} after={preview.data.historical.content} beforeLabel="현재 내용" afterLabel="복원 후 내용" />}
          {needsReview && !identical && <label className="flex items-start gap-2 text-label-13"><input type="checkbox" checked={reviewed} disabled={preview.isFetching || apply.isPending} onChange={event => setReviewed(event.target.checked)} className="mt-0.5" />최신 내용과 복원 후 내용의 차이를 확인했습니다</label>}
        </>}
      </>}
      {apply.error && !staleError && <ErrorNotice error={restoreFailure(apply.error)} />}
      <div className="flex flex-wrap justify-end gap-2 border-t pt-2"><Button variant="outline" disabled={apply.isPending} onClick={() => onOpenChange(false)}>취소</Button><Button disabled={!allowed || !preview.data || preview.isFetching || preview.isError || identical || apply.isPending || (needsReview && !reviewed)} onClick={() => apply.mutate()}>{apply.isPending ? "복원하는 중…" : "이 버전으로 복원"}</Button></div>
    </>}
  </dialog>
}
