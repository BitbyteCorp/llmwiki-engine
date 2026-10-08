import { StateEffect, StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import katex from 'katex'
import { CheckboxWidget, CodeHeaderWidget, ImageWidget, PortalStore, PortalWidget, TextWidget } from './widgets'
import { inlineMathText, normalizedBlockSource } from './language'

export const previewFocus = StateEffect.define<boolean>()
export type PreviewLink = { from: number; to: number; source: string; wiki: boolean }
export type PreviewState = { focused: boolean; decorations: DecorationSet; atomic: DecorationSet; links: PreviewLink[] }
const inlineClasses: Record<string, string> = { Emphasis: 'cm-live-emphasis', StrongEmphasis: 'cm-live-strong', Strikethrough: 'cm-live-strike', InlineCode: 'cm-live-code' }

class MathWidget extends WidgetType {
  constructor(readonly source: string) { super() }
  eq(other: MathWidget) { return this.source === other.source }
  toDOM() {
    const span = document.createElement('span')
    try { katex.render(this.source, span, { trust: false, throwOnError: false, strict: 'warn' }) } catch { span.textContent = this.source }
    return span
  }
}

export function livePreview(store: PortalStore, context: () => { path: string; assetRef?: string }) {
  function build(state: EditorState, focused: boolean): PreviewState {
    const ranges: Range<Decoration>[] = []
    const atomic: Range<Decoration>[] = []
    const links: PreviewLink[] = []
    const { path, assetRef } = context()
    const touches = (from: number, to: number, block = false) => {
      if (!focused) return false
      const start = block ? state.doc.lineAt(from).from : from
      const end = block ? state.doc.lineAt(to).to : to
      return state.selection.ranges.some(selection => selection.from <= end && selection.to >= start)
    }
    const hide = (from: number, to: number, widget?: WidgetType, block = false) => {
      if (from >= to) return
      const decoration = Decoration.replace({ widget, block }).range(from, to)
      ranges.push(decoration); atomic.push(decoration)
    }
    const mark = (from: number, to: number, className: string) => { if (from < to) ranges.push(Decoration.mark({ class: className }).range(from, to)) }
    const lineClass = (from: number, to: number, className: string) => {
      for (let number = state.doc.lineAt(from).number; number <= state.doc.lineAt(to).number; number++) ranges.push(Decoration.line({ class: className }).range(state.doc.line(number).from))
    }
    const first = state.doc.line(1)
    let frontmatterEnd = 0
    if (first.text === '---') {
      for (let number = 2; number <= state.doc.lines; number++) {
        const line = state.doc.line(number)
        if (/^(---|\.\.\.)\s*$/.test(line.text)) { frontmatterEnd = line.to; break }
      }
    }
    if (frontmatterEnd && !touches(0, frontmatterEnd, true)) hide(0, frontmatterEnd, new PortalWidget(store, 'properties', state.sliceDoc(0, frontmatterEnd)), true)
    syntaxTree(state).iterate({
      enter(node) {
        const { from, to, name } = node
        if (frontmatterEnd && from < frontmatterEnd && name !== 'Document') return false
        if (name === 'Table' || name === 'BlockMath') {
          if (!touches(from, to, true)) { hide(from, to, new PortalWidget(store, 'markdown', normalizedBlockSource(state, node.node)), true); return false }
        }
        if (name === 'Blockquote') {
          if (/^\s*>\s*\[![a-z][\w-]*\][+-]?/i.test(state.sliceDoc(from, to)) && !touches(from, to, true)) {
            hide(from, to, new PortalWidget(store, 'markdown', state.sliceDoc(from, to)), true); return false
          }
          lineClass(from, to, 'cm-live-quote')
          if (!touches(from, to, true)) {
            let child = node.node.firstChild
            while (child) { if (child.name === 'QuoteMark') hide(child.from, Math.min(child.to + (state.sliceDoc(child.to, child.to + 1) === ' ' ? 1 : 0), to)); child = child.nextSibling }
          }
        }
        if (name === 'FencedCode') {
          const source = normalizedBlockSource(state, node.node)
          const language = source.match(/^\s*(?:`{3,}|~{3,})([^\s`]*)/)?.[1] ?? ''
          lineClass(from, to, 'cm-live-codeblock')
          if (!touches(from, to, true)) {
            if (language.toLowerCase() === 'mermaid') { hide(from, to, new PortalWidget(store, 'markdown', source), true); return false }
            const opening = state.doc.lineAt(from)
            const closed = node.node.getChildren('CodeMark').length > 1
            const body = source.split('\n').slice(1, closed ? -1 : undefined).join('\n')
            ranges.push(Decoration.widget({ widget: new CodeHeaderWidget(language, body), block: true, side: -1 }).range(opening.from))
            hide(from, opening.to)
            let child = node.node.firstChild
            while (child) {
              if (child.name === 'QuoteMark') hide(child.from, Math.min(child.to + (state.sliceDoc(child.to, child.to + 1) === ' ' ? 1 : 0), to))
              if (child.name === 'CodeMark' && child.from > opening.to) hide(child.from, child.to)
              child = child.nextSibling
            }
          }
          return false
        }
        if (/^(ATXHeading|SetextHeading)[1-6]$/.test(name)) {
          lineClass(from, to, `cm-live-h${name.slice(-1)}`)
          if (!touches(from, to, true)) {
            let child = node.node.firstChild
            while (child) {
              if (child.name === 'HeaderMark') {
                const markerLine = state.doc.lineAt(child.from)
                const start = name.startsWith('Setext') && markerLine.from === child.from ? markerLine.from - 1 : child.from
                hide(start, Math.min(child.to + (state.sliceDoc(child.to, child.to + 1) === ' ' ? 1 : 0), to))
              }
              child = child.nextSibling
            }
          }
        }
        if (name === 'HorizontalRule' && !touches(from, to, true)) { hide(from, to, new TextWidget('', 'cm-live-hr')); return false }
        if (name === 'ListItem' && !touches(from, to, true)) {
          const child = node.node.firstChild
          if (child?.name === 'ListMark' && /^[*+-]$/.test(state.sliceDoc(child.from, child.to))) hide(child.from, child.to, new TextWidget('•', 'cm-live-list'))
        }
        if (name === 'TaskMarker' && !touches(state.doc.lineAt(from).from, state.doc.lineAt(to).to, true)) {
          hide(from, to, new CheckboxWidget(/x/i.test(state.sliceDoc(from, to)), state.readOnly)); return false
        }
        if (name === 'Link' || name === 'WikiLink') {
          const source = state.sliceDoc(from, to)
          const wiki = name === 'WikiLink'
          if (!wiki && !/^\[[\s\S]*\]\(/.test(source)) return
          links.push({ from, to, source, wiki })
          if (!touches(from, to)) { hide(from, to, new PortalWidget(store, 'link', source, wiki)); return false }
        }
        if (name === 'Image' && !touches(from, to)) {
          const url = node.node.getChild('URL')
          const source = state.sliceDoc(from, to)
          const alt = source.match(/^!\[([^\]]*)\]/)?.[1] ?? ''
          if (url) hide(from, to, new ImageWidget(state.sliceDoc(url.from, url.to).replace(/^<|>$/g, ''), alt, path, assetRef))
          return false
        }
        if (name === 'InlineMath' && !touches(from, to)) {
          const source = inlineMathText(state.sliceDoc(from, to))
          hide(from, to, new MathWidget(source)); return false
        }
        if (inlineClasses[name] && !touches(from, to)) {
          mark(from, to, inlineClasses[name])
          let child = node.node.firstChild
          while (child) {
            if (['EmphasisMark', 'StrikethroughMark', 'CodeMark'].includes(child.name)) hide(child.from, child.to)
            child = child.nextSibling
          }
        }
      },
    })
    return { focused, decorations: Decoration.set(ranges, true), atomic: Decoration.set(atomic, true), links }
  }
  const field = StateField.define<PreviewState>({
    create: state => build(state, false),
    update(previous, transaction) {
      let focused = previous.focused
      for (const effect of transaction.effects) if (effect.is(previewFocus)) focused = effect.value
      if (transaction.docChanged || transaction.selection || focused !== previous.focused || syntaxTree(transaction.startState) !== syntaxTree(transaction.state) || transaction.reconfigured) return build(transaction.state, focused)
      return previous
    },
    provide: field => EditorView.decorations.from(field, value => value.decorations),
  })
  const extension: Extension = [field, EditorView.atomicRanges.of(view => view.state.field(field).atomic), EditorView.domEventHandlers({
    focus: (_event, view) => { view.dispatch({ effects: previewFocus.of(true) }); return false },
    blur: (_event, view) => { view.dispatch({ effects: previewFocus.of(false) }); return false },
  })]
  return { field, extension }
}
