import type { ComponentProps, ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

/** VS Code-style collapsible view header shared by sidebar panels. */
export function ViewHeader({ title, open, onToggle, actions, className, ...props }: { title: ReactNode; open: boolean; onToggle: () => void; actions?: ReactNode } & Omit<ComponentProps<'div'>, 'title'>) {
  return <div {...props} className={cn('flex h-6 shrink-0 items-center pr-1', className)}><button type="button" aria-expanded={open} className="flex h-full min-w-0 flex-1 items-center gap-1 px-1 text-left text-[11px] font-bold tracking-wide text-muted-foreground hover:text-foreground" onClick={onToggle}><ChevronRight aria-hidden="true" className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} /><span className="truncate">{title}</span></button>{actions}</div>
}
