"use client"

import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import Link from "next/link"
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation"
import { api, type CommitInfo, type WriteJob } from "@/lib/api"
import { EmptyState, ErrorNotice, Loading, PageHeader, formatDate, noteHref } from "@/components/common"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

const statusLabels: Record<WriteJob["status"], string> = {
  queued: "대기 중",
  running: "처리 중",
  merging: "병합 중",
  succeeded: "완료",
  failed: "실패",
}

function JobStatus({ status }: { status: WriteJob["status"] }) {
  return (
    <Badge variant="outline" className={status === "failed" ? "border-red-200 bg-red-50 text-red-700" : status === "succeeded" ? "border-green-200 bg-green-50 text-green-700" : "text-muted-foreground"}>
      {statusLabels[status]}
    </Badge>
  )
}

function CommitList({ commits }: { commits: CommitInfo[] }) {
  return (
    <ul className="divide-y rounded-lg border">
      {commits.map((commit) => (
        <li key={commit.sha} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <Link href={`/history/commits/${encodeURIComponent(commit.sha)}`} className="font-medium hover:underline">{commit.subject || "제목 없는 커밋"}</Link>
            <p className="text-sm text-muted-foreground">요청자 · 작성자 {commit.authorName} &lt;{commit.authorEmail}&gt;</p>
          </div>
          <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
            <Link href={`/history/commits/${encodeURIComponent(commit.sha)}`} className="font-mono hover:underline">{commit.sha.slice(0, 8)}</Link>
            <time dateTime={commit.date}>{formatDate(commit.date)}</time>
          </div>
        </li>
      ))}
    </ul>
  )
}

export function HistoryPage() {
  const params = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()
  const path = params.get("path") || undefined
  const mine = params.get("mine") === "1"
  const history = useInfiniteQuery({
    queryKey: ["history", path],
    queryFn: ({ pageParam }) => api.history(path, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.commits.length === 30 ? lastPage.commits.at(-1)?.sha : undefined,
  })
  const jobs = useInfiniteQuery({
    queryKey: ["jobs", mine],
    queryFn: ({ pageParam }) => api.jobs(mine, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.jobs.length === 30 ? lastPage.jobs.at(-1)?.createdAt : undefined,
  })
  const commits = history.data?.pages.flatMap((page) => page.commits) ?? []
  const writeJobs = jobs.data?.pages.flatMap((page) => page.jobs) ?? []

  return (
    <div className="space-y-6">
      <PageHeader title="변경 이력" description={path ? `${path} 노트의 커밋과 쓰기 작업을 확인합니다.` : "지식 저장소의 커밋과 쓰기 작업을 확인합니다."} actions={path ? <Button variant="outline" nativeButton={false} render={<Link href="/history" />}>전체 이력</Button> : undefined} />
      <section className="space-y-4" aria-labelledby="commit-history-title">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="commit-history-title" className="text-lg font-semibold">{path ? "노트 변경 이력" : "전체 변경 이력"}</h2>
          {path && <Link href={noteHref(path)} className="text-sm text-muted-foreground hover:underline">노트 보기</Link>}
        </div>
        {history.isPending && <Loading label="변경 이력을 불러오는 중…" />}
        {history.error && <ErrorNotice error={history.error} />}
        {!history.isPending && !history.error && commits.length === 0 && <EmptyState title="변경 이력이 없습니다" description="이 노트 또는 저장소에 기록된 커밋이 없습니다." />}
        {commits.length > 0 && <CommitList commits={commits} />}
        {history.hasNextPage && <Button variant="outline" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>{history.isFetchingNextPage ? "불러오는 중…" : "이전 커밋 더 보기"}</Button>}
      </section>
      <section className="space-y-4" aria-labelledby="write-jobs-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="write-jobs-title" className="text-lg font-semibold">쓰기 작업</h2>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={mine} onChange={(event) => {
              const next = new URLSearchParams(params.toString())
              if (event.target.checked) next.set("mine", "1")
              else next.delete("mine")
              const query = next.toString()
              router.push(query ? `${pathname}?${query}` : pathname)
            }} />
            내 작업만 보기
          </label>
        </div>
        {path && <p className="text-sm text-muted-foreground">쓰기 작업 목록은 노트 필터와 관계없이 표시됩니다.</p>}
        {jobs.isPending && <Loading label="쓰기 작업을 불러오는 중…" />}
        {jobs.error && <ErrorNotice error={jobs.error} />}
        {!jobs.isPending && !jobs.error && writeJobs.length === 0 && <EmptyState title="쓰기 작업이 없습니다" description={mine ? "아직 요청한 쓰기 작업이 없습니다." : "아직 기록된 쓰기 작업이 없습니다."} />}
        {writeJobs.length > 0 && (
          <ul className="divide-y rounded-lg border">
            {writeJobs.map((job) => (
              <li key={job.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:justify-between">
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2"><JobStatus status={job.status} /><Link href={`/jobs/${encodeURIComponent(job.id)}`} className="font-mono text-xs hover:underline">{job.id}</Link></div>
                  <Link href={`/jobs/${encodeURIComponent(job.id)}`} className="block line-clamp-2 text-sm hover:underline">{job.summary || job.input}</Link>
                  <p className="text-xs text-muted-foreground">요청자 {job.user.name ? `${job.user.name} · ` : ""}{job.user.email} · {job.source === "dreaming" ? "dreaming" : "MCP"}</p>
                </div>
                <time className="shrink-0 text-xs text-muted-foreground" dateTime={job.createdAt}>{formatDate(job.createdAt)}</time>
              </li>
            ))}
          </ul>
        )}
        {jobs.hasNextPage && <Button variant="outline" disabled={jobs.isFetchingNextPage} onClick={() => void jobs.fetchNextPage()}>{jobs.isFetchingNextPage ? "불러오는 중…" : "이전 작업 더 보기"}</Button>}
      </section>
    </div>
  )
}

function patchLineClass(line: string) {
  if (line.startsWith("@@")) return "bg-blue-50 text-blue-800"
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("\\ No newline")) return "bg-muted/40 text-muted-foreground"
  if (line.startsWith("+")) return "bg-green-50 text-green-800"
  if (line.startsWith("-")) return "bg-red-50 text-red-800"
  return "text-muted-foreground"
}

