import type { ReactNode } from 'react'
import { AlertCircle, BookOpen, LoaderCircle, Files } from 'lucide-react'

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return <header className="flex flex-col gap-2 border-b pb-2 sm:flex-row sm:items-end sm:justify-between"><div className="min-w-0 space-y-0.5"><h1 className="break-words text-base font-semibold leading-6">{title}</h1>{description && <p className="text-xs text-muted-foreground">{description}</p>}</div>{actions && <div className="flex shrink-0 flex-wrap items-center gap-1.5">{actions}</div>}</header>
}
export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null
  return <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-label-13 text-destructive"><AlertCircle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" /><span className="min-w-0 break-words">{error instanceof Error ? error.message : String(error)}</span></div>
}
export function Loading({ label = '불러오는 중…' }: { label?: string }) {
  return <div role="status" className="flex items-center gap-2 py-3 text-label-13 text-muted-foreground"><LoaderCircle aria-hidden="true" className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" /><span className="min-w-0 break-words">{label}</span></div>
}
export function SplashScreen({ label = '작업 공간을 준비하는 중' }: { label?: string }) {
  return (
    <main className="flex min-h-dvh items-center justify-center overflow-hidden bg-background px-6 py-12">
      <div role="status" aria-live="polite" className="splash-enter relative flex max-w-sm flex-col items-center text-center">
        <div aria-hidden="true" className="splash-glow absolute left-1/2 top-6 -translate-x-1/2 -translate-y-1/2" />
        <div aria-hidden="true" className="relative flex flex-col items-center gap-4">
          <div className="relative flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <span className="splash-pulse absolute inset-0 rounded-xl border border-primary/15" />
            <BookOpen className="size-6" strokeWidth={1.75} />
          </div>
          <span className="text-sm font-semibold tracking-tight">LLM Wiki</span>
          <div className="mt-3 h-1 w-40 overflow-hidden rounded-full bg-muted">
            <div className="splash-bar h-full w-1/3 rounded-full bg-primary/75" />
          </div>
        </div>
        <p className="relative mt-4 text-xs leading-5 text-muted-foreground">{label}</p>
      </div>
    </main>
  )
}
export function EmptyState({ title, description }: { title: string; description?: string }) {
  return <div className="flex flex-col items-center gap-1.5 px-3 py-6 text-center"><Files aria-hidden="true" className="size-5 text-muted-foreground" /><h2 className="text-label-13 font-semibold">{title}</h2>{description && <p className="max-w-md text-xs text-muted-foreground">{description}</p>}</div>
}
export const noteHref = (path: string) => `/wiki/${path.split('/').map(encodeURIComponent).join('/')}`
export function formatDate(iso: string | null) { return iso ? new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) : '—' }
