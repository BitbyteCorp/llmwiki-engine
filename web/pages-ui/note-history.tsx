"use client"

import { useId, useRef, useState } from "react"
import type { Ref } from "react"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import Link from "next/link"
import dynamic from "next/dynamic"
import { useViewLocation } from "@/components/workspace/view-location"
import { api, historyApi } from "@/lib/api"
import type { CommitInfo } from "@/lib/api"
import { EmptyState, ErrorNotice, Loading, PageHeader, formatDate, noteHref } from "@/components/common"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CommitByline, commitHref, compareHref, historyHref, versionHref } from "@/components/history/commit-meta"

const DiffView = dynamic(() => import("@/components/history/diff-view").then(module => module.DiffView), { loading: () => <Loading label="변경 내용을 준비하는 중…"/> })
const RestoreVersionDialog = dynamic(() => import("@/components/history/restore-version-dialog").then(module => module.RestoreVersionDialog), { loading: () => <Loading label="복원 미리보기를 준비하는 중…"/> })
const RevertDialog = dynamic(() => import("@/components/history/revert-dialog").then(module => module.RevertDialog), { loading: () => <Loading label="변경 취소 미리보기를 준비하는 중…"/> })

export function NoteHistoryPicker({ path = "", inputRef, onSelect }: { path?: string; inputRef?: Ref<HTMLInputElement>; onSelect(path: string): void }) {
  const id = useId()
  const [draft, setDraft] = useState(path)
  const tree = useQuery({ queryKey: ["notes/tree"], queryFn: api.tree })
  return <form className="shrink-0 space-y-1.5 border-b pb-2" onSubmit={event => { event.preventDefault(); if (draft.trim()) onSelect(draft.trim()) }}>
    <div className="flex items-end gap-1.5">
      <label className="min-w-0 flex-1 space-y-1 text-xs text-muted-foreground" htmlFor={id}>노트 선택
        <Input id={id} ref={inputRef} list={`${id}-notes`} value={draft} onChange={event => setDraft(event.target.value)} placeholder="노트 이름으로 찾기…" required autoComplete="off"/>
      </label>
      <datalist id={`${id}-notes`}>{tree.data?.files.filter(file => /\.md$/i.test(file)).map(file => <option key={file} value={file}>{file.split("/").at(-1)?.replace(/\.md$/i, "")}</option>)}</datalist>
      <Button size="sm" variant="outline" type="submit">노트 선택</Button>
    </div>
    {tree.isPending && <p role="status" className="text-xs text-muted-foreground">선택할 노트를 불러오는 중…</p>}
    {tree.isError && <><ErrorNotice error={tree.error}/><Button size="xs" variant="outline" onClick={() => void tree.refetch()}>노트 목록 다시 불러오기</Button></>}
  </form>
}

function dayHeading(iso: string): string {
  const date = new Date(iso)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return "오늘"
  if (date.toDateString() === yesterday.toDateString()) return "어제"
  return `${date.getFullYear() !== today.getFullYear() ? `${date.getFullYear()}년 ` : ""}${date.getMonth() + 1}월 ${date.getDate()}일`
}

function InlineChange({ commit, historicalPath }: { commit: CommitInfo; historicalPath: string }) {
  const query = useQuery({
    queryKey: ["history", "note-change", commit.sha, historicalPath],
    queryFn: async ({ signal }) => {
      if (commit.parents[0]) return { patch: (await historyApi.compare(commit.parents[0], commit.sha, historicalPath, signal)).patch }
      const note = await api.note(historicalPath, commit.sha)
      return { before: "", after: note.content }
    },
  })
  return <section id={`change-${commit.sha}`} aria-label="이 노트의 변경 내용" className="min-w-0 space-y-1.5 border-t pt-1.5">
    {query.isPending ? <Loading label="이 버전의 변경 내용을 불러오는 중…"/> : query.isError ? <><ErrorNotice error={query.error}/><Button size="xs" variant="outline" onClick={() => void query.refetch()}>다시 불러오기</Button></> : <DiffView {...query.data} beforeLabel="이전 버전" afterLabel="선택한 버전"/>}
  </section>
}

