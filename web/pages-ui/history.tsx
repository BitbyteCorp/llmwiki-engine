"use client"

import { useEffect, useState } from "react"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import Link from "next/link"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { api, historyApi, type CommitInfo, type FileChange } from "@/lib/api"
import { EmptyState, ErrorNotice, Loading, PageHeader, formatDate, noteHref } from "@/components/common"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DiffView } from "@/components/history/diff-view"
import { BlameView } from "@/components/history/blame-view"
import { RevertDialog } from "@/components/history/revert-dialog"
import { ActivityPage } from "@/pages-ui/activity"

const fileLabels = { A: "추가", M: "수정", D: "삭제", R: "이동" }
const jobStatusLabels = { queued: "대기 중", running: "처리 중", merging: "병합 중", succeeded: "완료", failed: "실패" }
const selectClass = "h-9 w-full min-w-0 rounded-md border bg-background px-3 text-sm"
function compareHref(base: string, head: string, path?: string) {
  const params = new URLSearchParams({ base, head })
  if (path) params.set("path", path)
  return `/history/compare?${params}`
}
function historyHref(path: string) { return `/history?${new URLSearchParams({ path, follow: "1" })}` }
function commitHref(sha: string) { return `/history/commits/${encodeURIComponent(sha)}` }
function relativeDate(value: string) {
  const seconds = (new Date(value).getTime() - Date.now()) / 1000
  const formatter = new Intl.RelativeTimeFormat("ko-KR", { numeric: "auto" })
  for (const [unit, divisor] of [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]] as const) {
    if (Math.abs(seconds) >= divisor) return formatter.format(Math.round(seconds / divisor), unit)
  }
  return formatter.format(Math.round(seconds), "second")
}
function CommitTime({ commit }: { commit: CommitInfo }) {
  return <time className="text-xs text-muted-foreground" dateTime={commit.committedAt} title={formatDate(commit.committedAt)}>{relativeDate(commit.committedAt)} · {formatDate(commit.committedAt)}</time>
}
function CommitPeople({ commit }: { commit: CommitInfo }) {
  return <div className="space-y-1 break-words text-xs text-muted-foreground"><p>작성자 {commit.authorName} &lt;{commit.authorEmail}&gt;</p><p>요청자 {commit.trailers["Wiki-Requester"] || "기록 없음"}</p><p>커미터 {commit.committerName} &lt;{commit.committerEmail}&gt;</p></div>
}
function SourceBadge({ commit }: { commit: CommitInfo }) {
  return <Badge variant="outline">{commit.trailers["Wiki-Source"] || "Git"}{commit.trailers["Wiki-Client"] ? ` · ${commit.trailers["Wiki-Client"]}` : ""}</Badge>
}
function RetryError({ error, retry }: { error: unknown; retry(): void }) {
  return <div className="space-y-2"><ErrorNotice error={error}/><Button variant="outline" onClick={retry}>다시 시도</Button></div>
}
function useHistory(path?: string) {
  return useInfiniteQuery({
    queryKey: ["history", "list", path, "follow"],
    queryFn: ({ pageParam, signal }) => historyApi.list({ path, before: pageParam, follow: !!path }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.commits.length === 30 ? page.commits.at(-1)?.sha : undefined,
  })
}
interface HistoryPagination { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage(): Promise<unknown> }
function MoreHistory({ query }: { query: HistoryPagination }) {
  return query.hasNextPage ? <Button type="button" variant="outline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? "불러오는 중…" : "이전 커밋 더 보기"}</Button> : null
}

export function HistoryPage() {
  const params = useSearchParams()
  const path = params.get("path") || undefined
  if (!path || params.get("view") === "activity") return <ActivityPage/>
  return <NoteHistory key={path} path={path}/>
}

function NoteHistory({ path }: { path: string }) {
  const router = useRouter()
  const [draftPath, setDraftPath] = useState(path)
  const [selected, setSelected] = useState<string[]>([])
  const [revert, setRevert] = useState<{ sha: string; paths: string[] } | null>(null)
  const me = useQuery({ queryKey: ["me"], queryFn: api.me })
  const allowed = me.data?.user.role === "editor" || me.data?.user.role === "admin"
  const history = useHistory(path)
  const commits = history.data?.pages.flatMap(page => page.commits) ?? []
  const pair = commits.filter(commit => selected.includes(commit.sha))
  return <div className="min-w-0 space-y-6">
    <PageHeader title="노트 변경 이력" description="이름 변경을 따라 이전 경로의 커밋까지 확인한다." actions={<Button variant="outline" nativeButton={false} render={<Link href="/history"/>}>전체 활동</Button>}/>
    <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); if (draftPath.trim()) router.push(historyHref(draftPath.trim())) }}><label className="min-w-0 flex-1 space-y-1 text-sm">노트 경로<Input value={draftPath} onChange={event => setDraftPath(event.target.value)} required aria-label="이력 노트 경로"/></label><Button variant="outline" type="submit">경로 변경</Button></form>
    <div className="flex flex-wrap items-center gap-4 text-sm"><Link className="underline underline-offset-4" href={noteHref(path)}>현재 노트</Link><Link className="underline underline-offset-4" href={`/history/blame?${new URLSearchParams({ path })}`}>줄별 작성 이력 (Blame)</Link><span className="text-muted-foreground">두 커밋을 선택하면 오래된 커밋 → 새 커밋으로 비교한다.</span></div>
    <div className="flex flex-wrap items-center gap-3"><span className="text-sm" aria-live="polite">{selected.length}/2 선택</span><Button disabled={pair.length !== 2} onClick={() => { if (pair.length === 2) router.push(compareHref(pair[1].sha, pair[0].sha, path)) }}>선택한 두 커밋 비교</Button>{selected.length > 0 && <Button variant="ghost" onClick={() => setSelected([])}>선택 해제</Button>}</div>
    {history.isPending && <Loading label="노트 이력을 불러오는 중…"/>}
    {history.isError && <RetryError error={history.error} retry={() => void history.refetch()}/>}
    {!history.isPending && !history.isError && !commits.length && <EmptyState title="변경 이력이 없습니다" description="이 경로의 커밋이 없거나 읽을 수 있는 이력이 없습니다."/>}
    {commits.length > 0 && <ul className="divide-y rounded-lg border">{commits.map(commit => {
      const historicalPath = commit.path || path
      return <li key={commit.sha} className="space-y-3 p-4">
        <div className="flex items-start gap-3"><input type="checkbox" className="mt-1 size-4 shrink-0 accent-primary" aria-label={`${commit.subject || commit.sha.slice(0, 8)} 비교 선택`} checked={selected.includes(commit.sha)} disabled={selected.length === 2 && !selected.includes(commit.sha)} onChange={event => setSelected(previous => event.target.checked ? [...previous, commit.sha] : previous.filter(sha => sha !== commit.sha))}/><div className="min-w-0 flex-1 space-y-2"><div className="flex flex-wrap items-center gap-2"><Link className="font-medium hover:underline" href={commitHref(commit.sha)}>{commit.subject || "제목 없는 커밋"}</Link><SourceBadge commit={commit}/></div><div className="flex flex-wrap gap-3"><Link href={commitHref(commit.sha)} className="font-mono text-xs underline">{commit.sha.slice(0, 8)}</Link><CommitTime commit={commit}/></div><CommitPeople commit={commit}/>{commit.oldPath ? <p className="break-all rounded bg-muted p-2 text-xs">경로 변경: {commit.oldPath} → {historicalPath}</p> : historicalPath !== path ? <p className="break-all text-xs text-muted-foreground">당시 경로: {historicalPath}</p> : null}</div></div>
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs"><Link className="underline underline-offset-4" href={`${noteHref(historicalPath)}?ref=${encodeURIComponent(commit.sha)}`}>이 버전 보기</Link><Link className="underline underline-offset-4" href={commitHref(commit.sha)}>이 커밋의 변경</Link><Link className="underline underline-offset-4" href={compareHref(commit.sha, "main", path)}>현재와 비교</Link><Link className="underline underline-offset-4" href={`/history/blame?${new URLSearchParams({ path: historicalPath, ref: commit.sha })}`}>이 버전 Blame</Link>{allowed && <button className="text-destructive underline underline-offset-4" onClick={() => setRevert({ sha: commit.sha, paths: [...new Set([historicalPath, ...(commit.oldPath ? [commit.oldPath] : [])])] })}>이 노트 변경 되돌리기</button>}</div>
      </li>
    })}</ul>}
    <MoreHistory query={history}/>
    {revert && <RevertDialog {...revert} open onOpenChange={open => { if (!open) setRevert(null) }}/>} 
  </div>
}

