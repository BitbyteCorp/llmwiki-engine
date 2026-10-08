import type { EditorState } from '@codemirror/state'
import GithubSlugger from 'github-slugger'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkRehype from 'remark-rehype'
import type { Element, Nodes, Root } from 'hast'
import { remarkWikilinks } from '../../../lib/wikilinks'
import { remarkCallouts } from '../../markdown/callouts'
import type { EditorHeading } from '../markdown-editor'

// Slugging runs before KaTeX in the reader: TeX, rather than KaTeX's
// duplicated MathML/visual text, contributes to the heading ID.
const reader = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkCallouts)
  .use(remarkWikilinks)
  .use(remarkRehype)

const headingCache = new WeakMap<EditorState['doc'], EditorHeading[]>()

function headingText(node: Nodes, imageAlt: boolean): string {
  if (node.type === 'text') return node.value
  if (node.type === 'element' && node.tagName === 'img') return imageAlt ? String(node.properties.alt ?? '') : ''
  if (!('children' in node)) return ''
  let text = ''
  for (const child of node.children) text += headingText(child, imageAlt)
  return text
}

/** Reader-visible inline text, including image alternatives, without markup. */
export function renderedHeadingText(source: string): string {
  const tree = reader.runSync(reader.parse(source)) as Root
  const heading = tree.children.find((node): node is Element => node.type === 'element' && /^h[1-6]$/.test(node.tagName))
  return headingText(heading ?? tree, true).trim()
}

/** Headings and IDs from the same parsed text used by the read-only reader. */
export function editorHeadings(state: EditorState): EditorHeading[] {
  const cached = headingCache.get(state.doc)
  if (cached) return cached
  let source = state.doc.toString()
  // The reader receives Note.body, not YAML. Mask, rather than remove, the
  // initial frontmatter so AST positions still refer to editor source lines.
  if (/^(?:\uFEFF)?---\s*$/.test(state.doc.line(1).text)) {
    for (let number = 2; number <= state.doc.lines; number++) {
      const line = state.doc.line(number)
      if (!/^(?:---|\.\.\.)\s*$/.test(line.text)) continue
      source = source.slice(0, line.to).replace(/[^\r\n]/g, ' ') + source.slice(line.to)
      break
    }
  }
  const tree = reader.runSync(reader.parse(source)) as Root
  const slugger = new GithubSlugger()
  const headings: EditorHeading[] = []
  function visit(node: Nodes) {
    if (node.type === 'element' && /^h[1-6]$/.test(node.tagName)) {
      // hast-util-to-string (used by rehype-slug) visits text children only;
      // image alt belongs in the TOC label, but never in the slug input.
      const id = slugger.slug(headingText(node, false))
      headings.push({
        id,
        title: headingText(node, true).trim(),
        level: Number(node.tagName[1]),
        line: node.position?.start.line ?? 1,
      })
    }
    if ('children' in node) for (const child of node.children) visit(child)
  }
  visit(tree)
  headingCache.set(state.doc, headings)
  return headings
}