export function CommitPage() {
  const { sha: encodedSha } = useParams<{ sha: string }>()
  const sha = encodedSha === undefined ? undefined : decodeURIComponent(encodedSha)
  const query = useQuery({ queryKey: ["commit", sha], queryFn: () => api.commit(sha!), enabled: !!sha })
  if (!sha) return <EmptyState title="커밋을 선택해 주세요" />
  if (query.isPending) return <Loading label="커밋을 불러오는 중…" />
  if (query.isError) return <ErrorNotice error={query.error} />
  const { commit, files, patch, job } = query.data

  return (
    <div className="space-y-6">
      <PageHeader title={commit.subject || "커밋 상세"} description={commit.sha} actions={<Button variant="outline" nativeButton={false} render={<Link href="/history" />}>변경 이력</Button>} />
      <dl className="grid gap-4 rounded-lg border p-4 text-sm sm:grid-cols-2">
        <div><dt className="text-muted-foreground">요청자 · 작성자</dt><dd className="mt-1 break-words">{commit.authorName} &lt;{commit.authorEmail}&gt;</dd></div>
        <div><dt className="text-muted-foreground">커밋 시각</dt><dd className="mt-1">{formatDate(commit.date)}</dd></div>
        <div><dt className="text-muted-foreground">연결된 쓰기 작업</dt><dd className="mt-1">{job ? <Link href={`/jobs/${encodeURIComponent(job.id)}`} className="break-all underline underline-offset-4">{job.id}</Link> : "연결된 작업 없음"}</dd></div>
        {job && <div><dt className="text-muted-foreground">작업 상태</dt><dd className="mt-1"><JobStatus status={job.status} /></dd></div>}
      </dl>
      {commit.body && <section className="space-y-3"><h2 className="text-lg font-semibold">커밋 본문</h2><p className="whitespace-pre-wrap break-words text-sm leading-6">{commit.body}</p></section>}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">변경 파일 <span className="text-muted-foreground">{files.length}</span></h2>
        {files.length === 0 ? <EmptyState title="변경된 파일이 없습니다" /> : <ul className="divide-y rounded-lg border">{files.map((file, index) => <li key={`${file.path}-${index}`} className="flex items-start gap-3 p-3 text-sm"><Badge variant="outline">{{ A: "추가", M: "수정", D: "삭제", R: "이동" }[file.status]}</Badge><div className="min-w-0 break-all">{file.oldPath && <span className="text-muted-foreground">{file.oldPath} → </span>}{file.status === "D" ? <span>{file.path}</span> : <Link href={noteHref(file.path)} className="hover:underline">{file.path}</Link>}</div></li>)}</ul>}
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">변경 내용</h2>
        {patch ? <pre aria-label="커밋 변경 내용" className="overflow-x-auto rounded-lg border py-3 text-xs leading-6"><code>{patch.split("\n").map((line, index) => <span key={index} className={`block min-w-max px-4 ${patchLineClass(line)}`}>{line || " "}</span>)}</code></pre> : <EmptyState title="표시할 diff가 없습니다" />}
      </section>
    </div>
  )
}

