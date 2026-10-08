'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useQuery } from '@tanstack/react-query'
import { useTheme } from 'next-themes'
import { Laptop, Moon, Sun, UserRound } from 'lucide-react'
import { api, type Role } from '@/lib/api'
import { EmptyState, ErrorNotice, Loading, PageHeader, formatDate } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { TokenSettings } from '@/components/admin/token-settings'
import { ExportPanel } from '@/components/admin/export-panel'
import { OpsOverview } from '@/components/admin/ops-overview'
import { AuditLog } from '@/components/admin/audit-log'
import { AclRules } from '@/components/admin/acl-rules'
import { McpHelp } from '@/components/admin/mcp-help'
import { UsersAndSettings } from './admin'

const roleLabels: Record<Role, string> = { admin: '관리자', editor: '편집자', viewer: '조회자' }
const themeOptions = [{ value: 'system', label: '시스템', icon: Laptop }, { value: 'light', label: '밝게', icon: Sun }, { value: 'dark', label: '어둡게', icon: Moon }] as const
const personalTabs = [{ id: 'account', label: '내 계정' }, { id: 'appearance', label: '화면 테마' }, { id: 'tokens', label: 'API 토큰' }, { id: 'mcp', label: 'MCP · Skill' }, { id: 'export', label: '내보내기' }] as const
const adminTabs = [{ id: 'ops', label: '운영 현황' }, { id: 'users', label: '사용자' }, { id: 'login', label: '로그인 설정' }, { id: 'acl', label: '접근 권한' }, { id: 'audit', label: '감사 로그' }] as const

