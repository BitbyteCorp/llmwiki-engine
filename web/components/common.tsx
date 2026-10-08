import type { ReactNode } from 'react'
import { AlertCircle, LoaderCircle, Files } from 'lucide-react'

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return <header className="flex flex-col gap-2 border-b pb-2 sm:flex-row sm:items-end sm:justify-between"><div className="min-w-0 space-y-0.5"><h1 className="break-words text-base font-semibold leading-6">{title}</h1>{description && <p className="text-xs text-muted-foreground">{description}</p>}</div>{actions && <div className="flex shrink-0 flex-wrap items-center gap-1.5">{actions}</div>}</header>
}
export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null
  return <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-label-13 text-destructive"><AlertCircle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" /><span className="min-w-0 break-words">{error instanceof Error ? error.message : String(error)}</span></div>
}
export function Loading({ label = '불러오는 중이다.' }: { label?: string }) {
  return <div role="status" className="flex items-center gap-2 py-3 text-label-13 text-muted-foreground"><LoaderCircle aria-hidden="true" className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" /><span className="min-w-0 break-words">{label}</span></div>
}
export function EmptyState({ title, description }: { title: string; description?: string }) {
  return <div className="flex flex-col items-center gap-1.5 px-3 py-6 text-center"><Files aria-hidden="true" className="size-5 text-muted-foreground" /><h2 className="text-label-13 font-semibold">{title}</h2>{description && <p className="max-w-md text-xs text-muted-foreground">{description}</p>}</div>
}
export const noteHref = (path: string) => `/wiki/${path.split('/').map(encodeURIComponent).join('/')}`
export function formatDate(iso: string | null) { return iso ? new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) : '—' }
