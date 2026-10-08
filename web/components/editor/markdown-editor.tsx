'use client'

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { RefObject } from 'react'
import { createPortal } from 'react-dom'
import { basicSetup } from '@uiw/react-codemirror'
import { Annotation, Compartment, EditorState, Prec, StateEffect } from '@codemirror/state'
import { EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view'
import { foldedRanges, foldGutter, unfoldEffect } from '@codemirror/language'
import { acceptCompletion, autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { useQueryClient } from '@tanstack/react-query'
import { useTheme } from 'next-themes'
import { request } from '@/lib/api'
import { Markdown } from '@/components/markdown'
import { Properties } from '@/components/workspace/properties'
import { headingFragment } from '@/lib/wikilinks'
import { liveMarkdown } from './live-preview/language'
import { editorHeadings } from './live-preview/headings'
import { livePreview, previewFocus } from './live-preview/decorations'
import { LiveLink, resolveEditorLink } from './live-preview/links'
import { editorTheme, liveTheme, sourceTheme } from './live-preview/theme'
import { PortalStore, revealWidget } from './live-preview/widgets'
import { bindPortalTasks } from './live-preview/portal-tasks'

export type EditorHeading = { id: string; title: string; level: number; line: number }
export type EditorLinkTarget =
  | { kind: 'note'; path: string; fragment?: string }
  | { kind: 'fragment'; id: string }
  | { kind: 'external'; href: string }
export type EditorSelection = { text: string; rect: { top: number; left: number; bottom: number } }
export type MarkdownEditorHandle = { scrollToHeading(id: string): boolean; focus(): void }
type MarkdownEditorProps = {
  value: string
  variant: 'live' | 'source'
  path: string
  assetRef?: string
  frontmatter: Record<string, unknown>
  files: string[]
  readOnly: boolean
  scrollerRef: RefObject<HTMLElement | null>
  onChange(value: string): void
  onCursor(cursor: { line: number; column: number }): void
  onSelection(selection: EditorSelection | null): void
  onImages(files: File[]): Promise<string | undefined>
  onHeadings(headings: EditorHeading[]): void
  onActiveHeading(id: string): void
  onNavigate(target: EditorLinkTarget, options: { alt: boolean }): void
}
const externalValue = Annotation.define<boolean>()
const setup = { lineNumbers: false, foldGutter: false, highlightActiveLine: false, highlightActiveLineGutter: false, autocompletion: false, completionKeymap: false }

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(function MarkdownEditor(props, ref) {
  const { resolvedTheme } = useTheme()
  const queryClient = useQueryClient()
  const editor = useRef<EditorView | null>(null)
  const host = useRef<HTMLDivElement>(null)
  const latest = useRef(props)
  latest.current = props
  // Own the document lifecycle; UIW's controlled wrapper resets the whole doc.
  const headings = useRef<EditorHeading[]>([])
  const activeHeading = useRef<string | null>(null)
  const portalAlt = useRef(false)
  const navigatePortal = useCallback((path: string, options?: { fragment?: string }) => latest.current.onNavigate({ kind: 'note', path, fragment: options?.fragment }, { alt: portalAlt.current }), [])
  const mode = useMemo(() => new Compartment(), [])
  const colors = useMemo(() => new Compartment(), [])
  const access = useMemo(() => new Compartment(), [])
  const store = useMemo(() => new PortalStore(), [])
  const uploads = useMemo(() => new Set<{ from: number; to: number }>(), [])
  const portals = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const preview = useMemo(() => livePreview(store, () => ({ path: latest.current.path, assetRef: latest.current.assetRef })), [store])
  const variantExtensions = (variant: MarkdownEditorProps['variant']) => variant === 'live'
    ? [liveTheme, preview.extension]
    : [sourceTheme, lineNumbers(), foldGutter(), highlightActiveLine(), highlightActiveLineGutter()]
  const renderedHeading = (heading: EditorHeading): HTMLElement | null => {
    for (const entry of store.getSnapshot()) {
      if (entry.kind !== 'markdown' || !entry.container.isConnected) continue
      const start = entry.view.state.doc.lineAt(entry.view.posAtDOM(entry.container)).number
      const end = start + entry.source.split('\n').length - 1
      if (heading.line < start || heading.line > end) continue
      const index = headings.current.filter(item => item.line >= start && item.line <= end).findIndex(item => item.id === heading.id)
      return entry.container.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6').item(index)
    }
    return null
  }
  const updateActiveHeading = () => {
    const view = editor.current
    const scroller = latest.current.scrollerRef.current
    if (!view || !scroller) return
    const top = scroller.getBoundingClientRect().top + 20
    let id = headings.current[0]?.id ?? ''
    for (const heading of headings.current) {
      if (heading.line > view.state.doc.lines) continue
      const element = renderedHeading(heading)
      if (element && !element.getClientRects().length) continue
      const position = element?.getBoundingClientRect().top ?? view.documentTop + view.lineBlockAt(view.state.doc.line(heading.line).from).top
      if (position <= top) id = heading.id
      else break
    }
    if (activeHeading.current !== id) { activeHeading.current = id; latest.current.onActiveHeading(id) }
  }
  const reportSelection = (view: EditorView) => {
    const selection = view.state.selection.main
    const line = view.state.doc.lineAt(selection.head)
    latest.current.onCursor({ line: line.number, column: selection.head - line.from + 1 })
    const rect = selection.empty ? null : view.coordsAtPos(selection.head)
    latest.current.onSelection(rect ? { text: view.state.sliceDoc(selection.from, selection.to), rect: { top: rect.top, left: rect.left, bottom: rect.bottom } } : null)
  }
  const extensions = useMemo(() => {
    async function complete(context: { state: EditorState; pos: number; aborted: boolean }) {
      const line = context.state.doc.lineAt(context.pos)
      const match = line.text.slice(0, context.pos - line.from).match(/\[\[([^\]\n]*)$/)
      if (!match) return null
      const query = match[1] ?? ''
      const from = context.pos - query.length
      let suggestions: { path: string; title: string }[] = []
      if (query.trim()) {
        try { suggestions = await request<{ path: string; title: string }[]>(`/api/search/suggest?q=${encodeURIComponent(query)}`) } catch { /* File-tree matches remain available offline. */ }
      }
      if (context.aborted) return null
      const paths = new Map(suggestions.map(item => [item.path, item.title]))
      for (const path of latest.current.files) if (path.endsWith('.md') && path.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && !paths.has(path)) paths.set(path, path.split('/').pop()?.replace(/\.md$/, '') ?? path)
      return { from, options: Array.from(paths, ([path, title]) => ({
        label: path.replace(/\.md$/i, ''), detail: title, type: 'text',
        apply: (view: EditorView, _completion: unknown, start: number, end: number) => {
          const closing = view.state.sliceDoc(end, end + 2) === ']]' ? 2 : 0
          const insert = `${path.replace(/\.md$/i, '')}]]`
          view.dispatch({ changes: { from: start, to: end + closing, insert }, selection: { anchor: start + insert.length } })
        },
      })).slice(0, 40), validFor: /^[^\]\n]*$/ }
    }
    const attach = (files: File[], view: EditorView) => {
      const images = files.filter(file => file.type.startsWith('image/'))
      if (!images.length || view.state.readOnly) return false
      // A mapped bookmark preserves the insertion point while uploads run.
      const bookmark = { from: view.state.selection.main.from, to: view.state.selection.main.to }
      uploads.add(bookmark)
      void latest.current.onImages(images).then(text => {
        if (!text || editor.current !== view || view.state.readOnly) return
        view.dispatch({ changes: { from: bookmark.from, to: Math.max(bookmark.from, bookmark.to), insert: text }, selection: { anchor: bookmark.from + text.length } })
        view.focus()
      }).finally(() => { uploads.delete(bookmark) })
      return true
    }
    return [liveMarkdown, EditorView.lineWrapping,
      mode.of(variantExtensions(latest.current.variant)), colors.of(editorTheme(resolvedTheme === 'dark')),
      access.of([EditorStateAccess(latest.current.readOnly)]),
      autocompletion({ override: [complete], interactionDelay: 0, defaultKeymap: false }),
      EditorView.contentAttributes.of({ 'aria-label': 'Markdown 편집기' }),
      Prec.highest(keymap.of([...completionKeymap, { key: 'Tab', run: acceptCompletion }])),
      EditorView.updateListener.of(update => {
        if (update.docChanged) for (const bookmark of uploads) {
          bookmark.from = update.changes.mapPos(bookmark.from, 1)
          bookmark.to = update.changes.mapPos(bookmark.to, -1)
        }
        if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(externalValue))) latest.current.onChange(update.state.doc.toString())
        if (update.docChanged) { headings.current = editorHeadings(update.state); latest.current.onHeadings(headings.current) }
        if (update.selectionSet || update.docChanged || update.focusChanged) reportSelection(update.view)
        if (update.geometryChanged || update.docChanged) update.view.requestMeasure({ key: store, read: updateActiveHeading })
      }),
      EditorView.domEventHandlers({
        paste: (event, view) => { if (!attach(Array.from(event.clipboardData?.files ?? []), view)) return false; event.preventDefault(); return true },
        drop: (event, view) => {
          const images = Array.from(event.dataTransfer?.files ?? []).filter(file => file.type.startsWith('image/'))
          if (!images.length || view.state.readOnly) return false
          const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
          if (position !== null) view.dispatch({ selection: { anchor: position } })
          attach(images, view); event.preventDefault(); return true
        },
        click: (event, view) => {
          if (!event.metaKey && !event.ctrlKey) return false
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
          if (pos === null) return false
          const link = view.state.field(preview.field, false)?.links.find(link => link.from <= pos && pos <= link.to)
          if (!link) return false
          event.preventDefault()
          void resolveEditorLink(link.source, link.wiki, latest.current.path, queryClient).then(target => { if (target) latest.current.onNavigate(target, { alt: event.altKey }) })
          return true
        },
      }),
    ]
    // Mutable props are read through latest; CM extensions survive React renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [access, colors, mode, preview, queryClient, store])

  useLayoutEffect(() => {
    if (!host.current) return
    const view = new EditorView({ parent: host.current, state: EditorState.create({ doc: latest.current.value, extensions: [basicSetup(setup), extensions] }) })
    editor.current = view
    headings.current = editorHeadings(view.state)
    latest.current.onHeadings(headings.current)
    reportSelection(view)
    view.requestMeasure({ key: store, read: updateActiveHeading })
    return () => { editor.current = null; view.destroy() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extensions])
  useLayoutEffect(() => {
    const view = editor.current
    if (!view) return
    const before = view.state.doc.toString()
    const after = props.value
    if (before === after) return
    let from = 0
    while (from < before.length && from < after.length && before.charCodeAt(from) === after.charCodeAt(from)) from++
    let oldEnd = before.length, newEnd = after.length
    while (oldEnd > from && newEnd > from && before.charCodeAt(oldEnd - 1) === after.charCodeAt(newEnd - 1)) { oldEnd--; newEnd-- }
    const scroll = props.scrollerRef.current?.scrollTop
    view.dispatch({ changes: { from, to: oldEnd, insert: after.slice(from, newEnd) }, annotations: externalValue.of(true) })
    if (scroll !== undefined && props.scrollerRef.current) props.scrollerRef.current.scrollTop = scroll
  }, [props.value, props.scrollerRef])
  useEffect(() => {
    const view = editor.current
    if (!view) return
    view.dispatch({ effects: mode.reconfigure(variantExtensions(props.variant)) })
    if (props.variant === 'live' && view.hasFocus) view.dispatch({ effects: previewFocus.of(true) })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.variant, props.path, props.assetRef, mode])
  useEffect(() => { editor.current?.dispatch({ effects: colors.reconfigure(editorTheme(resolvedTheme === 'dark')) }) }, [resolvedTheme, colors])
  useLayoutEffect(() => { editor.current?.dispatch({ effects: access.reconfigure(EditorStateAccess(props.readOnly)) }) }, [props.readOnly, access])
  useLayoutEffect(() => {
    const releases: (() => void)[] = []
    for (const entry of portals) {
      if (entry.kind === 'properties') {
        const details = entry.container.querySelector('details')
        if (details) details.open = true
      }
      if (entry.kind === 'markdown') releases.push(bindPortalTasks(entry, props.readOnly))
      entry.view.requestMeasure()
    }
    return () => { releases.forEach(release => release()) }
  }, [portals, props.frontmatter, props.readOnly, props.path, props.assetRef])
  useEffect(() => {
    const scroller = props.scrollerRef.current
    if (!scroller) return
    const scroll = () => { updateActiveHeading(); const view = editor.current; if (view) reportSelection(view) }
    scroller.addEventListener('scroll', scroll, { passive: true })
    window.addEventListener('resize', scroll)
    return () => { scroller.removeEventListener('scroll', scroll); window.removeEventListener('resize', scroll) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.scrollerRef])
  useImperativeHandle(ref, () => ({
    focus() { editor.current?.focus() },
    scrollToHeading(id) {
      const view = editor.current
      const scroller = latest.current.scrollerRef.current
      const heading = headings.current.find(heading => heading.id === id)
      if (!view || !scroller || !heading || heading.line > view.state.doc.lines) return false
      const position = view.state.doc.line(heading.line).from
      const effects: StateEffect<unknown>[] = []
      foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => { if (from < position && to > position) effects.push(unfoldEffect.of({ from, to })) })
      if (effects.length) view.dispatch({ effects })
      const element = renderedHeading(heading)
      for (let parent = element?.parentElement; parent && parent !== view.contentDOM; parent = parent.parentElement) {
        if (parent.tagName === 'DETAILS') (parent as HTMLDetailsElement).open = true
      }
      view.requestMeasure({
        read: () => element?.getBoundingClientRect().top ?? view.documentTop + view.lineBlockAt(position).top,
        write: top => scroller.scrollTo({ top: scroller.scrollTop + top - scroller.getBoundingClientRect().top - 16, behavior: 'smooth' }),
      })
      return true
    },
  }), [])
  return <>
    <div ref={host} />
    {portals.map(entry => createPortal(entry.kind === 'link'
      ? <LiveLink source={entry.source} wiki={Boolean(entry.wiki)} path={props.path} onNavigate={props.onNavigate} />
      : <div onMouseDown={event => event.preventDefault()} onClickCapture={event => {
        const anchor = (event.target as HTMLElement).closest('a')
        if (!anchor || entry.kind === 'properties') return
        portalAlt.current = event.altKey
        const href = anchor.getAttribute('href') ?? ''
        if (href.startsWith('#') || /^(https?:|mailto:)/i.test(href)) {
          event.preventDefault(); event.stopPropagation()
          const localHeadings = [...entry.container.querySelectorAll('h1,h2,h3,h4,h5,h6')]
          const blockLine = entry.view.state.doc.lineAt(entry.view.posAtDOM(entry.container)).number
          const index = localHeadings.findIndex(heading => heading.contains(anchor))
          const canonical = index >= 0 ? headings.current.filter(heading => heading.line >= blockLine)[index]?.id : undefined
          props.onNavigate(href.startsWith('#') ? { kind: 'fragment', id: canonical ?? headingFragment(href.slice(1)) } : { kind: 'external', href }, { alt: event.altKey })
        }
      }} onClick={event => {
        const target = event.target as HTMLElement
        if (!target.closest(entry.kind === 'properties' ? 'a,button,input' : 'a,button,input,summary,[data-link-state]')) revealWidget(entry)
      }}>
        {!props.readOnly && <button type="button" className="cm-live-edit-block" onClick={() => revealWidget(entry)}>원문 편집</button>}
        {entry.kind === 'properties' ? <Properties frontmatter={props.frontmatter} /> : <Markdown content={entry.source} path={props.path} ref={props.assetRef} onNavigate={navigatePortal} />}
      </div>, entry.container))}
  </>
})

// The editor itself owns read-only configuration so UIW never reconfigures it.
function EditorStateAccess(readOnly: boolean) { return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)] }
