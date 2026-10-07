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
  'job.updated': ['jobs', 'job', 'activity', 'ops'],
  'main.updated': ['notes/tree', 'notes/content', 'history', 'search', 'activity', 'journal', 'links', 'graph', 'tags'],
  'index.updated': ['search', 'search/suggest', 'similar', 'ops'],
  'dream.updated': ['activity', 'dreams', 'dream', 'journal', 'backup', 'ops'],
  'conversation.updated': ['conversations', 'conversation'],
  'conversation.presence': [],
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
    source.onopen = () => {
      if (opened) void queryClient.invalidateQueries()
      opened = true
      connectionState = 'connected'
      for (const listener of connectionListeners) listener()
      for (const handler of handlers.get('connection') ?? []) handler({ type: 'connection', state: 'connected' })
    }
    source.onerror = () => {
      connectionState = 'disconnected'
      for (const listener of connectionListeners) listener()
      for (const handler of handlers.get('connection') ?? []) handler({ type: 'connection', state: 'reconnecting' })
    }
    for (const type of Object.keys(prefixes)) {
      source.addEventListener(type, (message) => {
        let event: LiveEvent
        try { event = JSON.parse((message as MessageEvent<string>).data) as LiveEvent } catch { return }
        for (const prefix of prefixes[type] ?? []) void queryClient.invalidateQueries({ queryKey: [prefix] })
        for (const handler of handlers.get(type) ?? []) handler(event)
      })
    }
    return () => source.close()
  }, [queryClient])
}
