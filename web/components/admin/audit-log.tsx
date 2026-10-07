"use client"

import { useState, type FormEvent } from "react"
import { useInfiniteQuery } from "@tanstack/react-query"
import { RefreshCw } from "lucide-react"
import { opsApi } from "@/lib/api"
import { EmptyState, ErrorNotice, Loading, formatDate } from "@/components/common"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export function AuditLog() {
  const [actorText, setActorText] = useState("")
  const [actionText, setActionText] = useState("")
  const [filters, setFilters] = useState<{ actor?: number; action?: string }>({})
  const audit = useInfiniteQuery({
    queryKey: ["audit", filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => opsApi.audit({ ...filters, before: pageParam }, signal),
    getNextPageParam: page => page.nextCursor ?? undefined,
  })
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFilters({ ...(actorText ? { actor: Number(actorText) } : {}), ...(actionText ? { action: actionText } : {}) })
  }
  function reset() { setActorText(""); setActionText(""); setFilters({}) }
  const events = audit.data?.pages.flatMap(page => page.events) ?? []
  return <section className="space-y-3 rounded-lg border bg-card p-4" aria-labelledby="audit-heading">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="audit-heading" className="text-sm font-semibold">감사 로그</h2><p className="mt-1 text-sm text-muted-foreground">사용자·설정·운영 변경을 최신 순서로 확인합니다. 삭제된 사용자의 행위자 ID도 유지됩니다.</p></div><Button size="sm" variant="outline" disabled={audit.isFetching} onClick={() => void audit.refetch()}><RefreshCw className="size-4" />새로고침</Button></div>
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-lg border bg-card p-4 sm:flex-row sm:flex-wrap sm:items-end">
      <div className="space-y-2 sm:w-40"><Label htmlFor="audit-actor">행위자 ID</Label><Input id="audit-actor" type="number" min="1" step="1" placeholder="예: 12" value={actorText} onChange={event => setActorText(event.target.value)} /></div>
      <div className="min-w-0 flex-1 space-y-2"><Label htmlFor="audit-action">액션 (정확히 일치)</Label><Input id="audit-action" placeholder="예: job.retry" value={actionText} onChange={event => setActionText(event.target.value)} /></div>
      <div className="flex gap-3"><Button type="submit">필터 적용</Button><Button type="button" variant="outline" onClick={reset}>초기화</Button></div>
      <p className="w-full text-xs text-muted-foreground">액션은 부분 검색이 아닙니다. 대소문자와 전체 액션 이름이 정확히 일치해야 합니다.</p>
    </form>
    {(filters.actor !== undefined || filters.action !== undefined) && <p role="status" className="break-words text-xs text-muted-foreground">적용된 필터: {filters.actor !== undefined ? `행위자 #${filters.actor}` : "모든 행위자"} · {filters.action !== undefined ? `액션 ${filters.action}` : "모든 액션"}</p>}
    {audit.isPending && <Loading label="감사 로그를 불러오는 중…" />}
    {audit.error && <div className="space-y-3"><ErrorNotice error={audit.error} /><Button variant="outline" onClick={() => { if (audit.isFetchNextPageError) void audit.fetchNextPage(); else void audit.refetch() }}>감사 로그 다시 시도</Button></div>}
    {audit.data && (events.length === 0 ? <EmptyState title="감사 로그가 없습니다" description={filters.actor !== undefined || filters.action !== undefined ? "해당 필터와 일치하는 기록이 없습니다. 필터를 바꾸거나 초기화하세요." : "관리 작업이 실행되면 결과가 여기에 기록됩니다."} /> : <div className="overflow-x-auto rounded-lg border"><table className="w-full min-w-[720px] text-left text-sm"><caption className="sr-only">행위자와 액션으로 필터링된 관리자 감사 로그</caption><thead className="border-b bg-muted/30 text-xs text-muted-foreground"><tr>{["시각 / 이벤트", "행위자", "액션", "대상", "결과 / 요약"].map(label => <th scope="col" key={label} className="px-4 py-3 font-medium">{label}</th>)}</tr></thead><tbody className="divide-y">{events.map(event => <tr key={event.id} className="align-top"><td className="whitespace-nowrap px-4 py-3"><p>{formatDate(event.createdAt)}</p><p className="mt-1 text-xs text-muted-foreground">#{event.id}</p></td><td className="px-4 py-3">{event.actorId === null ? "시스템 / CLI" : `#${event.actorId}`}</td><td className="px-4 py-3"><button type="button" className="break-all text-left font-mono text-xs underline underline-offset-4 focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`액션 ${event.action}으로 필터링`} onClick={() => { setActionText(event.action); setFilters(current => ({ ...current, action: event.action })) }}>{event.action}</button></td><td className="max-w-64 break-words px-4 py-3 font-mono text-xs">{event.target}</td><td className="max-w-80 px-4 py-3"><span className={event.outcome === "failed" || event.outcome === "error" ? "text-destructive" : "text-foreground"}>{event.outcome}</span>{event.summary && <p className="mt-1 whitespace-pre-wrap break-words text-xs text-muted-foreground">{event.summary}</p>}</td></tr>)}</tbody></table></div>)}
    {audit.hasNextPage && <Button variant="outline" className="w-full" disabled={audit.isFetching} onClick={() => void audit.fetchNextPage()}>{audit.isFetchingNextPage ? "불러오는 중…" : "이전 감사 기록 더 보기"}</Button>}
    {audit.data && events.length > 0 && !audit.hasNextPage && <p role="status" className="text-center text-xs text-muted-foreground">마지막 감사 기록입니다.</p>}
  </section>
}
