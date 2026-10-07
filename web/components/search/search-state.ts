import type { SearchFilters } from '@/lib/api'

export type SearchState = { q: string; filters: SearchFilters }
const FILTER_KEYS = ['folder', 'tags', 'from', 'to', 'author'] as const

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
