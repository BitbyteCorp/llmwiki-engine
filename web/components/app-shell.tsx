'use client'

import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { usePathname, useSearchParams } from 'next/navigation'
import { BookOpen } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { passwordErrorMessage } from '@/lib/password'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ErrorNotice, SplashScreen } from '@/components/common'
import { WorkspaceProvider } from '@/components/workspace/context'
import { WorkspaceShell } from '@/components/workspace/shell'

export function LoginPage() {
  const pathname = usePathname()
  const params = useSearchParams()
  const next = pathname === '/login' ? (params.get('next') || '/wiki') : pathname + (params.size ? `?${params}` : '')
  const loginRequest = pathname === '/login' ? params.get('request') : null
  const callbackError = params.get('error')
  const providers = useQuery({ queryKey: ['auth-providers'], queryFn: api.providers })
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const login = useMutation({
    mutationFn: () => api.passwordLogin({ email: email.trim(), password, ...(loginRequest !== null ? { request: loginRequest } : { next }) }),
    onSuccess: ({ redirectTo }) => {
      setPassword('')
      window.location.assign(redirectTo)
    },
  })
  const googleHref = loginRequest !== null
    ? `/auth/google/login?request=${encodeURIComponent(loginRequest)}`
    : `/auth/google/login?next=${encodeURIComponent(next)}`
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    login.mutate()
  }
  return <main className="flex min-h-dvh items-center justify-center bg-secondary px-4 py-12">
    <section className="w-full max-w-sm space-y-5 rounded-lg border bg-card p-6" aria-labelledby="login-heading">
      <div className="flex items-center gap-2 text-sm font-semibold"><BookOpen aria-hidden="true" className="size-5" />LLM Wiki</div>
      <div className="space-y-1"><h1 id="login-heading" className="text-heading-20">로그인</h1><p className="text-copy-14 text-muted-foreground">계정 정보를 입력하세요.</p></div>
      {callbackError && <ErrorNotice error={passwordErrorMessage(callbackError)} />}
      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2"><Label htmlFor="login-email">이메일</Label><Input id="login-email" type="email" autoComplete="username" required placeholder="name@example.com" value={email} onChange={event => { setEmail(event.target.value); login.reset() }} disabled={login.isPending} /></div>
        <div className="space-y-2"><Label htmlFor="login-password">비밀번호</Label><Input id="login-password" type="password" autoComplete="current-password" required value={password} onChange={event => { setPassword(event.target.value); login.reset() }} disabled={login.isPending} /></div>
        {login.error && <ErrorNotice error={passwordErrorMessage(login.error)} />}
        <Button type="submit" size="lg" className="w-full" disabled={login.isPending}>{login.isPending ? '로그인 중…' : '계속'}</Button>
      </form>
      {providers.data?.google && <>
        <div className="flex items-center gap-3 text-xs text-muted-foreground"><span className="h-px flex-1 bg-border" /><span>또는</span><span className="h-px flex-1 bg-border" /></div>
        <Button size="lg" variant="outline" nativeButton={false} className="w-full" render={<a href={googleHref} />}>Google로 로그인</Button>
      </>}
      {providers.error && <div className="space-y-2"><ErrorNotice error={passwordErrorMessage(providers.error)} /><Button type="button" variant="outline" disabled={providers.isFetching} onClick={() => void providers.refetch()}>로그인 방법 다시 불러오기</Button></div>}
      <p className="text-xs leading-5 text-muted-foreground">계정은 관리자가 발급합니다. 계정과 접근 권한은 관리자에게 문의하세요.</p>
    </section>
  </main>
}

const PublicUrlContext = createContext<string | undefined>(undefined)

export function usePublicUrl() {
  return useContext(PublicUrlContext)
}

export function AppShell({ children, publicUrl }: { children: ReactNode; publicUrl?: string }) {
  const queryClient = useQueryClient()
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false })
  const [expired, setExpired] = useState(false)
  useEffect(() => {
    const onExpired = () => { setExpired(true); queryClient.clear() }
    window.addEventListener('session-expired', onExpired)
    return () => window.removeEventListener('session-expired', onExpired)
  }, [queryClient])
  if (expired || (me.error instanceof ApiError && me.error.status === 401)) return <LoginPage />
  if (me.isPending) return <SplashScreen />
  if (me.error) return <main className="flex min-h-dvh items-center justify-center bg-secondary px-4 py-12"><div className="w-full max-w-sm space-y-3 rounded-lg border bg-card p-4"><ErrorNotice error={me.error} /><Button size="lg" variant="outline" onClick={() => void me.refetch()}>다시 시도</Button></div></main>
  return <PublicUrlContext value={publicUrl}><WorkspaceProvider userId={me.data.user.id}><WorkspaceShell user={me.data.user}>{children}</WorkspaceShell></WorkspaceProvider></PublicUrlContext>
}
