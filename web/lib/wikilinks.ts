import { slug } from 'github-slugger'

export const WIKILINK_PREFIX = '#llmwiki-note='

interface MarkdownNode {
  type: string
  value?: string
  url?: string
  children?: MarkdownNode[]
}

// Transform parsed text, never the raw source: fenced and inline code stay literal.
export function remarkWikilinks() {
  return (tree: MarkdownNode) => {
    function visit(node: MarkdownNode) {
      if (['code', 'inlineCode', 'link', 'linkReference', 'html'].includes(node.type) || !node.children) return
      const children: MarkdownNode[] = []
      for (const child of node.children) {
        if (child.type !== 'text' || !child.value) {
          visit(child)
          children.push(child)
          continue
        }
        const pattern = /\[\[([^\[\]\n|]+)(?:\|([^\[\]\n]+))?\]\]/g
        let offset = 0
        for (const match of child.value.matchAll(pattern)) {
          const name = match[1].trim()
          if (!name) continue
          const start = match.index
          if (start > offset) children.push({ type: 'text', value: child.value.slice(offset, start) })
          children.push({
            type: 'link',
            url: WIKILINK_PREFIX + encodeURIComponent(name),
            children: [{ type: 'text', value: match[2]?.trim() || name }],
          })
          offset = start + match[0].length
        }
        if (offset < child.value.length) children.push({ type: 'text', value: child.value.slice(offset) })
      }
      node.children = children
    }
    visit(tree)
  }
}

export interface NoteTarget { path: string; fragment?: string }

export function headingFragment(value: string): string {
  try { return slug(decodeURIComponent(value)) } catch { return slug(value) }
}

function normalizePath(value: string, base: string[]): string | null {
  if (/[\\\u0000-\u001f]/.test(value) || /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith('//')) return null
  const segments = [...base]
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (!segments.length) return null
      segments.pop()
    } else {
      if (segment.toLowerCase() === '.git') return null
      segments.push(segment)
    }
  }
  return segments.length ? segments.join('/') : null
}

export function wikiTarget(name: string, currentPath?: string): { name: string; fragment?: string; local: boolean } | null {
  const separator = name.indexOf('#')
  const file = (separator < 0 ? name : name.slice(0, separator)).trim()
  const fragment = separator < 0 ? undefined : headingFragment(name.slice(separator + 1).trim())
  if (!file) return currentPath ? { name: currentPath, fragment, local: true } : null
  const relative = /^\.{1,2}\//.test(file)
  const normalized = normalizePath(file, relative ? (currentPath?.split('/').slice(0, -1) ?? []) : [])
  return normalized ? { name: normalized, fragment, local: false } : null
}

export function markdownNoteTarget(href: string, currentPath?: string): NoteTarget | null {
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) return null
  const file = href.split(/[?#]/, 1)[0]
  let decoded: string
  try { decoded = decodeURIComponent(file) } catch { return null }
  if (!/\.md$/i.test(decoded)) return null
  const path = normalizePath(decoded, decoded.startsWith('/') ? [] : (currentPath?.split('/').slice(0, -1) ?? []))
  const hash = href.indexOf('#')
  return path ? { path, fragment: hash < 0 ? undefined : headingFragment(href.slice(hash + 1)) } : null
}
