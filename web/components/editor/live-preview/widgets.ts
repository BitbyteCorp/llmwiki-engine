import { WidgetType, type EditorView } from '@codemirror/view'
import { imageSource } from '@/components/markdown'

export type PortalEntry = { container: HTMLElement; kind: 'markdown' | 'properties' | 'link'; source: string; wiki?: boolean; view: EditorView }

// Widgets register DOM containers; the owning React tree supplies their content.
export class PortalStore {
  private entries = new Map<HTMLElement, PortalEntry>()
  private snapshot: PortalEntry[] = []
  private listeners = new Set<() => void>()
  private queued = false
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = () => this.snapshot
  add(entry: PortalEntry) { this.entries.set(entry.container, entry); this.changed() }
  remove(container: HTMLElement) { this.entries.delete(container); this.changed() }
  private changed() {
    this.snapshot = [...this.entries.values()]
    if (this.queued) return
    this.queued = true
    queueMicrotask(() => { this.queued = false; this.listeners.forEach(listener => listener()) })
  }
}

export class PortalWidget extends WidgetType {
  constructor(readonly store: PortalStore, readonly kind: PortalEntry['kind'], readonly source: string, readonly wiki = false) { super() }
  eq(other: PortalWidget) { return this.store === other.store && this.kind === other.kind && this.source === other.source && this.wiki === other.wiki }
  toDOM(view: EditorView) {
    const container = document.createElement(this.kind === 'link' ? 'span' : 'div')
    container.className = this.kind === 'link' ? 'cm-live-link' : `cm-live-widget cm-live-block${this.kind === 'properties' ? ' cm-live-frontmatter' : ''}`
    this.store.add({ container, kind: this.kind, source: this.source, wiki: this.wiki, view })
    return container
  }
  destroy(container: HTMLElement) { this.store.remove(container) }
  ignoreEvent() { return true }
}

export function revealWidget(entry: PortalEntry) {
  if (entry.view.state.readOnly) return
  const start = entry.view.posAtDOM(entry.container)
  const anchor = Math.min(start + (entry.kind === 'properties' ? 4 : 1), entry.view.state.doc.length)
  entry.view.dispatch({ selection: { anchor } })
  entry.view.focus()
}

export class TextWidget extends WidgetType {
  constructor(readonly text: string, readonly className: string) { super() }
  eq(other: TextWidget) { return this.text === other.text && this.className === other.className }
  toDOM() { const span = document.createElement('span'); span.className = this.className; span.textContent = this.text; return span }
}

export class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string, readonly path: string, readonly assetRef?: string) { super() }
  eq(other: ImageWidget) { return this.src === other.src && this.alt === other.alt && this.path === other.path && this.assetRef === other.assetRef }
  toDOM(view: EditorView) {
    const wrapper = document.createElement('span')
    wrapper.className = 'cm-live-image'
    const src = imageSource(this.src, this.path, this.assetRef)
    if (src) {
      const image = document.createElement('img')
      image.src = src; image.alt = this.alt; image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer'
      image.addEventListener('load', () => view.requestMeasure())
      wrapper.append(image)
    } else { wrapper.textContent = this.alt; wrapper.title = '허용되지 않는 이미지 경로' }
    wrapper.addEventListener('click', () => { if (!view.state.readOnly) { view.dispatch({ selection: { anchor: view.posAtDOM(wrapper) + 1 } }); view.focus() } })
    return wrapper
  }
  ignoreEvent() { return true }
}

export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly readOnly: boolean) { super() }
  eq(other: CheckboxWidget) { return this.checked === other.checked && this.readOnly === other.readOnly }
  toDOM(view: EditorView) {
    const input = document.createElement('input')
    input.type = 'checkbox'; input.className = 'cm-live-checkbox'; input.checked = this.checked; input.disabled = view.state.readOnly
    input.setAttribute('aria-label', this.checked ? '할 일 완료 취소' : '할 일 완료')
    input.addEventListener('mousedown', event => event.preventDefault())
    input.addEventListener('click', event => {
      event.stopPropagation()
      if (view.state.readOnly) return
      const from = view.posAtDOM(input)
      if (!/^\[[ xX]\]$/.test(view.state.sliceDoc(from, from + 3))) return
      view.dispatch({ changes: { from: from + 1, to: from + 2, insert: this.checked ? ' ' : 'x' }, userEvent: 'input' })
    })
    return input
  }
  ignoreEvent() { return true }
}

export class CodeHeaderWidget extends WidgetType {
  constructor(readonly language: string, readonly source: string) { super() }
  eq(other: CodeHeaderWidget) { return this.language === other.language && this.source === other.source }
  toDOM() {
    const header = document.createElement('div'); header.className = 'cm-live-code-header'
    const label = document.createElement('span'); label.textContent = this.language || '텍스트'
    const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '복사'; copy.setAttribute('aria-label', '코드 복사')
    copy.addEventListener('click', () => { void navigator.clipboard.writeText(this.source).then(() => { copy.textContent = '복사됨' }, () => { copy.textContent = '복사 실패' }) })
    header.append(label, copy); return header
  }
  ignoreEvent() { return true }
}
