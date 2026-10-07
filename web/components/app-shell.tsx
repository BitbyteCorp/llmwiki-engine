'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { BookOpen, Search, MessagesSquare, History, Settings, LogOut, ChevronDown, Menu, X } from 'lucide-react'
import { api, ApiError, type User } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { ErrorNotice, Loading } from '@/components/common'
import { cn } from '@/lib/utils'

const navigation = [
  { to: '/wiki', label: '위키', icon: BookOpen },
  { to: '/search', label: '검색', icon: Search },
  { to: '/chat', label: '질문하기', icon: MessagesSquare },
  { to: '/history', label: '변경 이력', icon: History },
  { to: '/admin', label: '관리', icon: Settings },
]
const roleLabels = { admin: '관리자', editor: '편집자', viewer: '조회자' }

export function LoginPage() {
  const pathname = usePathname()
  const params = useSearchParams()
  const next = pathname === '/login' ? (params.get('next') || '/wiki') : pathname + (params.size ? `?${params}` : '')
  const error = params.get('error')
  return <main className="flex min-h-dvh items-center justify-center bg-[#fafafa] px-6 py-16"><div className="w-full max-w-sm rounded-xl border bg-background p-8"><div className="mb-8 flex items-center gap-2 font-bold"><BookOpen className="size-5" />LLM Wiki</div><h1 className="text-heading-24">지식과 대화를 연결한다.</h1><p className="mt-2 mb-8 text-copy-14 text-muted-foreground">팀의 위키를 탐색하고, Luna에게 질문한다.</p>{error && <div className="mb-4"><ErrorNotice error={error} /></div>}<Button nativeButton={false} className="w-full" render={<a href={`/auth/google/login?next=${encodeURIComponent(next)}`} />}>Google로 로그인</Button><p className="mt-5 text-xs leading-5 text-muted-foreground">등록된 계정으로 로그인한다. 접근 권한은 관리자에게 요청한다.</p></div></main>
}

function Shell({ user, children }: { user: User; children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const [logoutError, setLogoutError] = useState<unknown>(null)
  const [loggingOut, setLoggingOut] = useState(false)
  const pathname = usePathname()
  const queryClient = useQueryClient()
  const items = navigation.filter(item => item.to !== '/admin' || user.role === 'admin')
  const current = navigation.find(item => pathname.startsWith(item.to))?.label ?? '변경 상세'
  useEffect(() => { setMobileOpen(false) }, [pathname])
  async function logout() {
    setLoggingOut(true)
    try { await api.logout(); queryClient.clear(); window.location.assign('/') }
    catch (error) { setLogoutError(error); setLoggingOut(false) }
  }
  return <div className="min-h-dvh bg-background">
    <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:z-50 focus:bg-background focus:p-3">본문으로 이동</a>
    {mobileOpen && <button aria-label="메뉴 닫기" className="fixed inset-0 z-30 bg-black/20 md:hidden" onClick={() => setMobileOpen(false)} />}
    <aside className={cn('fixed inset-y-0 left-0 z-40 w-56 flex-col border-r bg-[#fafafa] md:flex', mobileOpen ? 'flex' : 'hidden')}>
      <div className="flex h-16 items-center justify-between border-b px-5"><Link href="/wiki" className="inline-flex items-center gap-2 text-base font-bold tracking-tight"><BookOpen className="size-5" />LLM Wiki</Link><Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="메뉴 닫기" onClick={() => setMobileOpen(false)}><X /></Button></div>
      <div className="px-5 pt-6 pb-3 text-xs font-bold text-muted-foreground">지식 저장소</div>
      <nav aria-label="주요 메뉴" className="space-y-1 px-3">{items.map(({ to, label, icon: Icon }) => <Link key={to} href={to} aria-current={pathname.startsWith(to) ? 'page' : undefined} className={cn('flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground', pathname.startsWith(to) && 'bg-muted font-bold text-foreground')}><Icon className="size-4" />{label}</Link>)}</nav>
      <div className="mt-auto border-t p-5 text-xs leading-5 text-muted-foreground">Luna와 함께 쌓는 팀의 지식이다.<br /><span className="font-mono text-[11px]">main · knowledge repository</span></div>
    </aside>
    <div className="md:pl-56"><header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur-xl"><div className="mx-auto flex h-16 max-w-[1200px] items-center gap-3 px-4 sm:px-6"><Button variant="ghost" size="icon-sm" aria-label="메뉴 열기" className="md:hidden" onClick={() => setMobileOpen(true)}><Menu /></Button><span className="text-sm text-muted-foreground">콘솔</span><span className="text-muted-foreground/50">/</span><span className="text-sm">{current}</span><div className="ml-auto"><DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" className="gap-2 px-2" aria-label="사용자 메뉴" />}><span className="flex size-7 items-center justify-center rounded-full border bg-muted text-xs font-bold">{(user.name || user.email).slice(0, 1).toUpperCase()}</span><span className="hidden max-w-40 truncate text-sm sm:block">{user.name || user.email}</span><ChevronDown className="size-3.5 text-muted-foreground" /></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-60"><DropdownMenuGroup><DropdownMenuLabel><span className="block truncate">{user.email}</span><span className="text-xs font-normal text-muted-foreground">{roleLabels[user.role]}</span></DropdownMenuLabel><DropdownMenuSeparator /><DropdownMenuItem disabled={loggingOut} onClick={() => void logout()}><LogOut className="size-4" />로그아웃</DropdownMenuItem></DropdownMenuGroup></DropdownMenuContent></DropdownMenu></div></div></header>
      <main id="main" className="mx-auto w-full max-w-[1200px] px-4 py-8 sm:px-6 lg:py-10">{Boolean(logoutError) && <div className="mb-6"><ErrorNotice error={logoutError} /></div>}{children}</main>
    </div>
  </div>
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
  return <Shell user={me.data.user}>{pathname === '/admin' && me.data.user.role !== 'admin' ? <ErrorNotice error="관리자만 접근할 수 있다." /> : children}</Shell>
}
