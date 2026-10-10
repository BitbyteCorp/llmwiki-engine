'use client'

import Link from 'next/link'
import { Badge } from '@/components/ui/badge'

const labels: Record<string, string> = {
  updated: '수정', created: '생성', date: '날짜', importance: '중요도',
  type: '유형', author: '작성자', source: '출처', status: '상태',
  'date created': '생성', 'date modified': '수정', aliases: '별칭',
  description: '설명', related: '관련', confidence: '신뢰도',
}
const importanceLabels: Record<string, string> = { high: '높음', medium: '보통', low: '낮음' }
const typeLabels: Record<string, string> = {
  hub: '허브', concept: '개념', entity: '엔티티', guide: '가이드',
  decision: '결정', reference: '참고', project: '프로젝트', note: '노트',
}

function scalar(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? '예' : '아니요'
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10)
  return null
}

export function Properties({ frontmatter }: { frontmatter: Record<string, unknown> }) {
  const rawTags = Array.isArray(frontmatter.tags)
    ? frontmatter.tags.filter((tag): tag is string => typeof tag === 'string')
    : typeof frontmatter.tags === 'string' ? frontmatter.tags.split(/[,\s]+/) : []
  const tags = [...new Set(rawTags.map(tag => tag.trim().replace(/^#+/, '')).filter(Boolean))]
  const fields = Object.entries(frontmatter).flatMap(([key, value]) => {
    if (key === 'title' || key === 'tags') return []
    const text = (key === 'aliases' || key === 'related') && Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean).join(', ') || null
      : scalar(value)
    if (text === null) return []
    const valueLabels = key === 'importance' || key === 'confidence' ? importanceLabels : key === 'type' ? typeLabels : null
    return [{ key, label: Object.hasOwn(labels, key) ? labels[key] : key, text: valueLabels && Object.hasOwn(valueLabels, text) ? valueLabels[text] : text }]
  })
  if (!tags.length && !fields.length) return null
  return (
    <details className="space-y-2">
      <summary className="flex h-7 cursor-pointer items-center gap-1.5 border-b text-label-13 font-semibold focus-visible:outline-2 focus-visible:outline-ring">노트 속성</summary>
      <div className="space-y-2">
        {tags.length > 0 && <div className="flex flex-wrap gap-2" aria-label="태그">{tags.map(tag => <Link key={tag} href={`/tags/${encodeURIComponent(tag)}`} className="rounded focus-visible:outline-2 focus-visible:outline-ring"><Badge variant="secondary">#{tag}</Badge></Link>)}</div>}
        {fields.length > 0 && <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-label-13">{fields.map(field => <div key={field.key} className="contents"><dt className="break-all text-muted-foreground">{field.label}</dt><dd className="break-words whitespace-pre-wrap">{field.text}</dd></div>)}</dl>}
      </div>
    </details>
  )
}
