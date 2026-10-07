'use client'

import { useMemo, useRef } from 'react'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { acceptCompletion, autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { useTheme } from 'next-themes'
import { request } from '@/lib/api'

export function MarkdownEditor({ value, files, disabled, onChange, onSave, onDiscard, onCursor, onSelection, onImages }: {
  value: string; files: string[]; disabled: boolean; onChange(value: string): void; onSave(): void; onDiscard(): void;
  onCursor(cursor: { line: number; column: number }): void; onSelection(text: string): void;
  onImages(files: File[]): Promise<string | undefined>;
}) {
  const { resolvedTheme } = useTheme()
  const editor = useRef<ReactCodeMirrorRef>(null)
  const handlers = useRef({ onSave, onDiscard, onImages })
  handlers.current = { onSave, onDiscard, onImages }
  const extensions = useMemo(() => {
    const language = markdown({ codeLanguages: languages })
    async function complete(context: { state: EditorState; pos: number; aborted: boolean }) {
      const line = context.state.doc.lineAt(context.pos)
      const match = line.text.slice(0, context.pos - line.from).match(/\[\[([^\]\n]*)$/)
      if (!match) return null
      const query = match[1] ?? ''
      const from = context.pos - query.length
      let suggestions: { path: string; title: string }[] = []
      if (query.trim()) {
        try { suggestions = await request<{ path: string; title: string }[]>(`/api/search/suggest?q=${encodeURIComponent(query)}`) } catch { /* Tree matches remain available offline. */ }
      }
      if (context.aborted) return null
      const paths = new Map(suggestions.map(item => [item.path, item.title]))
      for (const path of files) if (path.endsWith('.md') && path.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && !paths.has(path)) paths.set(path, path.split('/').pop()?.replace(/\.md$/, '') ?? path)
      return {
        from,
        options: Array.from(paths, ([path, title]) => ({
          label: path.replace(/\.md$/i, ''), detail: title, type: 'text',
          apply: (view: EditorView, _completion: unknown, start: number, end: number) => {
            const closing = view.state.sliceDoc(end, end + 2) === ']]' ? 2 : 0
            const insert = `${path.replace(/\.md$/i, '')}]]`
            view.dispatch({ changes: { from: start, to: end + closing, insert }, selection: { anchor: start + insert.length } })
          },
        })).slice(0, 40),
        validFor: /^[^\]\n]*$/,
      }
    }
    const attach = (files: File[], view: EditorView) => {
      const images = files.filter(file => file.type.startsWith('image/'))
      if (!images.length || view.state.readOnly) return false
      void handlers.current.onImages(images).then(text => {
        if (!text || editor.current?.view !== view) return
        view.dispatch(view.state.replaceSelection(text))
        view.focus()
      })
      return true
    }
    return [language, autocompletion({ override: [complete], interactionDelay: 0, defaultKeymap: false }), EditorView.lineWrapping,
      EditorView.contentAttributes.of({ 'aria-label': 'Markdown 원문 편집기' }),
      Prec.highest(keymap.of([
        ...completionKeymap,
        { key: 'Tab', run: acceptCompletion },
        { key: 'Mod-s', run: () => { handlers.current.onSave(); return true } },
        { key: 'Escape', run: () => { handlers.current.onDiscard(); return true } },
      ])),
      EditorView.domEventHandlers({
        paste: (event, view) => {
          const items = Array.from(event.clipboardData?.files ?? [])
          if (!attach(items, view)) return false
          event.preventDefault(); return true
        },
        drop: (event, view) => {
          const images = Array.from(event.dataTransfer?.files ?? []).filter(file => file.type.startsWith('image/'))
          if (!images.length || view.state.readOnly) return false
          const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
          if (position !== null) view.dispatch({ selection: { anchor: position } })
          attach(images, view); event.preventDefault(); return true
        },
      }),
    ]
  }, [files])
  return <CodeMirror ref={editor} value={value} theme={resolvedTheme === 'dark' ? 'dark' : 'light'} extensions={extensions} readOnly={disabled} editable={!disabled} height="100%" minHeight="24rem" indentWithTab={false} autoFocus basicSetup={{ lineNumbers: true, foldGutter: true, autocompletion: false, completionKeymap: false }} onChange={onChange} onUpdate={update => {
    if (!update.selectionSet && !update.docChanged) return
    const selection = update.state.selection.main
    const line = update.state.doc.lineAt(selection.head)
    onCursor({ line: line.number, column: selection.head - line.from + 1 })
    onSelection(update.state.sliceDoc(selection.from, selection.to))
  }} />
}