export function SettingsPage({ publicUrl }: { publicUrl?: string }) {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  const router = useRouter()
  const params = useSearchParams()
  const layout = useRef<HTMLDivElement>(null)
  const [desktop, setDesktop] = useState(false)
  useEffect(() => {
    const element = layout.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setDesktop(entry.contentRect.width >= 720))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const requested = params.get('tab')
  const tab = [...personalTabs, ...adminTabs].find(item => item.id === requested)?.id ?? 'account'
  const isAdmin = me.data?.user.role === 'admin'
  const denied = adminTabs.some(item => item.id === tab) && !isAdmin
  const tabs = isAdmin ? [...personalTabs, ...adminTabs] : [...personalTabs]
  function selectTab(next: string) {
    const query = new URLSearchParams(params.toString())
    query.delete('section')
    query.set('tab', next)
    router.replace(`/settings?${query}`, { scroll: false })
  }
  return <div ref={layout} className="@container/settings-layout min-w-0 space-y-4">
    <PageHeader title="설정" description="개인 설정과 관리 기능을 한곳에서 확인합니다." />
    {me.isPending && <Loading label="계정 정보를 불러오는 중…" />}
    {me.error && <div className="space-y-3"><ErrorNotice error={me.error} /><Button variant="outline" disabled={me.isFetching} onClick={() => void me.refetch()}>계정 정보 다시 불러오기</Button></div>}
    {me.data && <div className="grid min-w-0 gap-4 @[720px]/settings-layout:grid-cols-[180px_minmax(0,1fr)]">
      <div role="tablist" aria-label="설정" aria-orientation={desktop ? 'vertical' : 'horizontal'} className="flex min-w-0 gap-1 overflow-x-auto border-b pb-2 @[720px]/settings-layout:flex-col @[720px]/settings-layout:self-start @[720px]/settings-layout:border-b-0 @[720px]/settings-layout:border-r @[720px]/settings-layout:pr-3">
        {tabs.map((item, index) => <div key={item.id} role="presentation" className="shrink-0">
          {(index === 0 || item.id === 'ops') && <span className="hidden px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground @[720px]/settings-layout:block">{index === 0 ? '개인' : '관리'}</span>}
          <button type="button" role="tab" id={`settings-tab-${item.id}`} aria-selected={tab === item.id} aria-controls={`settings-panel-${item.id}`} tabIndex={tab === item.id || (denied && index === 0) ? 0 : -1} className={`h-7 w-full whitespace-nowrap rounded-sm px-2 text-left text-label-13 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${tab === item.id ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}`} onClick={() => selectTab(item.id)} onKeyDown={event => {
            const forward = desktop ? 'ArrowDown' : 'ArrowRight'
            const backward = desktop ? 'ArrowUp' : 'ArrowLeft'
            const nextIndex = event.key === forward ? (index + 1) % tabs.length : event.key === backward ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null
            if (nextIndex === null) return
            event.preventDefault()
            const next = tabs[nextIndex]!
            const target = document.getElementById(`settings-tab-${next.id}`)
            target?.focus({ preventScroll: true })
            target?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
            selectTab(next.id)
          }}>{item.label}</button>
        </div>)}
      </div>
      <div role="tabpanel" id={`settings-panel-${tab}`} aria-labelledby={denied ? undefined : `settings-tab-${tab}`} aria-label={denied ? '관리자 권한 필요' : undefined} tabIndex={0} className="@container/settings-panel min-w-0 space-y-4 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {denied ? <EmptyState title="관리자 권한이 필요합니다" description="이 설정은 관리자만 확인하거나 변경할 수 있습니다." /> : <>
          {tab === 'account' && <section aria-labelledby="account-heading" className="space-y-2"><h2 id="account-heading" className="flex h-7 items-center gap-1.5 border-b text-label-13 font-semibold"><UserRound className="size-3.5" />내 계정</h2><div className="flex flex-wrap items-center gap-2 text-label-13"><p className="break-all font-medium">{me.data.user.name || me.data.user.email}</p><Badge variant="secondary">{roleLabels[me.data.user.role]}</Badge></div><dl className="grid gap-x-6 gap-y-1.5 text-label-13 @2xl/settings-panel:grid-cols-2"><div className="space-y-1"><dt className="text-xs text-muted-foreground">이메일</dt><dd className="break-all">{me.data.user.email}</dd></div><div className="space-y-1"><dt className="text-xs text-muted-foreground">가입일</dt><dd>{formatDate(me.data.user.createdAt)}</dd></div></dl></section>}
          {tab === 'appearance' && <AppearanceSettings />}
          {tab === 'tokens' && <TokenSettings user={me.data.user} />}
          {tab === 'mcp' && <McpHelp publicUrl={publicUrl} />}
          {tab === 'export' && <ExportPanel />}
          {tab === 'ops' && <OpsOverview />}
          {tab === 'users' && <UsersAndSettings key="users" currentUser={me.data.user} tab="users" />}
          {tab === 'login' && <UsersAndSettings key="login" currentUser={me.data.user} tab="login" />}
          {tab === 'acl' && <AclRules />}
          {tab === 'audit' && <AuditLog />}
        </>}
      </div>
    </div>}
  </div>
}

function AppearanceSettings() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  return <section aria-labelledby="appearance-heading" className="space-y-2"><h2 id="appearance-heading" className="flex h-7 items-center gap-1.5 border-b text-label-13 font-semibold">화면 테마</h2><fieldset><legend className="sr-only">화면 테마 선택</legend><div className="grid gap-2 @2xl/settings-panel:grid-cols-3">{themeOptions.map(({ value, label, icon: Icon }) => <label key={value} className={`flex cursor-pointer items-center gap-2 border-y px-2 py-1.5 hover:bg-accent ${mounted && theme === value ? 'border-primary bg-primary/5' : ''}`}><input type="radio" name="settings-theme" value={value} checked={mounted && theme === value} disabled={!mounted} onChange={() => setTheme(value)} className="size-4 accent-primary" /><Icon className="size-3.5" /><span className="text-label-13 font-medium">{label}</span></label>)}</div></fieldset><p className="text-xs text-muted-foreground">선택한 테마는 이 브라우저에 저장됩니다.</p></section>
}
