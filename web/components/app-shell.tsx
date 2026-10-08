'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { usePathname, useSearchParams } from 'next/navigation'
import { BookOpen } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { ErrorNotice, Loading } from '@/components/common'
import { WorkspaceProvider } from '@/components/workspace/context'
import { WorkspaceShell } from '@/components/workspace/shell'

export function LoginPage() {
  const pathname = usePathname()
  const params = useSearchParams()
  const next = pathname === '/login' ? (params.get('next') || '/wiki') : pathname + (params.size ? `?${params}` : '')
  const error = params.get('error')
  return <main className="flex min-h-dvh items-center justify-center bg-secondary px-4 py-12"><section className="w-full max-w-sm space-y-3 rounded-lg border bg-card p-4"><div className="flex items-center gap-2 text-sm font-semibold"><BookOpen aria-hidden="true" className="size-5" />LLM Wiki</div><div className="space-y-1"><h1 className="text-heading-20">지식과 대화를 연결한다.</h1><p className="text-copy-14 text-muted-foreground">팀의 위키를 탐색하고, 도니에게 질문한다.</p></div>{error && <ErrorNotice error={error} />}<Button size="lg" nativeButton={false} className="w-full" render={<a href={`/auth/google/login?next=${encodeURIComponent(next)}`} />}>Google로 로그인</Button><p className="text-xs leading-5 text-muted-foreground">등록된 계정으로 로그인한다. 접근 권한은 관리자에게 요청한다.</p></section></main>
}

export function AppShell({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false })
  const [expired, setExpired] = useState(false)
  useEffect(() => {
    const onExpired = () => { setExpired(true); queryClient.clear() }
    window.addEventListener('session-expired', onExpired)
    return () => window.removeEventListener('session-expired', onExpired)
  }, [queryClient])
  if (expired || (me.error instanceof ApiError && me.error.status === 401)) return <LoginPage />
  if (me.isPending) return <main className="flex min-h-dvh items-center justify-center bg-secondary px-4 py-12"><div className="w-full max-w-sm rounded-lg border bg-card p-4"><Loading /></div></main>
  if (me.error) return <main className="flex min-h-dvh items-center justify-center bg-secondary px-4 py-12"><div className="w-full max-w-sm space-y-3 rounded-lg border bg-card p-4"><ErrorNotice error={me.error} /><Button size="lg" variant="outline" onClick={() => void me.refetch()}>다시 시도</Button></div></main>
  return <WorkspaceProvider userId={me.data.user.id}><WorkspaceShell user={me.data.user}>{children}</WorkspaceShell></WorkspaceProvider>
}
