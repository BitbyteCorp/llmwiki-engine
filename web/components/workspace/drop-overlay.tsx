'use client'

import { useEffect, useState, type DragEvent, type ReactNode } from 'react'
import { MAX_EDITOR_GROUPS, useWorkspace, type EditorGroup, type DropTarget, type SplitSide } from './context'
import { getActiveDrag, hasWorkspaceDrag, isCopyDrop, readDropPayload } from './dnd'

const labels: Record<'center' | SplitSide, string> = { center: '여기에 열기', left: '왼쪽으로 분할', right: '오른쪽으로 분할', top: '위로 분할', bottom: '아래로 분할' }

export function GroupDropArea({ group, mobile, children }: { group: EditorGroup; mobile: boolean; children: ReactNode }) {
  const workspace = useWorkspace()
  const [zone, setZone] = useState<'center' | SplitSide | null>(null)
  function dropZone(event: DragEvent<HTMLDivElement>): 'center' | SplitSide {
    const drag = getActiveDrag()
    if (mobile || workspace.groupOrder.length >= MAX_EDITOR_GROUPS || (drag?.kind === 'tab' && drag.groupId === group.id && group.tabs.length === 1)) return 'center'
    // Zones follow the whole group (tabs included), matching the overlay geometry.
    const bounds = (event.currentTarget.closest('[data-workspace-group]') ?? event.currentTarget).getBoundingClientRect()
    const x = (event.clientX - bounds.left) / Math.max(1, bounds.width)
    const y = (event.clientY - bounds.top) / Math.max(1, bounds.height)
    // Closest edge wins at corners; the middle 44% remains an ordinary open target.
    const edges: [SplitSide, number][] = [['left', x], ['right', 1 - x], ['top', y], ['bottom', 1 - y]]
    const closest = edges.reduce((best, edge) => edge[1] < best[1] ? edge : best)
    return closest[1] < .28 ? closest[0] : 'center'
  }
  useEffect(() => {
    const clear = () => setZone(null)
    window.addEventListener('dragend', clear, true)
    window.addEventListener('drop', clear, true)
    return () => { window.removeEventListener('dragend', clear, true); window.removeEventListener('drop', clear, true) }
  }, [])
  return <div data-workspace-reader className="workspace-reader min-h-0 min-w-0 flex-1 overflow-hidden [&>section]:h-full! [&>section]:min-h-0! [&>section]:rounded-none [&>section]:border-0" onDragOver={event => {
    if (!hasWorkspaceDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = getActiveDrag()?.kind === 'tab' && !isCopyDrop(event) ? 'move' : 'copy'
    setZone(dropZone(event))
  }} onDragLeave={event => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
    const bounds = event.currentTarget.getBoundingClientRect()
    if (event.clientX > bounds.left && event.clientX < bounds.right && event.clientY > bounds.top && event.clientY < bounds.bottom) return
    setZone(null)
  }} onDrop={event => {
    const payload = readDropPayload(event)
    if (!payload) return
    event.preventDefault()
    event.stopPropagation()
    const side = dropZone(event)
    const target: DropTarget = side === 'center' ? { kind: 'group', groupId: group.id } : { kind: 'split', groupId: group.id, side }
    if (payload.kind === 'tab') workspace.moveTab(payload, target, { copy: isCopyDrop(event) })
    else workspace.openNoteAt(payload.path, target)
    setZone(null)
  }}>{children}<div className="workspace-drop-overlay" data-zone={zone ?? 'center'} data-visible={zone !== null} aria-hidden="true"><span className="workspace-drop-label">{labels[zone ?? 'center']}</span></div></div>
}
