'use client'

import { useEffect, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'

type LiveEvent = { type: string; [key: string]: unknown }
type Handler = (event: LiveEvent) => void
const handlers = new Map<string, Set<Handler>>()
let connectionState: 'connecting' | 'connected' | 'disconnected' = 'connecting'
const connectionListeners = new Set<() => void>()

export function useLiveConnection(): typeof connectionState {
  return useSyncExternalStore(
    (listener) => { connectionListeners.add(listener); return () => { connectionListeners.delete(listener) } },
    () => connectionState,
    () => 'connecting',
  )
}
const prefixes: Record<string, string[]> = {
  'job.updated': ['jobs', 'activity', 'ops', 'ops-ready', 'imports', 'import'],
  'main.updated': ['notes/tree', 'notes/resolve', 'search', 'search/suggest', 'activity', 'journal', 'links', 'graph', 'tags', 'similar', 'duplicates'],
  'index.updated': ['search', 'search/suggest', 'similar', 'links', 'graph', 'tags', 'duplicates', 'ops', 'ops-ready'],
  'dream.updated': ['activity', 'dreams', 'journal', 'backup', 'ops', 'ops-ready'],
  'conversation.updated': ['conversations'],
  'conversation.presence': [],
}

function isImmutableRef(ref: unknown): boolean {
  return typeof ref === 'string' && /^[a-f0-9]{40}$/i.test(ref)
}

function createPendingInvalidations() {
  return {
    prefixes: new Set<string>(),
    jobIds: new Set<unknown>(),
    runIds: new Set<unknown>(),
    conversationIds: new Set<unknown>(),
    paths: new Set<unknown>(),
    mainUpdated: false,
  }
}

export function onLiveEvent(type: string, handler: Handler): () => void {
  const listeners = handlers.get(type) ?? new Set<Handler>()
  listeners.add(handler)
  handlers.set(type, listeners)
  return () => {
    listeners.delete(handler)
    if (listeners.size === 0) handlers.delete(type)
  }
}

export function useLiveEvents(): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    const source = new EventSource('/api/events', { withCredentials: true })
    let opened = false
    let pending = createPendingInvalidations()
    let flushTimer: number | undefined
    const clearPending = () => {
      window.clearTimeout(flushTimer)
      flushTimer = undefined
      pending = createPendingInvalidations()
    }
    const flush = () => {
      const batch = pending
      pending = createPendingInvalidations()
      flushTimer = undefined
      void queryClient.invalidateQueries({
        predicate: ({ queryKey: key }) => {
          if (typeof key[0] === 'string' && batch.prefixes.has(key[0])) return true
          switch (key[0]) {
            case 'job': return batch.jobIds.has(key[1])
            case 'dream': return batch.runIds.has(key[1])
            case 'conversation':
            case 'conversation-members': return batch.conversationIds.has(key[1])
            case 'notes/content':
            case 'notes/blame': return batch.paths.has(key[1]) && !isImmutableRef(key[2])
            case 'history':
              if (!batch.mainUpdated) return false
              switch (key[1]) {
                case 'list':
                case 'panel': return !key[2] || batch.paths.has(key[2])
                case 'blame': return batch.paths.has(key[2]) && !isImmutableRef(key[3])
                case 'commit': return !isImmutableRef(key[2])
                case 'compare':
                  return !(isImmutableRef(key[2]) && isImmutableRef(key[3])) && (!key[4] || batch.paths.has(key[4]))
                // A revert preview is based on the current main, even for a fixed source SHA.
                case 'revert-preview': return true
                default: return false
              }
            default: return false
          }
        },
      })
    }
    source.onopen = () => {
      clearPending()
      if (opened) void queryClient.invalidateQueries()
      opened = true
      connectionState = 'connected'
      for (const listener of connectionListeners) listener()
      for (const handler of handlers.get('connection') ?? []) handler({ type: 'connection', state: 'connected' })
    }
    source.onerror = () => {
      clearPending()
      connectionState = 'disconnected'
      for (const listener of connectionListeners) listener()
      for (const handler of handlers.get('connection') ?? []) handler({ type: 'connection', state: 'reconnecting' })
    }
    for (const type of Object.keys(prefixes)) {
      source.addEventListener(type, (message) => {
        let event: LiveEvent
        try { event = JSON.parse((message as MessageEvent<string>).data) as LiveEvent } catch { return }
        for (const prefix of prefixes[type] ?? []) pending.prefixes.add(prefix)
        switch (type) {
          case 'job.updated': pending.jobIds.add(event.jobId); break
          case 'dream.updated': pending.runIds.add(event.runId); break
          case 'conversation.updated': pending.conversationIds.add(event.conversationId); break
          case 'main.updated':
            pending.mainUpdated = true
            if (Array.isArray(event.paths)) for (const path of event.paths) pending.paths.add(path)
            break
        }
        // Start one fixed window: sustained events must not postpone the flush.
        if (type !== 'conversation.presence' && flushTimer === undefined) flushTimer = window.setTimeout(flush, 100)
        for (const handler of handlers.get(type) ?? []) handler(event)
      })
    }
    return () => {
      clearPending()
      source.close()
    }
  }, [queryClient])
}
