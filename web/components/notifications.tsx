'use client'

import Link from 'next/link'
import { useSyncExternalStore } from 'react'
import { CheckCircle2, CircleAlert, Info, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export type NotificationTone = 'info' | 'success' | 'error'
export interface NotificationInput { title: string; description?: string; tone?: NotificationTone; action?: { label: string; href: string } }
interface Notification extends NotificationInput { id: number }

let items: Notification[] = []
let nextId = 1
const listeners = new Set<() => void>()
const emit = () => { for (const listener of listeners) listener() }

export function dismissNotification(id: number): void {
  items = items.filter(item => item.id !== id)
  emit()
}

/** Show a transient workspace notification. Errors stay until dismissed; others close after 5 seconds. */
export function notify(input: NotificationInput): number {
  const id = nextId++
  items = [...items.slice(-3), { ...input, id }]
  emit()
  if (input.tone !== 'error') window.setTimeout(() => dismissNotification(id), 5000)
  return id
}

const icons = { info: Info, success: CheckCircle2, error: CircleAlert }

/** Rendered once by the workspace shell. */
export function Notifications() {
  const current = useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => items, () => items)
  return <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-10 z-50 flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2">
    {current.map(item => {
      const tone = item.tone ?? 'info'
      const Icon = icons[tone]
      return <div key={item.id} role={tone === 'error' ? 'alert' : 'status'} className="pointer-events-auto flex items-start gap-3 rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-lg">
        <Icon className={cn('mt-0.5 size-4 shrink-0', tone === 'error' ? 'text-destructive' : tone === 'success' ? 'text-primary' : 'text-muted-foreground')} />
        <div className="min-w-0 flex-1 space-y-1"><p className="font-medium">{item.title}</p>{item.description && <p className="text-xs text-muted-foreground">{item.description}</p>}{item.action && <Link className="text-xs underline underline-offset-4" href={item.action.href} onClick={() => dismissNotification(item.id)}>{item.action.label}</Link>}</div>
        <button type="button" aria-label="알림 닫기" className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => dismissNotification(item.id)}><X className="size-3.5" /></button>
      </div>
    })}
  </div>
}
