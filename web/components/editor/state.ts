'use client'

import { useCallback, useSyncExternalStore } from 'react'

export type EditorStatus = {
  dirty: boolean
  mode: 'view' | 'edit' | 'split'
  phase: 'idle' | 'saving' | 'saved' | 'conflict'
  cursor?: { line: number; column: number }
}

const statuses = new Map<string, EditorStatus>()
const listeners = new Set<() => void>()
const guards = new Map<string, Set<() => boolean>>()

export function getEditorStatus(path: string): EditorStatus | undefined {
  return statuses.get(path)
}

export function setEditorStatus(path: string, status: EditorStatus | null): void {
  const previous = statuses.get(path)
  if (!status) {
    if (!statuses.delete(path)) return
  } else {
    if (previous && previous.dirty === status.dirty && previous.mode === status.mode && previous.phase === status.phase && previous.cursor?.line === status.cursor?.line && previous.cursor?.column === status.cursor?.column) return
    statuses.set(path, { ...status, ...(status.cursor ? { cursor: { ...status.cursor } } : {}) })
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

const serverSnapshot = () => undefined

export function useEditorStatus(path: string): EditorStatus | undefined {
  const snapshot = useCallback(() => statuses.get(path), [path])
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot)
}

export function registerEditorGuard(path: string, guard: () => boolean): () => void {
  const entries = guards.get(path) ?? new Set<() => boolean>()
  entries.add(guard)
  guards.set(path, entries)
  return () => {
    entries.delete(guard)
    if (!entries.size && guards.get(path) === entries) guards.delete(path)
  }
}

export function confirmEditorLeave(paths?: string[]): boolean {
  const selected = paths ? new Set(paths) : guards.keys()
  for (const path of selected) {
    for (const guard of guards.get(path) ?? []) {
      if (!guard()) return false
    }
  }
  return true
}

export type EditorCommand = 'new' | 'edit' | 'save' | 'rename' | 'delete' | 'blame' | 'ask'

export function dispatchEditorCommand(command: EditorCommand, path?: string, options?: { exactPath?: boolean }): void {
  window.dispatchEvent(new CustomEvent('workspace-editor-command', { detail: { command, path, ...options } }))
}
