'use client'

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTheme } from 'next-themes'
import { Copy, ExternalLink, Laptop, Moon, Plug, Sun, UserRound } from 'lucide-react'
import { api, type Role } from '@/lib/api'
import { ErrorNotice, Loading, PageHeader, formatDate } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { TokenSettings } from '@/components/admin/token-settings'
import { ExportPanel } from '@/components/admin/export-panel'

const roleLabels: Record<Role, string> = { admin: '관리자', editor: '편집자', viewer: '뷰어' }
const themeOptions = [{ value: 'system', label: '시스템', icon: Laptop }, { value: 'light', label: '밝게', icon: Sun }, { value: 'dark', label: '어둡게', icon: Moon }] as const
const skillDocsUrl = 'https://github.com/BitbyteCorp/llmwiki-engine/blob/HEAD/docs/skills.md'
type SkillClient = 'claude-code' | 'codex' | 'hermes'

export function SettingsPage({ publicUrl, section }: { publicUrl?: string; section?: string }) {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me })
  useEffect(() => {
    if (!me.data || (section !== 'tokens' && section !== 'export')) return
    const element = document.getElementById(section)
    element?.scrollIntoView({ block: 'start' })
    element?.focus({ preventScroll: true })
  }, [section, me.data])

  return <div className="mx-auto max-w-4xl space-y-6 pb-8">
    <PageHeader title="설정" description="계정, 화면 테마, 외부 도구 연결과 지식 내보내기를 관리합니다." />
    <nav aria-label="설정 섹션" className="flex flex-wrap gap-2 text-sm"><a href="#profile" className="rounded-md border px-3 py-2 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">내 계정</a><a href="#appearance" className="rounded-md border px-3 py-2 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">테마</a><a href="#tokens" className="rounded-md border px-3 py-2 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">API 토큰</a><a href="#mcp" className="rounded-md border px-3 py-2 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">MCP · Skill</a><a href="#export" className="rounded-md border px-3 py-2 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">내보내기</a></nav>
    {me.isPending && <Loading label="내 계정 정보를 불러오는 중…" />}
    {me.error && <div className="space-y-3"><ErrorNotice error={me.error} /><Button variant="outline" disabled={me.isFetching} onClick={() => void me.refetch()}>계정 정보 다시 불러오기</Button></div>}
    {me.data && <>
      <section id="profile" tabIndex={-1} aria-labelledby="profile-heading" className="scroll-mt-6 space-y-4 rounded-xl border bg-card p-4 sm:p-6"><h2 id="profile-heading" className="flex items-center gap-2 text-lg font-semibold"><UserRound className="size-5" />내 계정</h2><div className="flex flex-wrap items-center gap-2"><p className="break-all font-medium">{me.data.user.name || me.data.user.email}</p><Badge variant="secondary">{roleLabels[me.data.user.role]}</Badge></div><dl className="grid gap-4 text-sm sm:grid-cols-2"><div className="space-y-1"><dt className="text-muted-foreground">이메일</dt><dd className="break-all">{me.data.user.email}</dd></div><div className="space-y-1"><dt className="text-muted-foreground">가입일</dt><dd>{formatDate(me.data.user.createdAt)}</dd></div><div className="space-y-1"><dt className="text-muted-foreground">최근 로그인</dt><dd>{formatDate(me.data.user.lastLoginAt)}</dd></div></dl><p className="text-xs text-muted-foreground">이름과 역할 변경은 관리자에게 요청하세요.</p></section>
      <AppearanceSettings />
      <TokenSettings user={me.data.user} />
      <McpHelp publicUrl={publicUrl} />
      <ExportPanel />
    </>}
  </div>
}

function AppearanceSettings() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  return <section id="appearance" tabIndex={-1} aria-labelledby="appearance-heading" className="scroll-mt-6 space-y-4 rounded-xl border bg-card p-4 sm:p-6"><h2 id="appearance-heading" className="text-lg font-semibold">화면 테마</h2><fieldset><legend className="sr-only">화면 테마 선택</legend><div className="grid grid-cols-1 gap-3 sm:grid-cols-3">{themeOptions.map(({ value, label, icon: Icon }) => <label key={value} className={`flex cursor-pointer items-center gap-3 rounded-lg border p-4 transition-colors hover:bg-muted/50 ${mounted && theme === value ? 'border-primary bg-primary/5' : ''}`}><input type="radio" name="settings-theme" value={value} checked={mounted && theme === value} disabled={!mounted} onChange={() => setTheme(value)} className="size-4 accent-primary" /><Icon className="size-5 text-muted-foreground" /><span className="text-sm font-medium">{label}</span></label>)}</div></fieldset><p className="text-xs text-muted-foreground">테마는 이 브라우저에 저장됩니다. 시스템을 선택하면 기기의 밝기 설정을 따릅니다.</p></section>
}

