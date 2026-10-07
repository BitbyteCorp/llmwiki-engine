'use client'

import Link from 'next/link'
import { Badge } from '@/components/ui/badge'

const labels: Record<string, string> = {
  updated: '수정', created: '생성', date: '날짜', importance: '중요도',
  type: '유형', author: '작성자', source: '출처', status: '상태',
}
const importanceLabels: Record<string, string> = { high: '높음', medium: '보통', low: '낮음' }

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
    const text = scalar(value)
    if (text === null) return []
    return [{ key, label: Object.hasOwn(labels, key) ? labels[key] : key, text: key === 'importance' && Object.hasOwn(importanceLabels, text) ? importanceLabels[text] : text }]
  })
  if (!tags.length && !fields.length) return null
  return (
    <details className="rounded-lg border px-3 py-2">
      <summary className="cursor-pointer rounded text-xs font-medium focus-visible:outline-2 focus-visible:outline-ring">노트 속성</summary>
      <div className="mt-3 space-y-3">
        {tags.length > 0 && <div className="flex flex-wrap gap-2" aria-label="태그">{tags.map(tag => <Link key={tag} href={`/tags/${encodeURIComponent(tag)}`} className="rounded focus-visible:outline-2 focus-visible:outline-ring"><Badge variant="secondary">#{tag}</Badge></Link>)}</div>}
        {fields.length > 0 && <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs">{fields.map(field => <div key={field.key} className="contents"><dt className="break-all text-muted-foreground">{field.label}</dt><dd className="break-words whitespace-pre-wrap">{field.text}</dd></div>)}</dl>}
      </div>
    </details>
  )
}
