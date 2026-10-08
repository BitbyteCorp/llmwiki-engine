import { syntaxTree } from '@codemirror/language'
import type { PortalEntry } from './widgets'

// The read renderer disables GFM inputs. Bind them to the original TaskMarker
// spans instead of treating rendered DOM as an editable source of truth.
export function bindPortalTasks(entry: PortalEntry, readOnly: boolean): () => void {
  const inputs = [...entry.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
  const markers = () => {
    const state = entry.view.state
    const start = entry.view.posAtDOM(entry.container)
    const end = Math.min(start + entry.source.length, state.doc.length)
    const positions: number[] = []
    syntaxTree(state).iterate({ from: start, to: end, enter(node) {
      if (node.name === 'TaskMarker' && node.from >= start && node.to <= end) positions.push(node.from)
    } })
    return positions
  }
  const initial = inputs.length ? markers() : []
  const releases: (() => void)[] = []
  inputs.forEach((input, index) => {
    input.disabled = readOnly || initial[index] === undefined
    const toggle = (event: MouseEvent) => {
      event.stopPropagation()
      if (entry.view.state.readOnly) return
      const from = markers()[index]
      if (from === undefined) return
      const source = entry.view.state.sliceDoc(from, from + 3)
      if (!/^\[[ xX]\]$/.test(source)) return
      entry.view.dispatch({ changes: { from: from + 1, to: from + 2, insert: /x/i.test(source) ? ' ' : 'x' }, userEvent: 'input' })
    }
    input.addEventListener('click', toggle)
    releases.push(() => input.removeEventListener('click', toggle))
  })
  return () => { releases.forEach(release => release()) }
}
