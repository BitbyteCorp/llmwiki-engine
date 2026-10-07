"use client"

import Link from "next/link"
import { useQuery } from "@tanstack/react-query"
import { Activity, FileDown, FileInput, KeyRound, Settings, ShieldCheck, Users } from "lucide-react"
import { api, opsApi } from "@/lib/api"
import { ErrorNotice, Loading, formatDate } from "@/components/common"
import { Button } from "@/components/ui/button"

export function AdminPanel() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me })
  const status = useQuery({ queryKey: ["ops"], queryFn: ({ signal }) => opsApi.status(signal), enabled: me.data?.user.role === "admin" })
  return <div className="space-y-4 p-3">
    <h2 className="text-sm font-bold">관리</h2>
    <nav aria-label="관리 바로가기" className="space-y-1">
      <Link className="explorer-row" href="/admin?tab=overview"><Activity className="size-4 shrink-0" />운영 개요</Link>
      <Link className="explorer-row" href="/admin?tab=users"><Users className="size-4 shrink-0" />사용자 관리</Link>
      <Link className="explorer-row" href="/admin?tab=settings"><KeyRound className="size-4 shrink-0" />로그인 설정</Link>
      <Link className="explorer-row" href="/admin?tab=audit"><ShieldCheck className="size-4 shrink-0" />감사 로그</Link>
      <Link className="explorer-row" href="/admin?tab=acl"><ShieldCheck className="size-4 shrink-0" />접근 권한</Link>
      <Link className="explorer-row" href="/admin?tab=export"><FileDown className="size-4 shrink-0" />내보내기</Link>
      <Link className="explorer-row" href="/settings"><Settings className="size-4 shrink-0" />내 설정</Link>
      <Link className="explorer-row" href="/imports"><FileInput className="size-4 shrink-0" />원문 가져오기</Link>
    </nav>
    {me.isPending && <Loading label="관리 권한 확인 중…" />}
    {me.error && <ErrorNotice error={me.error} />}
    {me.data?.user.role === "admin" && <section aria-labelledby="admin-quick-status" className="space-y-3 rounded-lg border bg-card p-3">
      <div className="flex items-center justify-between gap-2"><h3 id="admin-quick-status" className="text-xs font-semibold">빠른 운영 상태</h3><Button variant="ghost" size="sm" disabled={status.isFetching} onClick={() => void status.refetch()} aria-label="빠른 운영 상태 새로고침">갱신</Button></div>
      {status.isPending && <Loading label="운영 상태 확인 중…" />}
      {status.error && <div className="space-y-2"><ErrorNotice error={status.error} /><Button size="sm" variant="outline" onClick={() => void status.refetch()}>다시 시도</Button></div>}
      {status.data && <dl className="space-y-2 text-xs">
        <div className="flex justify-between gap-2"><dt className="text-muted-foreground">작업 큐</dt><dd>대기 {status.data.queue.queued} · 실행 {status.data.queue.running}</dd></div>
        <div className="flex justify-between gap-2"><dt className="text-muted-foreground">검색 색인</dt><dd className={status.data.index.lastError ? "text-destructive" : ""}>{status.data.index.syncing ? "동기화 중" : status.data.index.lastError ? "오류" : status.data.index.indexedSha === status.data.index.headSha ? "최신" : "반영 대기"}</dd></div>
        <div className="flex justify-between gap-2"><dt className="text-muted-foreground">임베딩 대기</dt><dd>{status.data.index.pendingVectors}</dd></div>
        <div className="flex justify-between gap-2"><dt className="text-muted-foreground">dreaming</dt><dd>{status.data.dreams.running ? "실행 중" : status.data.dreams.last?.status === "failed" ? "최근 실패" : status.data.dreams.last ? "최근 완료" : "실행 기록 없음"}</dd></div>
        <div className="space-y-1"><dt className="text-muted-foreground">최근 git push 성공</dt><dd>{formatDate(status.data.backup.lastSuccess?.push.at ?? null)}</dd></div>
      </dl>}
      <p className="text-xs leading-5 text-muted-foreground">공유 실시간 이벤트로 갱신합니다. 자세한 오류와 실행 제어는 운영 개요에서 확인하세요.</p>
    </section>}
  </div>
}
