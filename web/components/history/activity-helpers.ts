import type { ActivityItem, BackupStatus, OpsDreamRun } from '@/lib/api'

export const activityKey = (item: ActivityItem) => `${item.type}:${item.id}`
export const activityTypeLabels = { commit: '커밋', job: '쓰기 작업', dream: 'dreaming', backup: '백업' } as const
export const activitySourceLabels: Record<string, string> = { git: 'Git', mcp: 'MCP', web: '웹', chat: '대화', dreaming: 'dreaming', import: '가져오기', revert: '되돌리기' }
export const activityStatusLabels: Record<string, string> = { queued: '대기 중', running: '처리 중', merging: '병합 중', succeeded: '완료', failed: '실패', cancelled: '취소됨', pending: '백업 대기', skipped: '로컬 전용' }
export const pushLabels: Record<OpsDreamRun['push']['status'], string> = { pending: '백업 대기', succeeded: '백업 성공', failed: '백업 실패', skipped: '로컬 전용 · 백업 건너뜀' }

export function uniqueActivity(items: ActivityItem[]): ActivityItem[] {
  const seen = new Set<string>()
  return items.filter(item => {
    const key = activityKey(item)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function relativeBackupAge(at: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60000))
  if (minutes < 1) return '방금'
  if (minutes < 60) return `${minutes}분 전`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}시간 전`
  return `${Math.floor(hours / 24)}일 전`
}

export function backupSummary(status: BackupStatus, now = Date.now()) {
  const attempt = status.lastAttempt
  const succeededAt = status.lastSuccess?.push.at ?? status.lastSuccess?.finishedAt
  return {
    label: attempt ? pushLabels[attempt.push.status] : '백업 대기',
    failed: attempt?.push.status === 'failed',
    lastSuccess: succeededAt ? `마지막 성공 ${relativeBackupAge(succeededAt, now)}` : '성공한 원격 백업 없음',
    succeededAt,
    detail: attempt?.push.reason ?? (attempt ? null : '아직 원격 백업을 시도하지 않았습니다.'),
  }
}
