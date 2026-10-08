'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function ImportModal({ title, description, children, onClose, busy = false, drawer = false }: { title: string; description?: string; children: ReactNode; onClose: () => void; busy?: boolean; drawer?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const element = dialog.current
    element?.showModal()
    return () => { element?.close(); previousFocus?.focus() }
  }, [])
  return <dialog ref={dialog} aria-labelledby="import-modal-title" aria-describedby={description ? 'import-modal-description' : undefined} onCancel={(event) => { event.preventDefault(); if (!busy) onClose() }} className={drawer ? 'fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-dvh w-full max-w-xl overflow-y-auto border-l bg-card p-0 text-foreground shadow-lg backdrop:bg-background/80' : 'm-auto max-h-[calc(100dvh-2rem)] w-[min(42rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border bg-card p-0 text-foreground shadow-lg backdrop:bg-background/80'}>
    <header className="sticky top-0 z-10 flex items-start justify-between gap-2 border-b bg-card p-4">
      <div><h2 id="import-modal-title" className="flex h-7 items-center gap-1.5 text-label-13 font-semibold">{title}</h2>{description && <p id="import-modal-description" className="mt-1 text-label-13 text-muted-foreground">{description}</p>}</div>
      <Button variant="ghost" size="icon" autoFocus disabled={busy} aria-label="닫기" onClick={onClose}><X className="size-3.5" /></Button>
    </header>
    <div className="p-4">{children}</div>
  </dialog>
}
