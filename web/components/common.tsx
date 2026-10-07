import type { ReactNode } from 'react'
import { AlertCircle, LoaderCircle, Files } from 'lucide-react'

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0 space-y-1"><h1 className="text-heading-20 sm:text-heading-24">{title}</h1>{description && <p className="text-copy-14 text-muted-foreground">{description}</p>}</div>{actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}</header>
}
export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null
  return <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive"><AlertCircle className="mt-0.5 size-4 shrink-0" /><span>{error instanceof Error ? error.message : String(error)}</span></div>
}
export function Loading({ label = '불러오는 중이다.' }: { label?: string }) {
  return <div role="status" className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />{label}</div>
}
export function EmptyState({ title, description }: { title: string; description?: string }) {
  return <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-12 text-center"><Files className="mb-1 size-6 text-muted-foreground" /><h2 className="text-sm font-semibold">{title}</h2>{description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}</div>
}
export const noteHref = (path: string) => `/wiki/${path.split('/').map(encodeURIComponent).join('/')}`
export function formatDate(iso: string | null) { return iso ? new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) : '—' }
