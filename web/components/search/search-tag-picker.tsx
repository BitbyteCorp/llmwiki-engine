'use client'

import { useMemo, useRef, useState } from 'react'
import { Check } from 'lucide-react'
import { ErrorNotice, Loading } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { normalizeTagName } from './search-state'

const INITIAL_TAG_LIMIT = 30

export function SearchTagPicker({ id, tags, selectedTags, pending, error, onRetry, onToggle }: {
  id: string
  tags: { tag: string; count: number }[]
  selectedTags: string[]
  pending: boolean
  error: unknown
  onRetry(): void
  onToggle(tag: string): void
}) {
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState(false)
  const composing = useRef(false)
  const normalizedFilter = normalizeTagName(filter)
  const items = useMemo(() => {
    const indexed = new Set(tags.map(item => item.tag))
    return [...tags, ...selectedTags.filter(tag => !indexed.has(tag)).map(tag => ({ tag, count: null }))]
      .sort((a, b) => Number(selectedTags.includes(b.tag)) - Number(selectedTags.includes(a.tag))
        || (b.count ?? 0) - (a.count ?? 0) || a.tag.localeCompare(b.tag, 'ko'))
  }, [tags, selectedTags])
  const matches = items.filter(item => item.tag.includes(normalizedFilter))
  const visible = normalizedFilter || expanded ? matches : matches.slice(0, INITIAL_TAG_LIMIT)

  return <>
    <div className="space-y-1.5">
      <Label htmlFor={`${id}-tag-search`}>태그 이름 검색</Label>
      <Input id={`${id}-tag-search`} type="search" autoComplete="off" value={filter}
        placeholder="태그 이름으로 찾기" onChange={event => setFilter(event.target.value)}
        onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
        onKeyDown={event => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          event.stopPropagation()
          if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
          const first = matches.find(item => !selectedTags.includes(item.tag))
          if (first) { onToggle(first.tag); setFilter('') }
        }} />
    </div>
    {pending && <Loading label="태그를 불러오는 중" />}
    {Boolean(error) && <><ErrorNotice error={error} /><Button type="button" variant="outline" size="sm" onClick={onRetry}>태그 다시 불러오기</Button></>}
    {!pending && !error && !items.length && <p className="text-xs text-muted-foreground">색인된 태그가 없습니다.</p>}
    {!pending && !error && items.length > 0 && !matches.length && <p className="text-xs text-muted-foreground">일치하는 태그가 없습니다.</p>}
    <div className="flex flex-wrap gap-2">
      {visible.map(item => {
        const selected = selectedTags.includes(item.tag)
        return <Button key={item.tag} type="button" variant={selected ? 'default' : 'outline'} size="sm"
          aria-pressed={selected} aria-label={`태그 #${item.tag} ${selected ? '선택 해제' : '선택'}`}
          className="h-auto min-h-8 max-w-full whitespace-normal text-left" onClick={() => onToggle(item.tag)}>
          {selected && <Check aria-hidden="true" className="size-3.5" />}
          <span className="min-w-0 break-all">#{item.tag}</span>
          <span className={`shrink-0 text-xs ${selected ? 'text-primary-foreground/80' : 'text-muted-foreground'}`}>{item.count === null ? '미색인' : `${item.count}개`}</span>
        </Button>
      })}
    </div>
    {!normalizedFilter && items.length > INITIAL_TAG_LIMIT && <Button type="button" variant="ghost" size="sm"
      aria-expanded={expanded} onClick={() => setExpanded(previous => !previous)}>{expanded ? '접기' : `모두 보기 (${items.length}개)`}</Button>}
  </>
}
