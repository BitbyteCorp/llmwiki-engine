'use client'

import { useId, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import { api } from '@/lib/api'
import { noteHref } from '@/components/common'
import { headingFragment, markdownNoteTarget, remarkWikilinks, wikiTarget, WIKILINK_PREFIX } from '@/lib/wikilinks'
import type { EditorLinkTarget } from '../markdown-editor'
import styles from '../../markdown/markdown.module.css'

type ParsedLink = {
  label: string
  labelSource?: string
  title?: string
  target: EditorLinkTarget | null
  name?: string
  fragment?: string
}

const linkReader = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkWikilinks)

type LabelNode = { type: string; value?: string; children?: LabelNode[] }
type LinkAstNode = {
  type: string; value?: string; url?: string; title?: string | null; children?: LinkAstNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

function labelText(node: LabelNode): string {
  if (node.value !== undefined) return node.value
  let text = ''
  for (const child of node.children ?? []) text += labelText(child)
  return text
}

export function parsedLink(source: string, wiki: boolean, path: string): ParsedLink {
  const tree = linkReader.runSync(linkReader.parse(source)) as { type: string; children: LinkAstNode[] }
  const paragraph = tree.children[0]
  if (tree.children.length !== 1 || paragraph?.type !== 'paragraph'
    || paragraph.position?.start.offset !== 0 || paragraph.position?.end.offset !== source.length
    || paragraph.children?.length !== 1 || paragraph.children[0].type !== 'link'
    || typeof paragraph.children[0].url !== 'string') return { label: source, target: null }
  const link = paragraph.children[0]
  const href = link.url!
  const label = labelText(link)
  if (wiki) {
    if (!href.startsWith(WIKILINK_PREFIX)) return { label: source, target: null }
    const name = decodeURIComponent(href.slice(WIKILINK_PREFIX.length))
    const target = wikiTarget(name, path)
    if (!target) return { label, target: null }
    return target.local
      ? { label, target: { kind: 'fragment', id: target.fragment ?? '' } }
      : { label, target: null, name: target.name, fragment: target.fragment }
  }
  if (href.startsWith(WIKILINK_PREFIX) || link.position?.start.offset !== 0
    || link.position?.end.offset !== source.length || !source.startsWith('[')) return { label: source, target: null }
  // Preserve label escapes for inline rendering; the mdast URL/title already
  // follow CommonMark entity, escape, delimiter, and optional-title semantics.
  let index = 1
  let depth = 1
  for (; index < source.length; index++) {
    if (source[index] === '\\') { index++; continue }
    if (source[index] === '[') depth++
    if (source[index] === ']' && --depth === 0) break
  }
  const text = { label, labelSource: source.slice(1, index), title: link.title ?? undefined }
  if (/[\u0000-\u001f\u007f]/.test(href)) return { ...text, target: null }
  const note = markdownNoteTarget(href, path)
  if (note) return { ...text, target: { kind: 'note', ...note } }
  if (href.startsWith('#')) return { ...text, target: { kind: 'fragment', id: headingFragment(href.slice(1)) } }
  if (/^(https?:|mailto:)/i.test(href)) return { ...text, target: { kind: 'external', href } }
  return { ...text, target: null }
}

export async function resolveEditorLink(source: string, wiki: boolean, path: string, queryClient: QueryClient): Promise<EditorLinkTarget | null> {
  const parsed = parsedLink(source, wiki, path)
  if (!parsed.name) return parsed.target
  try {
    const resolved = await queryClient.fetchQuery({
      queryKey: ['notes/resolve', parsed.name], queryFn: () => api.resolve(parsed.name!), staleTime: 60_000, retry: false,
    })
    if (!resolved.path || (resolved.candidates?.length ?? 0) > 1) return null
    return { kind: 'note', path: resolved.path, fragment: parsed.fragment }
  } catch { return null }
}

const linkStyles: Record<string, CSSProperties> = {
  resolved: { color: 'var(--link)', textDecoration: 'underline', textUnderlineOffset: 3, cursor: 'pointer' },
  unresolved: { color: 'var(--destructive)', textDecoration: 'underline dashed', textUnderlineOffset: 3 },
  ambiguous: { color: 'var(--warning)', textDecoration: 'underline wavy', textUnderlineOffset: 3 },
  pending: { color: 'var(--muted-foreground)', textDecoration: 'underline dotted', textUnderlineOffset: 3 },
}

export function LiveLink({ source, wiki, path, onNavigate }: {
  source: string; wiki: boolean; path: string;
  onNavigate(target: EditorLinkTarget, options: { alt: boolean }): void;
}) {
  const parsed = parsedLink(source, wiki, path)
  const resolved = useQuery({
    queryKey: ['notes/resolve', parsed.name], queryFn: () => api.resolve(parsed.name!),
    enabled: Boolean(parsed.name), staleTime: 60_000, retry: false,
  })
  const ambiguous = Boolean(parsed.name && (resolved.data?.candidates?.length ?? 0) > 1)
  const target: EditorLinkTarget | null = parsed.name
    ? !ambiguous && resolved.data?.path ? { kind: 'note', path: resolved.data.path, fragment: parsed.fragment } : null
    : parsed.target
  const state = target ? 'resolved' : ambiguous ? 'ambiguous' : parsed.name && resolved.isPending ? 'pending' : 'unresolved'
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const id = useId()
  const anchor = useRef<HTMLSpanElement>(null)
  const popup = useRef<HTMLSpanElement>(null)
  const [position, setPosition] = useState({ left: 8, top: 8, visible: false })
  const previewPath = target?.kind === 'note' ? target.path : ''
  const active = Boolean(previewPath && (hovered || focused) && !dismissed)
  const preview = useQuery({
    queryKey: ['notes/content', previewPath], queryFn: () => api.note(previewPath),
    enabled: active, staleTime: 60_000, retry: false,
  })
  useLayoutEffect(() => {
    if (!active) return
    function placePreview() {
      if (!anchor.current || !popup.current) return
      const link = anchor.current.getBoundingClientRect()
      const tooltip = popup.current.getBoundingClientRect()
      const width = document.documentElement.clientWidth
      const height = window.innerHeight
      const below = link.bottom + 8
      const top = below + tooltip.height <= height - 8 ? below : link.top - tooltip.height - 8
      setPosition({
        left: Math.max(8, Math.min(link.left, width - tooltip.width - 8)),
        top: Math.max(8, Math.min(top, height - tooltip.height - 8)),
        visible: link.bottom > 0 && link.top < height && link.right > 0 && link.left < width,
      })
    }
    placePreview()
    window.addEventListener('scroll', placePreview, true)
    window.addEventListener('resize', placePreview)
    return () => {
      window.removeEventListener('scroll', placePreview, true)
      window.removeEventListener('resize', placePreview)
    }
  }, [active, previewPath, preview.data, preview.isError])
  const title = typeof preview.data?.frontmatter.title === 'string' ? preview.data.frontmatter.title : previewPath.replace(/\.md$/i, '').split('/').at(-1)
  const unavailable = ambiguous ? `여러 노트가 일치합니다: ${resolved.data!.candidates!.join(', ')}`
    : state === 'pending' ? `노트 링크 확인 중: ${parsed.name}` : `노트를 찾을 수 없습니다: ${parsed.name ?? source}`
  const href = target?.kind === 'note' ? noteHref(target.path) + (target.fragment ? `#${encodeURIComponent(target.fragment)}` : '')
    : target?.kind === 'fragment' ? `#${encodeURIComponent(target.id)}` : target?.kind === 'external' ? target.href : undefined
  const label = parsed.labelSource === undefined ? parsed.label : <ReactMarkdown
    remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { trust: false, strict: 'warn' }]]}
    skipHtml disallowedElements={['a', 'img']} unwrapDisallowed components={{ p: ({ children }) => <span>{children}</span> }}
  >{parsed.labelSource}</ReactMarkdown>
  return <span ref={anchor} className="note-link" contentEditable={false}
    onMouseEnter={() => { setHovered(true); setDismissed(false) }} onMouseLeave={() => setHovered(false)}>
    {target ? <a className="cm-live-link" href={href} data-link-state={state} style={linkStyles[state]} title={parsed.title}
      aria-describedby={active ? id : undefined} rel={target.kind === 'external' ? 'noopener noreferrer' : undefined}
      onFocus={() => { setFocused(true); setDismissed(false) }} onBlur={() => setFocused(false)}
      onMouseDown={event => event.preventDefault()}
      onClick={event => { event.preventDefault(); event.stopPropagation(); onNavigate(target, { alt: event.altKey }) }}
      onKeyDown={event => {
        if (event.key === 'Escape' && active) { event.preventDefault(); event.stopPropagation(); setDismissed(true) }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault(); event.stopPropagation(); onNavigate(target, { alt: event.altKey })
        }
      }}>{label}</a>
      : <span className="cm-live-link" data-link-state={state} style={linkStyles[state]} aria-busy={state === 'pending' || undefined} title={unavailable}>{label}</span>}
    {active && createPortal(<span ref={popup} id={id} role="tooltip" className={styles.preview}
      style={{ left: position.left, top: position.top, visibility: position.visible ? 'visible' : 'hidden' }}>
      {preview.data ? <><strong>{title}</strong><span>{preview.data.body.slice(0, 350)}</span><small>{previewPath}</small></>
        : preview.isError ? <span>노트 미리보기를 불러올 수 없습니다.</span> : <span>미리보기를 불러오는 중입니다.</span>}
    </span>, document.body)}
  </span>
}
