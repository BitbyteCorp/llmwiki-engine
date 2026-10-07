'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { Cloud, CloudOff } from 'lucide-react'
import { activityApi } from '@/lib/api'
import { formatDate } from '@/components/common'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { backupSummary } from './activity-helpers'

export function BackupBadge() {
  const backup = useQuery({ queryKey: ['backup'], queryFn: ({ signal }) => activityApi.backup(signal) })
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000)
    return () => window.clearInterval(timer)
  }, [])
  if (backup.isPending) return <p role="status" className="text-xs text-muted-foreground">백업 상태 확인 중…</p>
  if (backup.isError) return <div className="space-y-1 text-xs"><p role="alert" className="text-destructive">백업 상태를 확인할 수 없습니다. {backup.error.message}</p><Button variant="outline" size="sm" onClick={() => void backup.refetch()}>백업 다시 확인</Button></div>
  const summary = backupSummary(backup.data, now)
  const attempt = backup.data.lastAttempt
  const content = <><Badge variant={summary.failed ? 'destructive' : 'outline'} className={!summary.failed && attempt?.push.status === 'skipped' ? 'border-warning/30 bg-warning/10 text-warning' : !summary.failed && attempt?.push.status === 'succeeded' ? 'border-success/30 bg-success/10 text-success' : undefined}>{summary.failed ? <CloudOff aria-hidden="true" /> : <Cloud aria-hidden="true" />}{summary.label}</Badge><span className="text-xs tabular-nums text-muted-foreground" title={formatDate(summary.succeededAt ?? null)}>{summary.lastSuccess}</span></>
  return <div className="min-w-0 space-y-2" aria-label="원격 Git 백업 상태">
    {attempt ? <Link className="flex flex-wrap items-center gap-2 rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-ring" href={`/dreams/${encodeURIComponent(attempt.id)}`}>{content}</Link> : <div className="flex flex-wrap items-center gap-2">{content}</div>}
    {summary.detail && <p className="break-words text-xs text-muted-foreground">{summary.detail}</p>}
  </div>
}
