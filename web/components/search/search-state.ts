import type { SearchFilters } from '@/lib/api'

export type SearchState = { q: string; filters: SearchFilters }
export type HashtagToken = { start: number; end: number; query: string }
const FILTER_KEYS = ['folder', 'tags', 'from', 'to', 'author'] as const

export function normalizeTagName(value: string): string {
  return value.normalize('NFKC').toLowerCase().trim().replace(/^#+/, '').replace(/\s+/g, '-')
}

export function hashtagAt(text: string, caret: number): HashtagToken | null {
  let start = caret
  while (start > 0 && !/\s/.test(text[start - 1])) start--
  if (start === caret || text[start] !== '#') return null
  let end = caret
  while (end < text.length && !/\s/.test(text[end])) end++
  return { start, end, query: text.slice(start + 1, caret) }
}

export function removeHashtag(text: string, token: HashtagToken): { text: string; caret: number } {
  let start = token.start
  let end = token.end
  while (start > 0 && /\s/.test(text[start - 1])) start--
  while (end < text.length && /\s/.test(text[end])) end++
  const before = text.slice(0, start)
  const after = text.slice(end)
  const separator = before && after ? ' ' : ''
  return { text: before + separator + after, caret: before.length + separator.length }
}

export function parseSearchTags(value?: string): string[] {
  return [...new Set(value?.split(',').map(tag => tag.trim()).filter(Boolean) ?? [])]
}

export function toggleSearchTag(value: string | undefined, tag: string): string {
  const selected = parseSearchTags(value)
  const next = tag.trim()
  if (!next) return selected.join(',')
  return (selected.includes(next) ? selected.filter(item => item !== next) : [...selected, next]).join(',')
}

export function readSearchState(params: Pick<URLSearchParams, 'get'>): SearchState {
  const filters: SearchFilters = {}
  for (const key of FILTER_KEYS) {
    const value = params.get(key)?.trim()
    if (value) filters[key] = value
  }
  return { q: params.get('q') ?? '', filters }
}

export function searchParams(state: SearchState): URLSearchParams {
  const params = new URLSearchParams()
  if (state.q.trim()) params.set('q', state.q.trim())
  for (const key of FILTER_KEYS) {
    const value = state.filters[key]?.trim()
    if (value) params.set(key, value)
  }
  return params
}

export function searchHref(state: SearchState): string {
  const params = searchParams(state).toString()
  return `/search${params ? `?${params}` : ''}`
}

export function readRecentSearches(value: unknown): SearchState[] {
  if (!Array.isArray(value)) return []
  const recent: SearchState[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || typeof item.q !== 'string' || !item.q.trim()) continue
    const filters: SearchFilters = {}
    if (item.filters && typeof item.filters === 'object') {
      for (const key of FILTER_KEYS) {
        if (typeof item.filters[key] === 'string' && item.filters[key].trim()) filters[key] = item.filters[key].trim()
      }
    }
    const state = { q: item.q.trim(), filters }
    if (!recent.some(previous => searchHref(previous) === searchHref(state))) recent.push(state)
    if (recent.length === 8) break
  }
  return recent
}

export function rememberSearch(recent: SearchState[], state: SearchState): SearchState[] {
  if (!state.q.trim()) return recent
  const key = searchHref(state)
  return [{ q: state.q.trim(), filters: { ...state.filters } }, ...recent.filter(item => searchHref(item) !== key)].slice(0, 8)
}

export function treeFolders(files: string[]): string[] {
  const folders = new Set<string>()
  for (const file of files) {
    const parts = file.split('/')
    for (let length = 1; length < parts.length; length++) folders.add(parts.slice(0, length).join('/'))
  }
  return [...folders].sort((a, b) => a.localeCompare(b, 'ko'))
}

export function excerptParts(text: string, highlights: [number, number][]): { text: string; marked: boolean }[] {
  const ranges = highlights
    .map(([start, end]) => [Math.max(0, start), Math.min(text.length, end)] as [number, number])
    .filter(([start, end]) => Number.isInteger(start) && Number.isInteger(end) && end > start)
    .sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1])
    else merged.push([...range])
  }
  const parts: { text: string; marked: boolean }[] = []
  let offset = 0
  for (const [start, end] of merged) {
    if (start > offset) parts.push({ text: text.slice(offset, start), marked: false })
    parts.push({ text: text.slice(start, end), marked: true })
    offset = end
  }
  if (offset < text.length) parts.push({ text: text.slice(offset), marked: false })
  return parts
}
