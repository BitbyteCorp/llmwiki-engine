'use client'

import { createElement, memo, useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ExtraProps } from 'react-markdown'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeSlug from 'rehype-slug'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import { api } from '@/lib/api'
import { noteHref } from '@/components/common'
import { useOptionalWorkspace, type GroupId } from '@/components/workspace/context'
import { headingFragment, markdownNoteTarget, remarkWikilinks, wikiTarget, WIKILINK_PREFIX } from '@/lib/wikilinks'
import { remarkCallouts } from './markdown/callouts'
import { CodeBlock } from './markdown/code-block'
import styles from './markdown/markdown.module.css'

type CodeNode = { type: string; value?: string; children?: CodeNode[] }
type MarkdownElement = NonNullable<ExtraProps['node']>

type Navigate = (path: string, options?: { fragment?: string; group?: GroupId | 'side' }) => void

function NoteLink({ path, fragment, children, onNavigate }: { path: string; fragment?: string; children: ReactNode; onNavigate?: Navigate }) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const id = useId()
  const anchor = useRef<HTMLSpanElement>(null)
  const popup = useRef<HTMLSpanElement>(null)
  const [position, setPosition] = useState({ left: 8, top: 8, visible: false })
  const active = hovered || focused
  const preview = useQuery({
    queryKey: ['notes/content', path], queryFn: () => api.note(path),
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
  }, [active, preview.data, preview.isError])
  const title = typeof preview.data?.frontmatter.title === 'string' ? preview.data.frontmatter.title : path.replace(/\.md$/i, '').split('/').at(-1)
  return (
    <span ref={anchor} className="note-link" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <Link href={noteHref(path) + (fragment ? `#${encodeURIComponent(fragment)}` : '')} prefetch={false}
        data-link-state="resolved" aria-describedby={active ? id : undefined}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        onNavigate={onNavigate ? (event) => { event.preventDefault(); onNavigate(path, { fragment }) } : undefined}>
        {children}
      </Link>
      {active && createPortal(<span ref={popup} id={id} role="tooltip" className={styles.preview}
        style={{ left: position.left, top: position.top, visibility: position.visible ? 'visible' : 'hidden' }}>
        {preview.data ? <><strong>{title}</strong><span>{preview.data.body.slice(0, 350)}</span><small>{path}</small></>
          : preview.isError ? <span>노트 미리보기를 불러올 수 없습니다.</span> : <span>미리보기를 불러오는 중입니다.</span>}
      </span>, document.body)}
    </span>
  )
}

function WikiLink({ name, currentPath, children, onNavigate, onFragment }: { name: string; currentPath?: string; children: ReactNode; onNavigate?: Navigate; onFragment: (fragment: string) => void }) {
  const target = wikiTarget(name, currentPath)
  const resolved = useQuery({
    queryKey: ['notes/resolve', target?.name], queryFn: () => api.resolve(target!.name),
    enabled: Boolean(target && !target.local), retry: false, staleTime: 60_000,
  })
  if (target?.local) return <a href={`#${encodeURIComponent(target.fragment ?? '')}`} onClick={(event) => { event.preventDefault(); onFragment(target.fragment ?? '') }}>{children}</a>
  if (resolved.data?.path) return <NoteLink path={resolved.data.path} fragment={target?.fragment} onNavigate={onNavigate}>{children}</NoteLink>
  const ambiguous = (resolved.data?.candidates?.length ?? 0) > 1
  const pending = Boolean(target) && resolved.isPending
  return <span data-link-state={ambiguous ? 'ambiguous' : pending ? 'pending' : 'unresolved'} aria-busy={pending || undefined}
    title={ambiguous ? `여러 노트가 일치합니다: ${resolved.data!.candidates!.join(', ')}` : pending ? `노트 링크 확인 중: ${name}` : `노트를 찾을 수 없습니다: ${name}`}>{children}</span>
}

function codeText(node: CodeNode): string {
  if (node.type === 'text') return node.value ?? ''
  return node.children?.map(codeText).join('') ?? ''
}

function Heading({ level, id, children, onFragment }: { level: number; id?: string; children: ReactNode; onFragment: (fragment: string) => void }) {
  return createElement(`h${level}`, { id }, children, id && <a className="heading-anchor" data-heading-anchor="true" href={`#${encodeURIComponent(id)}`} aria-label="이 제목으로 이동" onClick={(event) => { event.preventDefault(); onFragment(id) }} />)
}

