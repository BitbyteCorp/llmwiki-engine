'use client'

import { useSyncExternalStore, type DragEvent } from 'react'
import { noteHref } from '@/components/common'
import { isGraphTab } from './layout'

/** Repository note path. Explorer folder moves and editor-group drops share this type. */
export const NOTE_MIME = 'application/x-llmwiki-note'
/** JSON `{groupId,path}` of an editor tab being dragged. */
export const TAB_MIME = 'application/x-llmwiki-tab'

export type ActiveDrag =
  | { kind: 'note'; path: string }
  | { kind: 'tab'; groupId: string; path: string }

// Browsers hide `getData` during dragover, so drop targets read the payload
// of in-app drags from this store and only use `dataTransfer` on drop.
let activeDrag: ActiveDrag | null = null
const listeners = new Set<() => void>()

function publish(next: ActiveDrag | null) {
  if (activeDrag === next) return
  activeDrag = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getActiveDrag(): ActiveDrag | null {
  return activeDrag
}

export function useActiveDrag(): ActiveDrag | null {
  return useSyncExternalStore(subscribe, getActiveDrag, () => null)
}

function clearOnEnd(target: EventTarget) {
  const end = () => {
    target.removeEventListener('dragend', end)
    publish(null)
  }
  target.addEventListener('dragend', end)
}

function chip(event: DragEvent, label: string) {
  const element = document.createElement('div')
  element.className = 'drag-chip'
  element.textContent = label
  document.body.append(element)
  event.dataTransfer.setDragImage(element, 12, 14)
  requestAnimationFrame(() => element.remove())
}

function label(path: string, title?: string) {
  return title || path.split('/').pop()?.replace(/\.md$/i, '') || path
}

/**
 * Starts a note drag from any list. `move` adds the move effect that explorer
 * folder drops require; editor groups always open notes with the copy effect.
 */
export function setNoteDragData(event: DragEvent, path: string, options?: { title?: string; move?: boolean }) {
  event.dataTransfer.setData(NOTE_MIME, path)
  event.dataTransfer.setData('text/plain', path)
  event.dataTransfer.setData('text/uri-list', new URL(noteHref(path), window.location.origin).href)
  event.dataTransfer.effectAllowed = options?.move ? 'copyMove' : 'copy'
  chip(event, label(path, options?.title))
  publish({ kind: 'note', path })
  clearOnEnd(event.currentTarget)
}

/** Starts an editor tab drag. Tabs move by default and copy with Ctrl/⌘ or Alt. */
export function setTabDragData(event: DragEvent, groupId: string, path: string, title?: string) {
  event.dataTransfer.setData(TAB_MIME, JSON.stringify({ groupId, path }))
  if (!isGraphTab(path)) {
    event.dataTransfer.setData('text/plain', path)
    event.dataTransfer.setData('text/uri-list', new URL(noteHref(path), window.location.origin).href)
  }
  event.dataTransfer.effectAllowed = 'copyMove'
  chip(event, label(path, title))
  publish({ kind: 'tab', groupId, path })
  clearOnEnd(event.currentTarget)
}

/** Whether a dragover/drop event carries an in-app note or tab. */
export function hasWorkspaceDrag(event: DragEvent): boolean {
  const types = event.dataTransfer.types
  return types.includes(TAB_MIME) || types.includes(NOTE_MIME)
}

/** Reads the payload on drop. Returns null for foreign or malformed data. */
export function readDropPayload(event: DragEvent): ActiveDrag | null {
  const tab = event.dataTransfer.getData(TAB_MIME)
  if (tab) {
    try {
      const value = JSON.parse(tab) as { groupId?: unknown; path?: unknown }
      if (typeof value.groupId === 'string' && typeof value.path === 'string') return { kind: 'tab', groupId: value.groupId, path: value.path }
    } catch { return null }
    return null
  }
  const path = event.dataTransfer.getData(NOTE_MIME)
  return path ? { kind: 'note', path } : null
}

/** Ctrl/⌘ or Alt during a tab drop copies the tab instead of moving it. */
export function isCopyDrop(event: DragEvent): boolean {
  return event.ctrlKey || event.metaKey || event.altKey
}
