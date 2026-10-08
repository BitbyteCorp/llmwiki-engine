"use client"

import { useEffect, useRef, useState } from "react"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import dynamic from "next/dynamic"
import { useViewLocation } from "@/components/workspace/view-location"
import { api, historyApi } from "@/lib/api"
import type { CommitInfo } from "@/lib/api"
import { EmptyState, ErrorNotice, Loading, PageHeader, formatDate } from "@/components/common"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CommitByline, compareHref, sourceLabel } from "@/components/history/commit-meta"
import { FileList } from "@/pages-ui/commit-history"

const DiffView = dynamic(() => import("@/components/history/diff-view").then(module => module.DiffView), { loading: () => <Loading label="변경 비교를 준비하는 중…"/> })
const RestoreVersionDialog = dynamic(() => import("@/components/history/restore-version-dialog").then(module => module.RestoreVersionDialog), { loading: () => <Loading label="복원 미리보기를 준비하는 중…"/> })
const selectClass = "h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-label-13 outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"

function versionLabel(commit: CommitInfo): string {
  return `${commit.subject || "제목 없는 변경"} · ${formatDate(commit.committedAt)}`
}

function versionOption(commit: CommitInfo): string {
  const requester = commit.trailers["Wiki-Requester"]
  const name = (requester || commit.authorName || commit.authorEmail).replace(/<[^>]*>/g, "").trim().replace(/\b([^\s@]+)@[^\s]+/g, "$1")
  const requested = requester && requester !== commit.authorName && requester !== commit.authorEmail
  return `${formatDate(commit.committedAt)} · ${commit.subject || "제목 없는 변경"} · ${name || "이름 없는 작성자"}${requested ? " 요청 · 도니가 정리" : ""} · ${sourceLabel(commit.trailers)}`
}

function RetryError({ error, retry }: { error: unknown; retry(): void }) {
  return <div className="space-y-1.5"><ErrorNotice error={error}/><Button variant="outline" onClick={retry}>다시 불러오기</Button></div>
}

function VersionPicker({ label, value, commits, selectedCommit, onChange, loading }: { label: string; value: string; commits: CommitInfo[]; selectedCommit?: CommitInfo; onChange(value: string): void; loading: boolean }) {
  return <div className="min-w-0 space-y-1"><label className="block space-y-1 text-xs text-muted-foreground">{label}<select className={selectClass} value={value} aria-label={label} onChange={event => onChange(event.target.value)}>
    <option value="">버전을 선택하세요</option><option value="main">현재 버전</option>
    {value && value !== "main" && !commits.some(commit => commit.sha === value) && <option value={value}>{selectedCommit ? versionOption(selectedCommit) : loading ? "선택한 버전 확인 중…" : "선택한 버전 (고급 비교에서 지정)"}</option>}
    {commits.map(commit => <option key={commit.sha} value={commit.sha}>{versionOption(commit)}</option>)}
  </select></label>{selectedCommit && value !== "main" && <CommitByline commit={selectedCommit}/>}</div>
}