export function JobPage() {
  const { id: encodedId } = useParams<{ id: string }>()
  const id = encodedId === undefined ? undefined : decodeURIComponent(encodedId)
  const query = useQuery({
    queryKey: ["job", id],
    queryFn: () => api.job(id!),
    enabled: !!id,
    refetchInterval: (query) => {
      const status = query.state.data?.job.status
      return status === "queued" || status === "running" || status === "merging" ? 3000 : false
    },
  })
  if (!id) return <EmptyState title="쓰기 작업을 선택해 주세요" />
  if (query.isPending) return <Loading label="쓰기 작업을 불러오는 중…" />
  if (query.isError) return <ErrorNotice error={query.error} />
  const { job, user, commits } = query.data
  const commitShas = [...new Set([...job.commits, ...(job.mergeSha ? [job.mergeSha] : [])])]

  return (
    <div className="space-y-6">
      <PageHeader title="쓰기 작업" description={job.id} actions={<Button variant="outline" nativeButton={false} render={<Link href="/history" />}>변경 이력</Button>} />
      <dl className="grid gap-4 rounded-lg border p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <div><dt className="text-muted-foreground">상태</dt><dd className="mt-1"><JobStatus status={job.status} /></dd></div>
        <div><dt className="text-muted-foreground">요청자</dt><dd className="mt-1 break-words">{user.name ? `${user.name} · ` : ""}{user.email}</dd></div>
        <div><dt className="text-muted-foreground">요청 경로</dt><dd className="mt-1">{job.source === "dreaming" ? "dreaming" : "MCP"}</dd></div>
        <div><dt className="text-muted-foreground">요청 시각</dt><dd className="mt-1">{formatDate(job.createdAt)}</dd></div>
        <div><dt className="text-muted-foreground">시작 시각</dt><dd className="mt-1">{formatDate(job.startedAt)}</dd></div>
        <div><dt className="text-muted-foreground">완료 시각</dt><dd className="mt-1">{formatDate(job.finishedAt)}</dd></div>
      </dl>
      {job.error && <section role="alert" className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-4 text-red-800"><h2 className="font-semibold">작업 오류</h2><p className="whitespace-pre-wrap break-words text-sm leading-6">{job.error}</p></section>}
      <section className="space-y-3"><h2 className="text-lg font-semibold">요청 내용</h2><p className="whitespace-pre-wrap break-words rounded-lg border p-4 text-sm leading-6">{job.input}</p></section>
      <section className="space-y-3"><h2 className="text-lg font-semibold">처리 요약</h2>{job.summary ? <p className="whitespace-pre-wrap break-words text-sm leading-6">{job.summary}</p> : <p className="text-sm text-muted-foreground">아직 처리 요약이 없습니다.</p>}</section>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">관련 커밋</h2>
        {commitShas.length === 0 ? <EmptyState title="아직 연결된 커밋이 없습니다" /> : <ul className="divide-y rounded-lg border">{commitShas.map((sha) => {
          const commit = commits.find((item) => item.sha === sha)
          return <li key={sha} className="p-4"><Link href={`/history/commits/${encodeURIComponent(sha)}`} className="text-sm hover:underline">{commit?.subject || sha}</Link><div className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground"><span className="font-mono">{sha.slice(0, 8)}</span>{sha === job.mergeSha && <span>최종 반영 커밋</span>}{commit && <span>{formatDate(commit.date)}</span>}</div></li>
        })}</ul>}
      </section>
    </div>
  )
}
