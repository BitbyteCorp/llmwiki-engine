'use client'

import { useCallback, useSyncExternalStore } from 'react'
import type { Note } from '@/lib/api'

export type EditorStatus = {
  dirty: boolean
  mode: 'view' | 'edit' | 'split'
  phase: 'idle' | 'saving' | 'saved' | 'conflict'
  cursor?: { line: number; column: number }
}

const statuses = new Map<string, EditorStatus>()
const listeners = new Set<() => void>()
const guards = new Map<string, Set<() => boolean>>()

export type DraftTransfer = { baseline: Note | null; draft: string; mode: EditorStatus['mode'] }
const transferringDrafts = new Set<string>()
const drafts = new Map<string, DraftTransfer>()
const draftListeners = new Map<string, Set<() => void>>()

export function markDraftTransfer(path: string): void {
  transferringDrafts.add(path)
}

export function isDraftTransferring(path: string): boolean {
  return transferringDrafts.has(path)
}

export function stashDraft(path: string, value: DraftTransfer): void {
  drafts.set(path, value)
  for (const listener of draftListeners.get(path) ?? []) listener()
}

export function takeDraft(path: string): DraftTransfer | undefined {
  const value = drafts.get(path)
  if (value) {
    drafts.delete(path)
    transferringDrafts.delete(path)
  }
  return value
}

export function clearDraft(path: string): void {
  drafts.delete(path)
  transferringDrafts.delete(path)
}

export function renameDraft(from: string, to: string): void {
  if (from === to) return
  const value = drafts.get(from)
  const transferring = transferringDrafts.delete(from)
  drafts.delete(from)
  if (transferring) transferringDrafts.add(to)
  if (value) stashDraft(to, { ...value, baseline: value.baseline ? { ...value.baseline, path: to } : null })
}

export function subscribeDraft(path: string, listener: () => void): () => void {
  const entries = draftListeners.get(path) ?? new Set<() => void>()
  entries.add(listener)
  draftListeners.set(path, entries)
  return () => {
    entries.delete(listener)
    if (!entries.size) draftListeners.delete(path)
  }
}

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

export function subscribeEditorStatus(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

const serverSnapshot = () => undefined

export function useEditorStatus(path: string): EditorStatus | undefined {
  const snapshot = useCallback(() => statuses.get(path), [path])
  return useSyncExternalStore(subscribeEditorStatus, snapshot, serverSnapshot)
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

/** `view`/`edit`/`preview` switch reader modes (`preview` = source + live preview); `discard` asks before dropping the draft. */
export type EditorCommand = 'new' | 'edit' | 'view' | 'preview' | 'save' | 'discard' | 'rename' | 'delete' | 'blame' | 'ask'

export function dispatchEditorCommand(command: EditorCommand, path?: string, options?: { exactPath?: boolean }): void {
  window.dispatchEvent(new CustomEvent('workspace-editor-command', { detail: { command, path, ...options } }))
}
