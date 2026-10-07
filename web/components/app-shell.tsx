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
  return <main className="flex min-h-dvh items-center justify-center bg-secondary px-6 py-16"><div className="w-full max-w-sm rounded-xl border bg-background p-8"><div className="mb-8 flex items-center gap-2 font-bold"><BookOpen className="size-5" />LLM Wiki</div><h1 className="text-heading-24">지식과 대화를 연결한다.</h1><p className="mt-2 mb-8 text-copy-14 text-muted-foreground">팀의 위키를 탐색하고, Luna에게 질문한다.</p>{error && <div className="mb-4"><ErrorNotice error={error} /></div>}<Button nativeButton={false} className="w-full" render={<a href={`/auth/google/login?next=${encodeURIComponent(next)}`} />}>Google로 로그인</Button><p className="mt-5 text-xs leading-5 text-muted-foreground">등록된 계정으로 로그인한다. 접근 권한은 관리자에게 요청한다.</p></div></main>
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const queryClient = useQueryClient()
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false })
  const [expired, setExpired] = useState(false)
  useEffect(() => {
    const onExpired = () => { setExpired(true); queryClient.clear() }
    window.addEventListener('session-expired', onExpired)
    return () => window.removeEventListener('session-expired', onExpired)
  }, [queryClient])
  if (expired || (me.error instanceof ApiError && me.error.status === 401)) return <LoginPage />
  if (me.isPending) return <div className="mx-auto max-w-lg px-6 py-20"><Loading /></div>
  if (me.error) return <main className="mx-auto max-w-lg space-y-4 px-6 py-20"><ErrorNotice error={me.error} /><Button variant="outline" onClick={() => void me.refetch()}>다시 시도</Button></main>
  return <WorkspaceProvider userId={me.data.user.id}><WorkspaceShell user={me.data.user}>{pathname.startsWith('/admin') && me.data.user.role !== 'admin' ? <ErrorNotice error="관리자만 접근할 수 있다." /> : children}</WorkspaceShell></WorkspaceProvider>
}
