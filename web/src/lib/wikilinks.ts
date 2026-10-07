import { noteHref } from '@/components/common'

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

export function markdownNoteHref(href: string, currentPath?: string): string | null {
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//')) return null
  const file = href.split(/[?#]/, 1)[0]
  let decoded: string
  try {
    decoded = decodeURIComponent(file)
  } catch {
    return null
  }
  if (!/\.md$/i.test(decoded) || /[\\\u0000-\u001f]/.test(decoded) || /^[a-z][a-z\d+.-]*:/i.test(decoded) || decoded.startsWith('//')) return null
  const segments = decoded.startsWith('/') ? [] : (currentPath?.split('/').slice(0, -1) ?? [])
  for (const segment of decoded.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (!segments.length) return null
      segments.pop()
    } else {
      if (segment === '.git') return null
      segments.push(segment)
    }
  }
  return segments.length ? noteHref(segments.join('/')) : null
}
