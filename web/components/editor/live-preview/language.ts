import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import type { EditorState } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import { tags } from '@lezer/highlight'
import type { InlineContext, Line, MarkdownConfig } from '@lezer/markdown'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

const inlineReader = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
const wikiPattern = /\[\[([^\[\]\n|]+)(?:\|([^\[\]\n]+))?\]\]/g
const wikiNodes = new WeakMap<InlineContext, Map<number, { end: number; openEnd: number; closeStart: number }>>()

interface ReaderNode {
  type: string
  value?: string
  children?: ReaderNode[]
  position?: { start: { offset?: number }; end: { offset?: number } }
}

function mathFence(line: Line): number {
  if (line.indent - line.baseIndent >= 4 || line.next !== 36) return -1
  let end = line.pos
  while (line.text.charCodeAt(end) === 36) end++
  return end - line.pos >= 2 && !line.text.slice(end).includes('$') ? end : -1
}

const wikiLinks: MarkdownConfig = {
  defineNodes: [{ name: 'WikiLink', style: tags.link }, { name: 'WikiLinkMark', style: tags.processingInstruction }],
  parseInline: [{
    name: 'WikiLink', before: 'Escape',
    parse(cx, next, pos) {
      if (next !== 91 && next !== 92 && next !== 38) return -1
      let nodes = wikiNodes.get(cx)
      if (!nodes) {
        const found = new Map<number, { end: number; openEnd: number; closeStart: number }>()
        // Like remarkWikilinks, only transform parsed text, including decoded
        // escapes/entities. Mapping decoded boundaries back to source keeps
        // syntax marks and cursor positions correct for escaped brackets.
        const parsed = inlineReader.parse(cx.slice(cx.offset, cx.end))
        const collect = (node: ReaderNode) => {
          if (['code', 'inlineCode', 'link', 'linkReference', 'html'].includes(node.type)) return
          if (node.type === 'text' && node.value && node.position) {
            const from = cx.offset + (node.position.start.offset ?? 0)
            const to = cx.offset + (node.position.end.offset ?? 0)
            const source = cx.slice(from, to)
            const boundaries = [from]
            let decoded = ''
            const tokens = /\\[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]|&(?:#\d+|#x[a-f\d]+|[a-z][a-z\d]*);|[\s\S]/gi
            for (const token of source.matchAll(tokens)) {
              const raw = token[0]
              let value = raw
              if (raw.startsWith('\\') && raw.length > 1) value = raw.slice(1)
              else if (raw.startsWith('&') && raw.length > 1) {
                const paragraph = inlineReader.parse(`x${raw}x`).children[0]
                if (paragraph?.type === 'paragraph' && paragraph.children[0]?.type === 'text') value = paragraph.children[0].value.slice(1, -1)
              }
              decoded += value
              for (let i = 0; i < value.length; i++) boundaries.push(from + token.index + raw.length)
            }
            if (decoded === node.value) for (const match of decoded.matchAll(wikiPattern)) {
              if (!match[1].trim()) continue
              const start = match.index
              const end = start + match[0].length
              found.set(boundaries[start], {
                end: boundaries[end],
                openEnd: boundaries[start + 2],
                closeStart: boundaries[end - 2],
              })
            }
          }
          if (node.children) for (const child of node.children) collect(child)
        }
        collect(parsed)
        wikiNodes.set(cx, found)
        nodes = found
      }
      const match = nodes.get(pos)
      if (!match) return -1
      return cx.addElement(cx.elt('WikiLink', pos, match.end, [
        cx.elt('WikiLinkMark', pos, match.openEnd),
        cx.elt('WikiLinkMark', match.closeStart, match.end),
      ]))
    },
  }],
}

const math: MarkdownConfig = {
  defineNodes: [
    { name: 'InlineMath', style: tags.special(tags.string) },
    { name: 'BlockMath', block: true, style: tags.special(tags.string) },
    { name: 'MathMark', style: tags.processingInstruction },
    { name: 'MathInfo', style: tags.meta },
    'MathText',
  ],
  parseInline: [{
    name: 'InlineMath', after: 'InlineCode',
    parse(cx, next, pos) {
      if (next !== 36) return -1
      // remark-math accepts every dollar run, including single-dollar math.
      // A run cannot start in the middle of another, except after an escape.
      if (cx.char(pos - 1) === 36) {
        let backslashes = 0
        for (let at = pos - 2; cx.char(at) === 92; at--) backslashes++
        if (backslashes % 2 === 0) return -1
      }
      let openEnd = pos + 1
      while (cx.char(openEnd) === 36) openEnd++
      const size = openEnd - pos
      for (let at = openEnd; at < cx.end;) {
        if (cx.char(at) !== 36) { at++; continue }
        let end = at + 1
        while (cx.char(end) === 36) end++
        if (end - at === size) return cx.addElement(cx.elt('InlineMath', pos, end, [
          cx.elt('MathMark', pos, openEnd),
          cx.elt('MathText', openEnd, at),
          cx.elt('MathMark', at, end),
        ]))
        at = end
      }
      return -1
    },
  }],
  parseBlock: [{
    name: 'BlockMath', after: 'FencedCode',
    endLeaf(_cx, line) { return mathFence(line) >= 0 },
    parse(cx, line) {
      const fenceEnd = mathFence(line)
      if (fenceEnd < 0) return false
      const from = cx.lineStart + line.pos
      const size = fenceEnd - line.pos
      const parentDepth = cx.depth
      const children = [cx.elt('MathMark', from, from + size)]
      const infoFrom = line.skipSpace(fenceEnd)
      if (infoFrom < line.text.length) children.push(cx.elt('MathInfo', cx.lineStart + infoFrom, cx.lineStart + line.text.length))
      let to = cx.lineStart + line.text.length
      while (cx.nextLine()) {
        // Lezer's eager leaf parsers use this continuation depth too; the
        // installed Line type omits it from its public declaration.
        if ((line as Line & { depth: number }).depth < parentDepth) break
        const marker = mathFence(line)
        if (marker >= 0 && marker - line.pos >= size && line.skipSpace(marker) === line.text.length) {
          children.push(...line.markers, cx.elt('MathMark', cx.lineStart + line.pos, cx.lineStart + marker))
          to = cx.lineStart + line.text.length
          cx.nextLine()
          break
        }
        children.push(...line.markers)
        const textFrom = cx.lineStart + line.basePos
        to = cx.lineStart + line.text.length
        if (textFrom < to) children.push(cx.elt('MathText', textFrom, to))
      }
      cx.addElement(cx.elt('BlockMath', from, to, children))
      return true
    },
  }],
}

export const liveMarkdown = markdown({
  base: markdownLanguage,
  codeLanguages: languages,
  extensions: [wikiLinks, math],
})

/** Decode a complete InlineMath node using remark-math's padding rules. */
export function inlineMathText(source: string): string {
  const size = source.match(/^\$+/)?.[0].length ?? 0
  let text = source.slice(size, source.length - size).replace(/\r\n|\r|\n/g, ' ')
  if (text.startsWith(' ') && text.endsWith(' ') && /[^ ]/.test(text)) text = text.slice(1, -1)
  return text
}

function contentIndent(prefix: string): number {
  // The prefix ends at a structural content boundary, so these markers belong
  // to surrounding containers, never to the literal fenced/math content.
  let marker: RegExpExecArray | null
  while ((marker = /^[ \t]*(?:>[ \t]?|(?:[-+*]|\d+[.)])[ \t]+)/.exec(prefix))) prefix = prefix.slice(marker[0].length)
  let column = 0
  for (const character of prefix) column += character === '\t' ? 4 - column % 4 : 1
  return column
}

