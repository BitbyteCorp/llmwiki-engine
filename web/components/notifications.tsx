'use client'

import Link from 'next/link'
import { useLayoutEffect, useState, useSyncExternalStore } from 'react'
import { CheckCircle2, CircleAlert, Info, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export type NotificationTone = 'info' | 'success' | 'error'
export interface NotificationInput { title: string; description?: string; tone?: NotificationTone; action?: { label: string; href: string } }
interface Notification extends NotificationInput { id: number; exiting?: boolean }

let items: Notification[] = []
let nextId = 1
const listeners = new Set<() => void>()
const dismissTimers = new Map<number, number>()
const exitTimers = new Map<number, number>()
const emit = () => { for (const listener of listeners) listener() }

function removeNotification(id: number): void {
  window.clearTimeout(dismissTimers.get(id))
  window.clearTimeout(exitTimers.get(id))
  dismissTimers.delete(id)
  exitTimers.delete(id)
  if (!items.some(item => item.id === id)) return
  items = items.filter(item => item.id !== id)
  emit()
}

export function dismissNotification(id: number): void {
  const item = items.find(item => item.id === id)
  if (!item || item.exiting) return
  window.clearTimeout(dismissTimers.get(id))
  dismissTimers.delete(id)
  const durationToken = getComputedStyle(document.documentElement).getPropertyValue('--motion-base').trim()
  const duration = parseFloat(durationToken) * (durationToken.endsWith('ms') ? 1 : 1000)
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || duration === 0) {
    removeNotification(id)
    return
  }
  items = items.map(item => item.id === id ? { ...item, exiting: true } : item)
  // Transition events finish the exit; this also releases notifications when the shell is unmounted.
  exitTimers.set(id, window.setTimeout(() => removeNotification(id), duration + 50))
  emit()
}

/** Show a transient workspace notification. Errors stay until dismissed; others close after 5 seconds. */
export function notify(input: NotificationInput): number {
  const id = nextId++
  // Overflow is evicted immediately, including timers, rather than accumulating exiting toasts.
  while (items.length >= 4) removeNotification(items[0].id)
  items = [...items, { ...input, id }]
  emit()
  if (input.tone !== 'error') dismissTimers.set(id, window.setTimeout(() => dismissNotification(id), 5000))
  return id
}

const icons = { info: Info, success: CheckCircle2, error: CircleAlert }

function NotificationToast({ item }: { item: Notification }) {
  const [entered, setEntered] = useState(false)
  useLayoutEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setEntered(true)
      return
    }
    let secondFrame = 0
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => setEntered(true))
    })
    return () => {
      cancelAnimationFrame(firstFrame)
      cancelAnimationFrame(secondFrame)
    }
  }, [])
  const tone = item.tone ?? 'info'
  const Icon = icons[tone]
  return <div
    className="notification-slot pointer-events-auto"
    data-state={item.exiting ? 'exiting' : entered ? 'visible' : 'entering'}
    onTransitionEnd={event => {
      if (item.exiting && event.target === event.currentTarget && event.propertyName === 'grid-template-rows') removeNotification(item.id)
    }}
  >
    <div className="notification-clip"><div className="notification-padding">
      <div role={tone === 'error' ? 'alert' : 'status'} className="flex items-start gap-2 rounded-lg border bg-popover px-3 py-2 text-label-13 text-popover-foreground shadow-lg">
        <Icon className={cn('mt-0.5 size-4 shrink-0', tone === 'error' ? 'text-destructive' : tone === 'success' ? 'text-primary' : 'text-muted-foreground')} />
        <div className="min-w-0 flex-1 space-y-1"><p className="font-medium">{item.title}</p>{item.description && <p className="text-xs text-muted-foreground">{item.description}</p>}{item.action && <Link className="text-xs underline underline-offset-4" href={item.action.href} onClick={() => dismissNotification(item.id)}>{item.action.label}</Link>}</div>
        <button type="button" aria-label="알림 닫기" className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => dismissNotification(item.id)}><X className="size-3.5" /></button>
      </div>
    </div></div>
  </div>
}

/** Rendered once by the workspace shell. */
export function Notifications() {
  const current = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => items, () => items)
  return <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-10 z-50 flex w-[min(360px,calc(100vw-2rem))] flex-col">
    {current.map(item => <NotificationToast key={item.id} item={item} />)}
  </div>
}