export function ComparePage() {
  const { searchParams: params, push } = useViewLocation()
  const base = params.get("base") || ""
  const head = params.get("head") ?? "main"
  const path = params.get("path") || undefined
  const [draft, setDraft] = useState({ base, head, path: path || "" })
  const [choosingNote, setChoosingNote] = useState(!path)
  const [notePath, setNotePath] = useState(path || "")
  const [restore, setRestore] = useState<{ versionSha: string; historicalPath: string; versionLabel: string } | null>(null)
  const [preparingRestore, setPreparingRestore] = useState(false)
  const [restoreError, setRestoreError] = useState<unknown>(null)
  const restoreRequest = useRef(0)
  useEffect(() => {
    restoreRequest.current += 1
    setDraft({ base, head, path: path || "" })
    setNotePath(path || "")
    setChoosingNote(!path)
    setRestore(null)
    setRestoreError(null)
    setPreparingRestore(false)
    return () => { restoreRequest.current += 1 }
  }, [base, head, path])
  const me = useQuery({ queryKey: ["me"], queryFn: api.me })
  const allowed = me.data?.user.role === "editor" || me.data?.user.role === "admin"
  const tree = useQuery({ queryKey: ["notes/tree"], queryFn: api.tree, enabled: choosingNote })
  const history = useInfiniteQuery({
    queryKey: ["history", "list", path, "follow"],
    queryFn: ({ pageParam, signal }) => historyApi.list({ path, before: pageParam, follow: !!path }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.commits.length === 30 ? page.commits.at(-1)?.sha : undefined,
  })
  const commits = history.data?.pages.flatMap(page => page.commits) ?? []
  const query = useQuery({ queryKey: ["history", "compare", base, head, path], queryFn: ({ signal }) => historyApi.compare(base, head, path, signal), enabled: !!base && !!head })
  const listedBase = commits.find(commit => commit.sha === base || commit.sha === query.data?.base)
  const listedHead = commits.find(commit => commit.sha === head || commit.sha === query.data?.head)
  const baseDetail = useQuery({ queryKey: ["history", "commit", query.data?.base || base, 1], queryFn: ({ signal }) => historyApi.commit(query.data?.base || base, 1, signal), enabled: !!base && base !== "main" && !!query.data && !listedBase })
  const headDetail = useQuery({ queryKey: ["history", "commit", query.data?.head || head, 1], queryFn: ({ signal }) => historyApi.commit(query.data?.head || head, 1, signal), enabled: !!head && head !== "main" && !!query.data && !listedHead })
  const baseCommit = listedBase || baseDetail.data?.commit
  const headCommit = listedHead || headDetail.data?.commit
  const baseSummary = base === "main" ? "현재 버전" : baseCommit ? versionLabel(baseCommit) : base ? "선택한 이전 버전" : "이전 버전 선택"
  const headSummary = head === "main" ? "현재 버전" : headCommit ? versionLabel(headCommit) : head ? "선택한 이후 버전" : "이후 버전 선택"
  function selectVersion(field: "base" | "head", value: string) {
    push(compareHref(field === "base" ? value : base, field === "head" ? value : head, path))
  }
  async function prepareRestore() {
    if (!path || !query.data || preparingRestore) return
    const targetPath = path
    const versionSha = query.data.base
    const requestId = ++restoreRequest.current
    setPreparingRestore(true)
    setRestoreError(null)
    try {
      // Follow the full note lineage before restoring a version outside the loaded page.
      let historicalPath = listedBase ? listedBase.path || targetPath : undefined
      let versions = history.data?.pages.at(-1)?.commits ?? (await historyApi.list({ path: targetPath, follow: true })).commits
      while (!historicalPath) {
        const match = versions.find(commit => commit.sha === versionSha)
        if (match) { historicalPath = match.path || targetPath; break }
        if (versions.length < 30) break
        const page = await historyApi.list({ path: targetPath, follow: true, before: versions.at(-1)?.sha })
        versions = page.commits
        if (restoreRequest.current !== requestId) return
      }
      if (!historicalPath) {
        // A repository ref can fall between note edits; its preceding note version identifies the path.
        const previous = await historyApi.list({ path: targetPath, follow: true, before: versionSha, limit: 1 })
        historicalPath = previous.commits[0]?.path || targetPath
      }
      if (restoreRequest.current === requestId) setRestore({ versionSha, historicalPath, versionLabel: baseCommit ? versionLabel(baseCommit) : "선택한 이전 버전" })
    } catch (error) { if (restoreRequest.current === requestId) setRestoreError(error) }
    finally { if (restoreRequest.current === requestId) setPreparingRestore(false) }
  }
  return <div className="min-w-0 space-y-3">
    <PageHeader title="버전 비교" description={base ? `${baseSummary} → ${headSummary}` : "노트를 고른 뒤 비교할 두 버전을 선택하세요."}/>
    <div className="flex flex-wrap items-center gap-1.5"><Badge variant="outline" className="max-w-full whitespace-normal break-all">{path || "전체 노트"}</Badge><Button variant="ghost" onClick={() => setChoosingNote(value => !value)}>{path ? "다른 노트" : "노트 선택"}</Button></div>
    {choosingNote && <form className="space-y-1.5 border-b pb-2" onSubmit={event => { event.preventDefault(); if (notePath.trim()) { push(compareHref("", "main", notePath.trim())); setChoosingNote(false) } }}><div className="flex flex-wrap items-end gap-1.5"><label className="min-w-0 flex-1 space-y-1 text-xs text-muted-foreground">노트 선택<Input list="compare-note-options" value={notePath} onChange={event => setNotePath(event.target.value)} placeholder="노트 제목 또는 경로" aria-label="비교할 노트 선택" required/><datalist id="compare-note-options">{tree.data?.files.filter(file => file.endsWith(".md")).map(file => <option key={file} value={file}>{file.split("/").at(-1)?.replace(/\.md$/, "")}</option>)}</datalist></label><Button variant="outline" type="submit" disabled={!notePath.trim()}>선택</Button></div>{tree.isPending && <Loading label="노트 목록을 불러오는 중…"/>}{tree.isError && <RetryError error={tree.error} retry={() => void tree.refetch()}/>}</form>}
    <div className="grid min-w-0 gap-x-4 gap-y-2 sm:grid-cols-2"><VersionPicker label="이전 버전" value={base} commits={commits} selectedCommit={baseCommit} onChange={value => selectVersion("base", value)} loading={query.isFetching || baseDetail.isFetching}/><VersionPicker label="선택한 버전" value={head} commits={commits} selectedCommit={headCommit} onChange={value => selectVersion("head", value)} loading={query.isFetching || headDetail.isFetching}/></div>
    <div className="flex flex-wrap gap-1.5"><Button variant="outline" disabled={!base || !head} onClick={() => push(compareHref(head, base, path))}>두 버전 바꾸기</Button>{history.hasNextPage && <Button variant="ghost" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>{history.isFetchingNextPage ? "불러오는 중…" : "이전 버전 더 보기"}</Button>}{path && allowed && <Button disabled={!base || !query.data || query.isFetching || preparingRestore} onClick={() => void prepareRestore()}>{preparingRestore ? "복원할 버전 확인 중…" : "이 버전으로 복원…"}</Button>}</div>
    {path && allowed && base && <p className="text-xs text-muted-foreground">복원은 왼쪽의 이전 버전 내용을 현재 노트에 적용합니다.</p>}
    {restoreError != null && <ErrorNotice error={restoreError}/>}
    {history.isError && <RetryError error={history.error} retry={() => void history.refetch()}/>}
    {history.isPending && <Loading label="선택할 버전 이력을 불러오는 중…"/>}
    {baseDetail.isError && <RetryError error={baseDetail.error} retry={() => void baseDetail.refetch()}/>}
    {headDetail.isError && <RetryError error={headDetail.error} retry={() => void headDetail.refetch()}/>}
    {!base || !head ? <EmptyState title="비교할 두 버전을 선택해 주세요" description="이전 버전을 고르고, 다른 과거 버전이나 현재 버전과 비교하세요."/> : query.isPending ? <Loading label="버전을 비교하는 중…"/> : query.isError ? <RetryError error={query.error} retry={() => void query.refetch()}/> : query.data && <section className="min-w-0 space-y-1.5" aria-label="두 버전의 변경 내용"><DiffView patch={query.data.patch} beforeLabel="이전 버전" afterLabel={head === "main" ? "현재 버전" : "선택한 버전"}/><FileList files={query.data.files} versionSha={query.data.head} deletedVersionSha={query.data.base}/></section>}
    <details className="space-y-1.5"><summary className="h-7 cursor-pointer border-b text-label-13 font-semibold leading-7">고급 비교</summary><form className="space-y-1.5" onSubmit={event => { event.preventDefault(); push(compareHref(draft.base.trim(), draft.head.trim(), draft.path.trim() || undefined)) }}><div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-2">{(["base", "head"] as const).map(field => <label key={field} className="block min-w-0 space-y-1 text-xs text-muted-foreground">{field === "base" ? "이전 버전 SHA / ref" : "이후 버전 SHA / ref"}<Input required value={draft[field]} onChange={event => setDraft(value => ({ ...value, [field]: event.target.value }))} aria-label={`${field} 버전`}/></label>)}</div><label className="block space-y-1 text-xs text-muted-foreground">파일 경로 (비우면 전체 노트)<Input value={draft.path} onChange={event => setDraft(value => ({ ...value, path: event.target.value }))} aria-label="비교 파일 경로"/></label><Button type="submit" variant="outline" disabled={!draft.base.trim() || !draft.head.trim()}>비교 적용</Button>{query.data && <p className="break-all font-mono text-xs text-muted-foreground">{query.data.base} → {query.data.head}</p>}</form></details>
    {restore && path && <RestoreVersionDialog targetPath={path} {...restore} open onOpenChange={open => { if (!open) setRestore(null) }}/>}
  </div>
}