/**
 * Render a leaf block without its surrounding quote/list prefixes. Structural
 * child ranges retain content indentation; source line gaps retain blank
 * lines. The editor document and all syntax positions remain untouched.
 */
export function normalizedBlockSource(state: EditorState, node: SyntaxNode): string {
  if (node.name !== 'FencedCode' && node.name !== 'BlockMath' && node.name !== 'Table') return state.sliceDoc(node.from, node.to)
  const starts = new Map<number, number>()
  let contentStart: number | undefined
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === 'QuoteMark' || child.to <= child.from) continue
    if (contentStart === undefined && (child.name === 'CodeText' || child.name === 'MathText')) {
      let from = child.from
      while (from < child.to && state.sliceDoc(from, from + 1) === '\n') from++
      if (from < child.to) contentStart = from
    }
    const firstLine = state.doc.lineAt(child.from).number
    const lastLine = state.doc.lineAt(child.to - 1).number
    for (let number = firstLine; number <= lastLine; number++) {
      const from = Math.max(child.from, state.doc.line(number).from)
      const existing = starts.get(number)
      if (existing === undefined || from < existing) starts.set(number, from)
    }
  }
  const lines: string[] = []
  const firstLine = state.doc.lineAt(node.from).number
  const lastLine = state.doc.lineAt(node.to).number
  for (let number = firstLine; number <= lastLine; number++) {
    const from = starts.get(number)
    lines.push(from === undefined ? '' : state.sliceDoc(from, Math.min(state.doc.line(number).to, node.to)))
  }
  if (contentStart !== undefined) {
    const openingLine = state.doc.lineAt(node.from)
    const contentLine = state.doc.lineAt(contentStart)
    const openingIndent = contentIndent(state.sliceDoc(openingLine.from, node.from))
    const containerIndent = contentIndent(state.sliceDoc(contentLine.from, contentStart))
    // The reader deducts the opening fence's own indent from its body.
    // Retaining it on the normalized opener preserves that exact behavior.
    lines[0] = ' '.repeat(Math.max(0, openingIndent - containerIndent)) + lines[0]
  }
  return lines.join('\n')
}
