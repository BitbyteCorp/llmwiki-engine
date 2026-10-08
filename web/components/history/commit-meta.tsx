"use client"

import { useState } from "react"
import type { CommitInfo } from "@/lib/api"
import { formatDate, noteHref } from "@/components/common"
import { Button } from "@/components/ui/button"

export function relativeDate(iso: string): string {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000
  if (!Number.isFinite(seconds)) return "날짜 정보 없음"
  if (Math.abs(seconds) < 60) return "방금"
  const formatter = new Intl.RelativeTimeFormat("ko-KR", { numeric: "auto" })
  for (const [unit, divisor] of [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]] as const) {
    if (Math.abs(seconds) >= divisor) return formatter.format(Math.round(seconds / divisor), unit)
  }
  return "방금"
}

export function sourceLabel(trailers: Record<string, string>): string {
  const source = trailers["Wiki-Source"]
  const labels: Record<string, string> = { web: "웹 편집", chat: "대화", mcp: "MCP", dreaming: "꿈꾸기", import: "가져오기", revert: "변경 취소" }
  const label = labels[source] || source || "Git"
  const client = trailers["Wiki-Client"]?.trim()
  return client && client.toLowerCase() !== source?.toLowerCase() && client.toLowerCase() !== label.toLowerCase() ? `${label} · ${client}` : label
}

function displayName(value: string): string {
  const name = value.replace(/<[^>]*>/g, "").trim()
  return name.replace(/([^\s@]+)@[^\s]+/g, "$1") || "이름 없는 작성자"
}

export function CommitByline({ commit }: { commit: CommitInfo }) {
  const requester = commit.trailers["Wiki-Requester"]
  const author = displayName(commit.authorName || commit.authorEmail)
  const requested = requester && requester !== commit.authorEmail && displayName(requester) !== author
  return <p className="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
    <span>{requested ? `${displayName(requester)} 요청 · 도니가 정리` : author}</span>
    <span>· {sourceLabel(commit.trailers)} ·</span>
    <time dateTime={commit.committedAt} title={formatDate(commit.committedAt)}>{relativeDate(commit.committedAt)}</time>
  </p>
}

export function CommitTechnicalDetails({ commit }: { commit: CommitInfo }) {
  const [copyStatus, setCopyStatus] = useState("")
  return <details className="min-w-0 text-xs text-muted-foreground">
    <summary className="cursor-pointer py-1.5 text-label-13 font-medium">기술 정보</summary>
    <dl className="space-y-1.5 border-y px-2 py-1.5">
      <div><dt>커밋 SHA</dt><dd className="flex flex-wrap items-center gap-2"><code className="break-all">{commit.sha}</code><Button size="xs" variant="outline" onClick={() => void navigator.clipboard.writeText(commit.sha).then(() => setCopyStatus("복사했습니다"), () => setCopyStatus("복사하지 못했습니다"))}>복사</Button><span role="status">{copyStatus}</span></dd></div>
      <div><dt>작성자</dt><dd className="break-all">{commit.authorName} &lt;{commit.authorEmail}&gt;</dd></div>
      <div><dt>커미터</dt><dd className="break-all">{commit.committerName} &lt;{commit.committerEmail}&gt;</dd></div>
      <div><dt>작성 시각</dt><dd><time dateTime={commit.date}>{formatDate(commit.date)}</time></dd></div>
      <div><dt>커밋 시각</dt><dd><time dateTime={commit.committedAt}>{formatDate(commit.committedAt)}</time></dd></div>
      <div><dt>부모 커밋</dt><dd className="break-all font-mono">{commit.parents.join(", ") || "없음 (최초 변경)"}</dd></div>
      {Object.entries(commit.trailers).map(([key, value]) => <div key={key}><dt>{key}</dt><dd className="break-all">{value}</dd></div>)}
      {commit.body && <div><dt>변경 설명 원문</dt><dd className="whitespace-pre-wrap break-words">{commit.body}</dd></div>}
    </dl>
  </details>
}

export function commitHref(sha: string): string { return `/history/commits/${encodeURIComponent(sha)}` }
export function historyHref(path: string): string { return `/history?${new URLSearchParams({ path, follow: "1" })}` }
export function compareHref(base: string, head: string, path?: string): string {
  const params = new URLSearchParams({ base, head })
  if (path) params.set("path", path)
  return `/history/compare?${params}`
}
export function versionHref(historicalPath: string, sha: string, currentPath?: string): string {
  const params = new URLSearchParams({ ref: sha })
  if (currentPath && currentPath !== historicalPath) params.set("current", currentPath)
  return `${noteHref(historicalPath)}?${params}`
}