function VersionRow({ commit, path, allowed, selecting, selected, selectionFull, onSelect, onRestore, onRevert }: {
  commit: CommitInfo; path: string; allowed: boolean; selecting: boolean; selected: boolean; selectionFull: boolean
  onSelect(checked: boolean): void; onRestore(): void; onRevert(paths: string[]): void
}) {
  const [expanded, setExpanded] = useState(false)
  const historicalPath = commit.path || path
  const subject = commit.subject || "제목 없는 변경"
  return <li className="min-w-0 space-y-1.5 px-2 py-1.5">
    <div className="flex items-start gap-1.5">
      {selecting && <input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" aria-label={`${subject} 비교 선택`} checked={selected} disabled={selectionFull && !selected} onChange={event => onSelect(event.target.checked)}/>}
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="break-words text-label-13 font-medium">{subject}</p>
        <CommitByline commit={commit}/>
        {commit.oldPath ? <p className="break-all text-xs text-muted-foreground">이름 변경: {commit.oldPath} → {historicalPath}</p> : historicalPath !== path ? <p className="break-all text-xs text-muted-foreground">당시 노트: {historicalPath}</p> : null}
      </div>
    </div>
    <div className="flex flex-wrap items-center gap-1.5">
      <Button size="xs" variant="outline" aria-expanded={expanded} aria-controls={`change-${commit.sha}`} onClick={() => setExpanded(value => !value)}>변경 내용 보기</Button>
      <Button size="xs" variant="ghost" nativeButton={false} render={<Link href={compareHref(commit.sha, "main", path)}/>}>현재와 비교</Button>
      {allowed && <Button size="xs" onClick={onRestore}>이 버전으로 복원…</Button>}
      <details className="text-xs">
        <summary className="cursor-pointer rounded-md px-2 py-1 hover:bg-accent">더보기</summary>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-y px-2 py-1.5">
          <Link className="underline underline-offset-4" href={versionHref(historicalPath, commit.sha, path)}>이 버전 보기</Link>
          {allowed && <button className="text-destructive underline underline-offset-4" onClick={() => onRevert([...new Set([historicalPath, ...(commit.oldPath ? [commit.oldPath] : [])])])}>이 변경만 취소…</button>}
          <Link className="underline underline-offset-4" href={`/history/blame?${new URLSearchParams({ path: historicalPath, ref: commit.sha, ...(historicalPath !== path ? { current: path } : {}) })}`}>줄별 작성자</Link>
          <Link className="underline underline-offset-4" href={commitHref(commit.sha)}>전체 변경 상세</Link>
        </div>
      </details>
    </div>
    {expanded && <InlineChange commit={commit} historicalPath={historicalPath}/>}
  </li>
}

export function NoteHistory({ path }: { path: string }) {
  const { push } = useViewLocation()
  const pickerRef = useRef<HTMLInputElement>(null)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [restore, setRestore] = useState<CommitInfo | null>(null)
  const [revert, setRevert] = useState<{ sha: string; paths: string[] } | null>(null)
  const me = useQuery({ queryKey: ["me"], queryFn: api.me })
  const note = useQuery({ queryKey: ["notes/content", path], queryFn: () => api.note(path), retry: false })
  const allowed = me.data?.user.role === "editor" || me.data?.user.role === "admin"
  const history = useInfiniteQuery({
    queryKey: ["history", "list", path, "follow"],
    queryFn: ({ pageParam, signal }) => historyApi.list({ path, before: pageParam, follow: true }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.commits.length === 30 ? page.commits.at(-1)?.sha : undefined,
  })
  const commits = history.data?.pages.flatMap(page => page.commits) ?? []
  const pair = commits.filter(commit => selected.includes(commit.sha))
  const groups = new Map<string, CommitInfo[]>()
  for (const commit of commits) {
    const day = dayHeading(commit.committedAt)
    const group = groups.get(day)
    if (group) group.push(commit)
    else groups.set(day, [commit])
  }
  const title = typeof note.data?.frontmatter.title === "string" ? note.data.frontmatter.title : path.split("/").at(-1)?.replace(/\.md$/i, "") || path
  return <div className="min-w-0 space-y-3">
    <PageHeader title={`${title} · 변경 이력`} description={<span className="break-all">{path} · 이름 변경 전 이력도 이어서 표시합니다.</span>} actions={<>
      <Button size="xs" variant="outline" nativeButton={false} render={<Link href={noteHref(path)}/>}>노트 열기</Button>
      <Button size="xs" variant="outline" nativeButton={false} render={<Link href={`/history/blame?${new URLSearchParams({ path })}`}/>}>줄별 작성자</Button>
      <Button size="xs" variant="outline" nativeButton={false} render={<Link href="/history"/>}>전체 활동</Button>
    </>}/>
    <NoteHistoryPicker path={path} inputRef={pickerRef} onSelect={nextPath => push(historyHref(nextPath))}/>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Button size="xs" variant="outline" aria-pressed={selecting} onClick={() => { setSelecting(value => !value); setSelected([]) }}>{selecting ? "버전 선택 닫기" : "비교할 두 버전 선택"}</Button>
    </div>
    {selecting && <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-y bg-background px-2 py-1.5">
      <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite">{selected.length}/2 선택 · 이전 버전부터 비교합니다</span>
      <Button size="xs" disabled={pair.length !== 2} onClick={() => { if (pair.length === 2) push(compareHref(pair[1].sha, pair[0].sha, path)) }}>선택한 두 버전 비교</Button>
      {selected.length > 0 && <Button size="xs" variant="ghost" onClick={() => setSelected([])}>선택 해제</Button>}
    </div>}
    {history.isPending && <Loading label="노트 이력을 불러오는 중…"/>}
    {history.isError && <><ErrorNotice error={history.error}/><Button size="xs" variant="outline" onClick={() => void history.refetch()}>다시 불러오기</Button></>}
    {!history.isPending && !history.isError && !commits.length && <div className="text-center"><EmptyState title="아직 변경 이력이 없습니다" description="이 노트의 읽을 수 있는 변경 이력이 없습니다."/><Button size="xs" variant="outline" onClick={() => { pickerRef.current?.focus(); pickerRef.current?.select() }}>다른 노트 선택</Button></div>}
    {[...groups].map(([day, versions]) => <section key={day} className="min-w-0 space-y-1.5">
      <h2 className="text-label-13 font-semibold">{day}</h2>
      <ul className="divide-y border-y">{versions.map(commit => <VersionRow key={commit.sha} commit={commit} path={path} allowed={allowed} selecting={selecting} selected={selected.includes(commit.sha)} selectionFull={selected.length === 2} onSelect={checked => setSelected(previous => checked ? [...previous, commit.sha] : previous.filter(sha => sha !== commit.sha))} onRestore={() => setRestore(commit)} onRevert={paths => setRevert({ sha: commit.sha, paths })}/>)}</ul>
    </section>)}
    {history.hasNextPage && <Button size="xs" variant="outline" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>{history.isFetchingNextPage ? "불러오는 중…" : "이전 변경 더 보기"}</Button>}
    {restore && <RestoreVersionDialog targetPath={path} historicalPath={restore.path || path} versionSha={restore.sha} versionLabel={`${restore.subject || "제목 없는 변경"} · ${formatDate(restore.committedAt)}`} open onOpenChange={open => { if (!open) setRestore(null) }}/>}
    {revert && <RevertDialog {...revert} open onOpenChange={open => { if (!open) setRevert(null) }}/>}
  </div>
}