function imageSource(src: string | undefined, path?: string, ref?: string): string | undefined {
  if (!src) return undefined
  if (/^https:\/\//i.test(src)) {
    try {
      const url = new URL(src)
      return url.protocol === 'https:' && !url.username && !url.password ? src : undefined
    } catch { return undefined }
  }
  let relative: string
  try { relative = decodeURIComponent(src.split(/[?#]/, 1)[0]!) } catch { return undefined }
  if (!relative || relative.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(relative) || /[\\\u0000-\u001f\u007f]/u.test(relative)) return undefined
  const segments = path?.split('/').slice(0, -1) ?? []
  for (const part of relative.split('/')) {
    if (part.toLowerCase() === '.git') return undefined
    if (part === '..') {
      if (!segments.length) return undefined
      segments.pop()
    } else if (part && part !== '.') segments.push(part)
  }
  if (segments[0] !== 'assets' || segments.length < 2 || segments.some((part) => !part || part.toLowerCase() === '.git')) return undefined
  const query = new URLSearchParams({ path: segments.join('/'), ...(ref ? { ref } : {}) })
  return `/api/notes/raw?${query}`
}

export const Markdown = memo(function Markdown({ content, path, ref, groupId, onNavigate }: { content: string; path?: string; ref?: string; groupId?: GroupId; onNavigate?: Navigate }) {
  const root = useRef<HTMLDivElement>(null)
  const workspace = useOptionalWorkspace()
  const openNote = workspace?.openNote
  const activeGroupId = workspace?.activeGroupId
  const groupRef = groupId ? workspace?.groups[groupId]?.ref : undefined
  const scrollFragment = useCallback((fragment: string) => {
    const scope = groupId ? root.current?.closest<HTMLElement>('[data-workspace-group]') ?? root.current : root.current
    const target = [...(scope?.querySelectorAll<HTMLElement>('[id]') ?? [])].find((element) => element.id === fragment)
    if (target) {
      // Different groups can render the same heading ID.
      target.setAttribute('tabindex', '-1')
      target.focus({ preventScroll: true })
      target.scrollIntoView({ block: 'start' })
    }
    if (groupId && groupId !== activeGroupId && path && openNote) openNote(path, { group: groupId, fragment, ref: groupRef })
    else window.history.replaceState(window.history.state, '', `#${encodeURIComponent(fragment)}`)
  }, [groupId, activeGroupId, path, openNote, groupRef])
  const navigate = useMemo<Navigate | undefined>(() => onNavigate || openNote ? (target, options) => {
    const group = options?.group ?? groupId
    // Following a link pins the destination like VS Code code navigation; same-note fragments keep the tab as is.
    if (onNavigate) onNavigate(target, { ...options, group })
    else openNote!(target, { ...options, group, pin: target !== path })
    if (target === path && options?.fragment) scrollFragment(options.fragment)
  } : undefined, [onNavigate, openNote, path, groupId, scrollFragment])
  // Preserve the parsed subtree across workspace/sidebar renders. Path and ref
  // remain dependencies because they determine relative links and image URLs.
  const rendered = useMemo(() => (
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkCallouts, remarkWikilinks]}
        rehypePlugins={[rehypeSlug, [rehypeHighlight, { detect: false, ignoreMissing: true }], [rehypeKatex, { trust: false, strict: 'warn' }]]}
        skipHtml
        components={{
          img: ({ src, alt, title }) => {
            const resolved = imageSource(typeof src === 'string' ? src : undefined, path, ref)
            return resolved ? <img src={resolved} alt={alt ?? ''} title={title} loading="lazy" decoding="async" referrerPolicy="no-referrer" />
              : <span title="허용되지 않는 이미지 경로">{alt}</span>
          },
          h1: ({ id, children }) => <Heading level={1} id={id} onFragment={scrollFragment}>{children}</Heading>,
          h2: ({ id, children }) => <Heading level={2} id={id} onFragment={scrollFragment}>{children}</Heading>,
          h3: ({ id, children }) => <Heading level={3} id={id} onFragment={scrollFragment}>{children}</Heading>,
          h4: ({ id, children }) => <Heading level={4} id={id} onFragment={scrollFragment}>{children}</Heading>,
          h5: ({ id, children }) => <Heading level={5} id={id} onFragment={scrollFragment}>{children}</Heading>,
          h6: ({ id, children }) => <Heading level={6} id={id} onFragment={scrollFragment}>{children}</Heading>,
          pre: ({ node, children }) => {
            const code = node?.children.find((child): child is MarkdownElement => child.type === 'element' && child.tagName === 'code')
            const classes = code?.properties.className
            const language = Array.isArray(classes) ? classes.map(String).find((value) => value.startsWith('language-'))?.slice(9) : undefined
            return <CodeBlock source={code ? codeText(code) : ''} language={language}>{children}</CodeBlock>
          },
          a: ({ href, children }) => {
            if (!href) return <span>{children}</span>
            if (href.startsWith(WIKILINK_PREFIX)) {
              try {
                const name = decodeURIComponent(href.slice(WIKILINK_PREFIX.length))
                return <WikiLink name={name} currentPath={path} onNavigate={navigate} onFragment={scrollFragment}>{children}</WikiLink>
              } catch { return <span>{children}</span> }
            }
            const note = markdownNoteTarget(href, path)
            if (note) return <NoteLink path={note.path} fragment={note.fragment} onNavigate={navigate}>{children}</NoteLink>
            if (href.startsWith('#')) {
              const fragment = headingFragment(href.slice(1))
              return <a href={`#${encodeURIComponent(fragment)}`} onClick={(event) => { event.preventDefault(); scrollFragment(fragment) }}>{children}</a>
            }
            // Non-note relative links cannot escape to engine routes.
            if (!/^(https?:|mailto:)/i.test(href)) return <span>{children}</span>
            return <a href={href} rel="noopener noreferrer">{children}</a>
          },
        }}
      >{content}</ReactMarkdown>
  ), [content, path, ref, navigate, scrollFragment])
  return <div ref={root} className={`markdown ${styles.reader} min-w-0 [&_input]:mr-2 [&_input]:accent-primary [&>:first-child]:mt-0 [&>:last-child]:mb-0`}>{rendered}</div>
})
