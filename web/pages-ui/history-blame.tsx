"use client"

import Link from "next/link"
import { useViewLocation } from "@/components/workspace/view-location"
import { useQuery } from "@tanstack/react-query"
import { api, historyApi } from "@/lib/api"
import { EmptyState, ErrorNotice, Loading, PageHeader, formatDate, noteHref } from "@/components/common"
import { Button } from "@/components/ui/button"
import { BlameView } from "@/components/history/blame-view"
import { historyHref, versionHref } from "@/components/history/commit-meta"
import { NoteHistoryPicker } from "@/pages-ui/note-history"

export function BlamePage() {
  const { searchParams: params, push } = useViewLocation()
  const path = params.get("path") || ""
  const ref = params.get("ref") || undefined
  const query = useQuery({ queryKey: ref ? ["notes/content", path, ref] : ["notes/content", path], queryFn: () => api.note(path, ref), enabled: !!path })
  const version = useQuery({ queryKey: ["history", "commit", query.data?.updatedSha, 1], queryFn: ({ signal }) => historyApi.commit(query.data!.updatedSha, 1, signal), enabled: !!ref && !!query.data })
  const versionLabel = ref ? version.data ? formatDate(version.data.commit.committedAt) : "선택한 버전" : "현재 버전"
  return <div className="flex h-full min-h-96 min-w-0 flex-col gap-3">
    <PageHeader title="줄별 작성자" description={path ? <span className="break-all">{path} · {versionLabel}</span> : "노트를 선택하면 각 줄을 작성한 사람과 변경 시점을 볼 수 있습니다."} actions={path ? <>
      <Button size="xs" variant="outline" nativeButton={false} render={<Link href={ref ? versionHref(path, ref, params.get("current") || undefined) : noteHref(path)}/>}>노트 열기</Button>
      <Button size="xs" variant="outline" nativeButton={false} render={<Link href={historyHref(params.get("current") || path)}/>}>변경 이력</Button>
    </> : undefined}/>
    <NoteHistoryPicker key={path} path={path} onSelect={nextPath => push(`/history/blame?${new URLSearchParams({ path: nextPath })}`)}/>
    {!path ? <EmptyState title="줄별 작성자를 확인할 노트를 선택하세요"/> : query.isPending ? <Loading label="노트 내용을 불러오는 중…"/> : query.isError ? <><ErrorNotice error={query.error}/><Button size="xs" variant="outline" onClick={() => void query.refetch()}>다시 불러오기</Button></> : <>
      <p className="shrink-0 text-xs text-muted-foreground">줄 왼쪽의 작성자를 선택하면 언제, 어떤 변경에서 작성됐는지 볼 수 있습니다.</p>
      <BlameView path={path} ref={query.data.updatedSha} content={query.data.content} className="min-h-0 flex-1"/>
    </>}
  </div>
}