function FileList({ files, ref, selected, onSelect }: { files: FileChange[]; ref: string; selected?: string[]; onSelect?(path: string, checked: boolean): void }) {
  return files.length ? <ul className="divide-y rounded-lg border">{files.map(file => <li key={`${file.status}-${file.path}`} className="flex items-start gap-3 p-3 text-sm">{onSelect && <input type="checkbox" className="mt-1 size-4 shrink-0 accent-primary" aria-label={`${file.path} 되돌리기 선택`} checked={selected?.includes(file.path) ?? false} onChange={event => onSelect(file.path, event.target.checked)}/>}<Badge variant="outline">{fileLabels[file.status]}</Badge><div className="min-w-0 break-all">{file.oldPath && <span className="text-muted-foreground">{file.oldPath} → </span>}{file.status === "D" || !file.path.endsWith(".md") ? <span>{file.path}</span> : <Link className="hover:underline" href={`${noteHref(file.path)}?ref=${encodeURIComponent(ref)}`}>{file.path}</Link>}</div></li>)}</ul> : <EmptyState title="변경된 파일이 없습니다"/>
}

export function CommitPage() {
  const { sha: encodedSha } = useParams<{ sha: string }>()
  const sha = encodedSha === undefined ? "" : decodeURIComponent(encodedSha)
  return <CommitDetail key={sha} sha={sha}/>
}
function CommitDetail({ sha }: { sha: string }) {
  const [parent, setParent] = useState(1)
  const [selected, setSelected] = useState<string[]>([])
  const [revert, setRevert] = useState<{ paths?: string[] } | null>(null)
  const me = useQuery({ queryKey: ["me"], queryFn: api.me })
  const allowed = me.data?.user.role === "editor" || me.data?.user.role === "admin"
  const query = useQuery({ queryKey: ["history", "commit", sha, parent], queryFn: ({ signal }) => historyApi.commit(sha, parent, signal), enabled: !!sha })
  if (!sha) return <EmptyState title="커밋을 선택해 주세요"/>
  if (query.isPending) return <Loading label="커밋을 불러오는 중…"/>
  if (query.isError) return <RetryError error={query.error} retry={() => void query.refetch()}/>
  const { commit, files, patch, job } = query.data
  const selectedFiles = files.filter(file => selected.includes(file.path))
  const selectedPaths = [...new Set(selectedFiles.flatMap(file => file.oldPath ? [file.path, file.oldPath] : [file.path]))]
  return <div className="min-w-0 space-y-6">
    <PageHeader title={commit.subject || "커밋 상세"} description={<span className="break-all font-mono text-xs">{commit.sha}</span>} actions={<Button variant="outline" nativeButton={false} render={<Link href="/history"/>}>전체 활동</Button>}/>
    <section className="space-y-3 rounded-lg border p-4"><div className="flex flex-wrap items-center gap-3"><SourceBadge commit={commit}/><CommitTime commit={commit}/></div><CommitPeople commit={commit}/><p className="text-xs text-muted-foreground">작성 시각 {formatDate(commit.date)}</p><p className="text-sm">연결된 작업: {job ? <Link className="break-all underline" href={`/jobs/${encodeURIComponent(job.id)}`}>{job.id} · {jobStatusLabels[job.status]}</Link> : "접근 가능한 연결 작업 없음"}</p></section>
    {commit.body && <details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">커밋 본문과 메타데이터</summary><p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6">{commit.body}</p></details>}
    {commit.parents.length > 1 && <label className="block space-y-1 text-sm">변경 비교 기준 부모<select className={selectClass} value={parent} onChange={event => { setParent(Number(event.target.value)); setSelected([]) }}>{commit.parents.map((sha, index) => <option key={sha} value={index + 1}>부모 {index + 1} · {sha}</option>)}</select></label>}
    {commit.parents.length <= 1 && <p className="break-all text-xs text-muted-foreground">기준: {commit.parents[0] ? `부모 1 · ${commit.parents[0]}` : "최초 커밋 (빈 저장소)"}</p>}
    <section className="space-y-3"><h2 className="text-lg font-semibold">변경 파일 · {files.length}</h2><FileList files={files} ref={commit.sha} selected={selected} onSelect={allowed && parent === 1 ? (path, checked) => setSelected(previous => checked ? [...previous, path] : previous.filter(value => value !== path)) : undefined}/></section>
    {allowed && <div className="space-y-2"><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => setRevert({})}>커밋 전체 되돌리기</Button><Button variant="outline" disabled={parent !== 1 || !selectedPaths.length} onClick={() => setRevert({ paths: selectedPaths })}>선택 파일 되돌리기 ({selectedFiles.length})</Button></div>{commit.parents.length > 1 && <p className="text-xs text-muted-foreground">되돌리기는 부모 1 기준이다. 선택 파일 되돌리기는 부모 1의 변경 목록에서 선택한다.</p>}</div>}
    <section className="min-w-0 space-y-3"><h2 className="text-lg font-semibold">이 커밋의 변경</h2><DiffView patch={patch} mode="split"/></section>
    {revert && <RevertDialog sha={commit.sha} paths={revert.paths} open onOpenChange={open => { if (!open) setRevert(null) }}/>} 
  </div>
}

