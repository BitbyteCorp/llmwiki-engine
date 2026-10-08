import type { ActivityItem, BackupStatus, OpsDreamRun } from '@/lib/api'
import { sourceLabel } from './commit-meta'

export const activityKey = (item: ActivityItem) => `${item.type}:${item.id}`
export const activityTypeLabels = { commit: '노트 변경', job: '쓰기 작업', dream: '꿈꾸기', backup: '백업' } as const
export const activitySourceLabels: Record<string, string> = Object.fromEntries(
  ['git', 'mcp', 'web', 'chat', 'dreaming', 'import', 'revert'].map(source => [source, sourceLabel(source === 'git' ? {} : { 'Wiki-Source': source })]),
)
export const activityStatusLabels: Record<string, string> = { queued: '진행 중', running: '진행 중', merging: '진행 중', succeeded: '완료', failed: '실패', cancelled: '취소됨', pending: '백업 대기', skipped: '로컬 전용' }
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

export interface ActivityCard {
  key: string
  item: ActivityItem
  commits: ActivityItem[]
  memberKeys: string[]
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function cardTimestamp(card: ActivityCard): number {
  let latest = Date.parse(card.item.at)
  for (const commit of card.commits) latest = Math.max(latest, Date.parse(commit.at))
  return latest
}

export function activityCards(items: ActivityItem[]): ActivityCard[] {
  const unique = uniqueActivity(items)
  const jobs = new Map<string, ActivityItem>()
  const shaJobs = new Map<string, string>()
  const cards = new Map<string, ActivityCard>()

  for (const item of unique) {
    if (item.type !== 'job') continue
    jobs.set(item.id, item)
    for (const sha of item.job?.commits ?? []) {
      if (!shaJobs.has(sha)) shaJobs.set(sha, item.id)
    }
    const mergeSha = item.job?.mergeSha
    if (mergeSha && !shaJobs.has(mergeSha)) shaJobs.set(mergeSha, item.id)
  }

  for (const item of unique) {
    if (item.type === 'commit') continue
    const key = activityKey(item)
    cards.set(key, { key, item, commits: [], memberKeys: [key] })
  }

  const commits = unique.filter(item => item.type === 'commit').sort((left, right) =>
    Date.parse(right.at) - Date.parse(left.at) || compareKeys(activityKey(left), activityKey(right)),
  )
  for (const commit of commits) {
    const rawKey = activityKey(commit)
    const trailerJob = commit.commit?.trailers['Wiki-Job']
    const jobId = trailerJob || shaJobs.get(commit.commit?.sha ?? commit.id)
    const job = jobId ? jobs.get(jobId) : undefined
    if (job?.job?.status === 'succeeded') {
      const card = cards.get(activityKey(job))!
      card.commits.push(commit)
      card.memberKeys.push(rawKey)
      continue
    }

    const preferredKey = trailerJob && !job ? `job:${trailerJob}` : rawKey
    const key = cards.has(preferredKey) ? rawKey : preferredKey
    cards.set(key, { key, item: commit, commits: [commit], memberKeys: [rawKey] })
  }

  const timedCards = Array.from(cards.values(), card => {
    const mergeSha = card.item.job?.mergeSha
    if (mergeSha) {
      const primary = card.commits.findIndex(commit => (commit.commit?.sha ?? commit.id) === mergeSha)
      if (primary > 0) card.commits.unshift(...card.commits.splice(primary, 1))
    }
    return { card, at: cardTimestamp(card) }
  })
  timedCards.sort((left, right) => right.at - left.at || compareKeys(left.card.key, right.card.key))
  return timedCards.map(({ card }) => card)
}

export function groupActivityDays(cards: ActivityCard[], now = new Date()): { key: string; label: string; cards: ActivityCard[] }[] {
  const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const today = dayKey(now)
  const yesterdayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  const yesterday = dayKey(yesterdayDate)
  const weekdays = ['일', '월', '화', '수', '목', '금', '토']
  const groups = new Map<string, { key: string; label: string; cards: ActivityCard[] }>()

  for (const card of cards) {
    const date = new Date(cardTimestamp(card))
    const key = dayKey(date)
    let group = groups.get(key)
    if (!group) {
      const label = key === today ? '오늘' : key === yesterday ? '어제' : `${date.getMonth() + 1}월 ${date.getDate()}일 (${weekdays[date.getDay()]})`
      group = { key, label, cards: [] }
      groups.set(key, group)
    }
    group.cards.push(card)
  }
  return Array.from(groups.values()).sort((left, right) => compareKeys(right.key, left.key))
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