function McpHelp({ publicUrl }: { publicUrl?: string }) {
  const [browserOrigin, setBrowserOrigin] = useState('')
  const [client, setClient] = useState<SkillClient>('claude-code')
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<unknown>(null)
  useEffect(() => { if (!publicUrl) setBrowserOrigin(window.location.origin) }, [publicUrl])
  const base = publicUrl || browserOrigin
  const mcpUrl = base ? `${base.replace(/\/+$/, '')}/mcp` : ''
  const shellUrl = `'${mcpUrl.replace(/'/g, "'\\''")}'`
  const connection = client === 'claude-code' ? `claude mcp add --transport http --scope user llmwiki ${shellUrl}` : client === 'codex' ? `[mcp_servers.llmwiki]\nurl = ${JSON.stringify(mcpUrl)}` : `mcp_servers:\n  llmwiki:\n    url: ${JSON.stringify(mcpUrl)}\n    auth: oauth`

  async function copyUrl() {
    setCopyError(null)
    try { await navigator.clipboard.writeText(mcpUrl); setCopied(true) }
    catch { setCopyError(new Error('주소를 복사하지 못했습니다. 아래 주소를 직접 선택해 복사해 주세요.')) }
  }

  return <section id="mcp" tabIndex={-1} aria-labelledby="mcp-heading" className="scroll-mt-6 space-y-5 rounded-xl border bg-card p-4 sm:p-6">
    <div><h2 id="mcp-heading" className="flex items-center gap-2 text-lg font-semibold"><Plug className="size-5" />MCP · llmwiki Skill 연결</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">Claude Code, Codex, Hermes에서 지식을 검색하고 활용하세요. Skill 설치와 서버 연결·OAuth 로그인은 별도 단계입니다.</p></div>
    <div className="space-y-2"><Label>MCP 서버 주소</Label>{mcpUrl ? <div className="flex flex-col gap-2 sm:flex-row sm:items-start"><code tabIndex={0} className="min-w-0 flex-1 select-all break-all rounded-lg bg-muted/60 p-3 text-xs">{mcpUrl}</code><Button variant="outline" onClick={() => void copyUrl()}><Copy />{copied ? '복사됨' : '주소 복사'}</Button></div> : <Loading label="서버 주소를 확인하는 중…" />}<p className="text-xs text-muted-foreground">{publicUrl ? '서버의 PUBLIC_URL 설정을 사용합니다.' : '서버의 PUBLIC_URL이 없으므로 현재 브라우저 주소를 사용합니다.'} REST API 토큰이 아닌 브라우저 OAuth로 로그인하세요.</p><ErrorNotice error={copyError} />{copied && <p role="status" className="sr-only">MCP 서버 주소를 복사했습니다.</p>}</div>
    <div className="space-y-2"><Label htmlFor="skill-client">클라이언트</Label><select id="skill-client" value={client} onChange={(event) => setClient(event.target.value as SkillClient)} className="h-9 w-full rounded-md border bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring sm:w-auto"><option value="claude-code">Claude Code</option><option value="codex">Codex</option><option value="hermes">Hermes</option></select></div>
    <ol className="space-y-5 text-sm leading-6">
      <li className="space-y-2"><h3 className="font-medium">1. llmwiki Skill 설치</h3><p className="text-muted-foreground">llmwiki CLI가 설치된 터미널에서 실행하세요. 개발 저장소에서는 llmwiki 대신 pnpm cli를 사용합니다.</p><pre className="overflow-x-auto rounded-lg bg-muted/60 p-3 text-xs"><code>{`llmwiki skill install ${client}\nllmwiki skill status ${client}\nllmwiki skill update ${client}`}</code></pre><p className="text-xs text-muted-foreground">프로젝트에 설치하려면 install에 --project /path/to/project를 추가하세요. 기존 설정과 비밀값은 자동으로 변경되지 않습니다.{client === 'hermes' ? ' Hermes 프로젝트 설치는 Git 프로젝트 루트에서 하고 hermes skills trust /path/to/project로 별도 승인하세요.' : ''}</p></li>
      <li className="space-y-2"><h3 className="font-medium">2. MCP 연결 설정</h3><p className="text-muted-foreground">{client === 'claude-code' ? '아래 명령으로 개인 MCP 연결을 등록하세요. 프로젝트 연결은 --scope project를 사용합니다.' : client === 'codex' ? '~/.codex/config.toml의 기존 설정에 아래 테이블을 병합하세요.' : '~/.hermes/config.yaml의 기존 mcp_servers 설정에 아래 항목을 병합하세요.'}</p>{mcpUrl && <pre className="overflow-x-auto rounded-lg bg-muted/60 p-3 text-xs"><code>{connection}</code></pre>}</li>
      <li className="space-y-2"><h3 className="font-medium">3. OAuth 로그인 · 새 세션에서 확인</h3>{client === 'claude-code' ? <p className="text-muted-foreground">Claude Code에서 /mcp를 열어 브라우저 인증을 완료하고, 새 세션에서 /llmwiki를 호출하세요.</p> : <><pre className="overflow-x-auto rounded-lg bg-muted/60 p-3 text-xs"><code>{client === 'codex' ? 'codex mcp login llmwiki' : 'hermes mcp login llmwiki'}</code></pre><p className="text-muted-foreground">{client === 'codex' ? '브라우저 인증 후 새 세션의 /mcp로 연결을 확인하고 /skills 또는 $llmwiki를 호출하세요.' : '브라우저 인증 후 새 세션에서 /llmwiki를 호출하세요. /reload-mcp는 MCP 연결만 새로 읽으며 새 Skill 적용과는 다릅니다.'}</p></>}<p className="text-xs text-muted-foreground">실제 질문으로 검색·노트 읽기와 경로 인용을 확인하세요. 쓰기는 편집자 또는 관리자 권한이 필요합니다.</p></li>
    </ol>
    <a href={skillDocsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring">Skills 설치·연결 문서 <ExternalLink className="size-4" /><span className="sr-only">새 탭에서 열기</span></a>
  </section>
}