export function ComparePage() {
  const params = useSearchParams()
  const router = useRouter()
  const base = params.get("base") || ""
  const head = params.get("head") || "main"
  const path = params.get("path") || undefined
  const [draft, setDraft] = useState({ base, head, path: path || "" })
  useEffect(() => { setDraft({ base, head, path: path || "" }) }, [base, head, path])
  const history = useHistory(path)
  const commits = history.data?.pages.flatMap(page => page.commits) ?? []
  const query = useQuery({ queryKey: ["history", "compare", base, head, path], queryFn: ({ signal }) => historyApi.compare(base, head, path, signal), enabled: !!base && !!head })
  return <div className="min-w-0 space-y-6"><PageHeader title="버전 비교" description="base에서 head로 바뀐 내용을 비교한다. SHA 또는 main 등 저장소 ref를 입력할 수 있다."/>
    <form className="space-y-4 rounded-lg border p-4" onSubmit={event => { event.preventDefault(); router.push(compareHref(draft.base.trim(), draft.head.trim(), draft.path.trim() || undefined)) }}><div className="grid gap-4 sm:grid-cols-2">{(["base", "head"] as const).map(field => <div key={field} className="min-w-0 space-y-2"><label className="block space-y-1 text-sm">{field === "base" ? "이전 버전 (base)" : "이후 버전 (head)"}<Input required value={draft[field]} onChange={event => setDraft(value => ({ ...value, [field]: event.target.value }))} aria-label={`${field} 버전`}/></label><label className="block space-y-1 text-xs text-muted-foreground">이력에서 {field} 선택<select className={selectClass} value="" onChange={event => { if (event.target.value) setDraft(value => ({ ...value, [field]: event.target.value })) }} aria-label={`이력에서 ${field} 선택`}><option value="">커밋 선택…</option><option value="main">현재 main</option>{commits.map(commit => <option key={commit.sha} value={commit.sha}>{commit.sha.slice(0, 8)} · {commit.subject}{commit.path && commit.path !== path ? ` · ${commit.path}` : ""}</option>)}</select></label></div>)}</div><label className="block space-y-1 text-sm">파일 경로 (선택, 비우면 전체 저장소)<Input value={draft.path} onChange={event => setDraft(value => ({ ...value, path: event.target.value }))} aria-label="비교 파일 경로"/></label><div className="flex flex-wrap gap-2"><Button type="submit" disabled={!draft.base.trim() || !draft.head.trim()}>비교</Button><Button variant="outline" type="button" onClick={() => setDraft(value => ({ ...value, base: value.head, head: value.base }))}>이전 · 이후 바꾸기</Button><MoreHistory query={history}/></div></form>
    {history.isError && <RetryError error={history.error} retry={() => void history.refetch()}/>}
    {history.isPending && <Loading label="선택할 커밋 이력을 불러오는 중…"/>}
    {!base ? <EmptyState title="비교할 이전 버전을 선택해 주세요" description="두 커밋 또는 커밋과 main을 선택한다."/> : query.isPending ? <Loading label="버전을 비교하는 중…"/> : query.isError ? <RetryError error={query.error} retry={() => void query.refetch()}/> : query.data && <><p className="break-all font-mono text-xs text-muted-foreground">{query.data.base} → {query.data.head}{path ? ` · ${path}` : ""}</p><FileList files={query.data.files} ref={query.data.head}/><DiffView patch={query.data.patch} mode="split"/></>}
  </div>
}

export function BlamePage() {
  const params = useSearchParams()
  const path = params.get("path") || ""
  const ref = params.get("ref") || undefined
  const query = useQuery({ queryKey: ["note", path, ref], queryFn: () => api.note(path, ref), enabled: !!path })
  return <div className="min-w-0 space-y-6"><PageHeader title="줄별 작성 이력 (Blame)" description={<span className="break-all">{path}{ref ? ` · ${ref}` : " · 현재 main"}</span>} actions={path ? <Button variant="outline" nativeButton={false} render={<Link href={historyHref(path)}/>}>노트 이력</Button> : undefined}/>{!path ? <EmptyState title="노트 경로가 필요합니다" description="노트 이력에서 줄별 작성 이력을 열어 주세요."/> : query.isPending ? <Loading label="노트 내용을 불러오는 중…"/> : query.isError ? <RetryError error={query.error} retry={() => void query.refetch()}/> : <><Link className="text-sm underline" href={`${noteHref(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`}>노트 보기</Link><BlameView path={path} ref={query.data.updatedSha} content={query.data.content}/></>}</div>
}
