'use client'

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, KeyRound, RefreshCw, ShieldAlert } from 'lucide-react'
import { settingsApi, type ApiToken, type ApiTokenScope, type User } from '@/lib/api'
import { EmptyState, ErrorNotice, Loading, formatDate } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'

export function TokenSettings({ user, id = 'tokens' }: { user: User; id?: string }) {
  const queryClient = useQueryClient()
  const [all, setAll] = useState(false)
  const showAll = user.role === 'admin' && all
  const tokens = useQuery({ queryKey: ['tokens', user.id, showAll], queryFn: ({ signal }) => settingsApi.tokens(showAll, signal) })
  const [name, setName] = useState('')
  const [read, setRead] = useState(true)
  const [write, setWrite] = useState(false)
  const [expiry, setExpiry] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<unknown>(null)
  // A secret lives only in this mounted view, never in TanStack or browser storage.
  const [secret, setSecret] = useState<{ id: string; token: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<unknown>(null)
  const [confirmation, setConfirmation] = useState<ApiToken | null>(null)
  const [revoking, setRevoking] = useState(false)
  const [revokeError, setRevokeError] = useState<unknown>(null)
  const [revokedName, setRevokedName] = useState<string | null>(null)
  const mounted = useRef(true)
  const secretPanel = useRef<HTMLDivElement>(null)
  const createButton = useRef<HTMLButtonElement>(null)

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if (secret) secretPanel.current?.focus() }, [secret])

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (creating || secret) return
    setCreateError(null)
    const scopes: ApiTokenScope[] = []
    if (read) scopes.push('read')
    if (write) scopes.push('write')
    const expires = expiry ? new Date(expiry) : null
    if (!name.trim() || !scopes.length) { setCreateError(new Error('이름과 하나 이상의 권한을 선택해 주세요.')); return }
    if (expires && (!Number.isFinite(expires.getTime()) || expires.getTime() <= Date.now())) { setCreateError(new Error('만료 시각은 현재보다 미래여야 합니다.')); return }
    setCreating(true)
    try {
      const result = await settingsApi.createToken({ name: name.trim(), scopes, ...(expires ? { expiresAt: expires.toISOString() } : {}) })
      if (mounted.current) {
        setSecret({ id: result.id, token: result.token })
        setCopied(false)
        setCopyError(null)
        setName('')
        setExpiry('')
      }
      void queryClient.invalidateQueries({ queryKey: ['tokens'] })
    } catch (error) { if (mounted.current) setCreateError(error) }
    finally { if (mounted.current) setCreating(false) }
  }

  async function copySecret() {
    if (!secret) return
    setCopyError(null)
    try { await navigator.clipboard.writeText(secret.token); if (mounted.current) setCopied(true) }
    catch { if (mounted.current) setCopyError(new Error('클립보드에 복사하지 못했습니다. 아래 값을 직접 선택해 복사해 주세요.')) }
  }

  function dismissSecret() {
    setSecret(null)
    setCopied(false)
    setCopyError(null)
    requestAnimationFrame(() => createButton.current?.focus())
  }

  function closeConfirmation() {
    const tokenId = confirmation?.id
    setConfirmation(null)
    setRevokeError(null)
    if (tokenId) requestAnimationFrame(() => document.getElementById(`${id}-revoke-${tokenId}`)?.focus())
  }

  async function revoke() {
    if (!confirmation || revoking) return
    setRevoking(true)
    setRevokeError(null)
    try {
      await settingsApi.revokeToken(confirmation.id)
      if (mounted.current) {
        setRevokedName(confirmation.name)
        if (secret?.id === confirmation.id) { setSecret(null); setCopied(false); setCopyError(null) }
        closeConfirmation()
      }
      void queryClient.invalidateQueries({ queryKey: ['tokens'] })
    } catch (error) { if (mounted.current) setRevokeError(error) }
    finally { if (mounted.current) setRevoking(false) }
  }

  return <section id={id} tabIndex={-1} aria-labelledby={`${id}-heading`} className="scroll-mt-6 space-y-5 rounded-xl border bg-card p-4 sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 id={`${id}-heading`} className="flex items-center gap-2 text-lg font-semibold"><KeyRound className="size-5" />API 토큰</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">REST API를 위한 개인 토큰입니다. MCP 연결은 별도의 OAuth 로그인을 사용합니다.</p></div>
      <Button variant="outline" disabled={tokens.isFetching} onClick={() => void tokens.refetch()}><RefreshCw className={tokens.isFetching ? 'animate-spin motion-reduce:animate-none' : ''} />새로고침</Button>
    </div>
    {user.role === 'admin' && <div className="flex items-center gap-3"><Switch id={`${id}-all`} checked={all} onCheckedChange={(value) => { setAll(value); setConfirmation(null); setRevokeError(null) }} /><Label htmlFor={`${id}-all`}>모든 사용자의 토큰 보기</Label></div>}
    {tokens.isPending && <Loading label="API 토큰을 불러오는 중…" />}
    {tokens.error && <div className="space-y-2"><ErrorNotice error={tokens.error} /><Button variant="outline" disabled={tokens.isFetching} onClick={() => void tokens.refetch()}>다시 시도</Button></div>}
    {tokens.data && (tokens.data.tokens.length === 0 ? <EmptyState title="발급한 토큰이 없습니다" description="외부 도구에서 REST API를 사용하려면 아래에서 토큰을 발급하세요." /> : <ul className="divide-y rounded-lg border">{tokens.data.tokens.map((token) => {
      const expired = !!token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now()
      const inactive = !!token.revokedAt || expired
      return <li key={token.id} className="flex flex-col justify-between gap-3 p-4 sm:flex-row sm:items-start">
        <div className="min-w-0 space-y-2"><div className="flex flex-wrap items-center gap-2"><h3 className="break-all font-medium">{token.name}</h3>{token.scopes.map((scope) => <Badge key={scope} variant="secondary">{scope === 'read' ? '읽기' : '쓰기'}</Badge>)}{inactive && <Badge variant="outline">{token.revokedAt ? '폐기됨' : '만료됨'}</Badge>}</div>
          {showAll && <p className="text-xs text-muted-foreground">사용자 #{token.userId}{token.userId === user.id ? ' · 나' : ''}</p>}
          <dl className="grid gap-x-5 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2"><div><dt className="inline">발급: </dt><dd className="inline">{formatDate(token.createdAt)}</dd></div><div><dt className="inline">최근 사용: </dt><dd className="inline">{formatDate(token.lastUsedAt)}</dd></div><div><dt className="inline">만료: </dt><dd className="inline">{token.expiresAt ? formatDate(token.expiresAt) : '없음'}</dd></div></dl>
        </div>
        <Button id={`${id}-revoke-${token.id}`} variant="destructive" disabled={!!token.revokedAt || revoking} aria-label={`${token.name} 토큰 폐기`} onClick={() => { setConfirmation(token); setRevokeError(null); setRevokedName(null) }}>폐기</Button>
      </li>
    })}</ul>)}
    {confirmation && <div role="alertdialog" aria-labelledby={`${id}-confirm-title`} aria-describedby={`${id}-confirm-description`} className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4" onKeyDown={(event) => { if (event.key === 'Escape' && !revoking) closeConfirmation() }}>
      <h3 id={`${id}-confirm-title`} className="font-medium">토큰을 폐기할까요?</h3><p id={`${id}-confirm-description`} className="break-words text-sm"><strong>{confirmation.name}</strong> 토큰을 사용하는 도구는 즉시 접근할 수 없게 됩니다. 되돌릴 수 없습니다.</p>
      <ErrorNotice error={revokeError} /><div className="flex flex-wrap gap-2"><Button variant="outline" autoFocus disabled={revoking} onClick={closeConfirmation}>취소</Button><Button variant="destructive" disabled={revoking} onClick={() => void revoke()}>{revoking ? '폐기 중…' : revokeError ? '폐기 다시 시도' : '토큰 폐기 확인'}</Button></div>
    </div>}
    {revokedName && <p role="status" className="text-sm">{revokedName} 토큰을 폐기했습니다.</p>}
    {secret && <div ref={secretPanel} tabIndex={-1} role="region" aria-labelledby={`${id}-secret-title`} className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 focus-visible:outline-2 focus-visible:outline-ring">
      <h3 id={`${id}-secret-title`} className="flex items-center gap-2 font-semibold"><ShieldAlert className="size-5 shrink-0" />토큰은 지금 한 번만 표시됩니다</h3>
      <p className="text-sm leading-6">안전한 비밀 저장소에 복사하세요. 이 화면을 닫거나 다른 페이지로 이동하면 다시 확인할 수 없습니다. 노트·채팅·공유 저장소에 넣지 마세요.</p>
      <Label htmlFor={`${id}-secret`} className="sr-only">새 API 토큰 비밀값</Label><Input id={`${id}-secret`} readOnly autoComplete="off" spellCheck={false} className="font-mono text-xs" value={secret.token} onFocus={(event) => event.target.select()} />
      <ErrorNotice error={copyError} /><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => void copySecret()}><Copy />{copied ? '복사됨' : '토큰 복사'}</Button><Button onClick={dismissSecret}>저장했습니다 · 비밀값 지우기</Button></div>
      {copied && <p role="status" className="text-xs text-muted-foreground">클립보드에 복사했습니다. 화면을 닫아도 클립보드는 자동으로 지워지지 않습니다.</p>}
    </div>}
    <form onSubmit={create} className="space-y-4 border-t pt-5">
      <h3 className="font-medium">새 토큰 발급</h3>
      <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor={`${id}-name`}>토큰 이름</Label><Input id={`${id}-name`} required maxLength={200} autoComplete="off" placeholder="예: 개인 자동화 도구" value={name} disabled={creating || !!secret} onChange={(event) => setName(event.target.value)} /></div><div className="space-y-2"><Label htmlFor={`${id}-expiry`}>만료 시각 <span className="text-muted-foreground">(선택)</span></Label><Input id={`${id}-expiry`} type="datetime-local" value={expiry} disabled={creating || !!secret} onChange={(event) => setExpiry(event.target.value)} /><p className="text-xs text-muted-foreground">현재 기기의 시간대 기준입니다. 비워 두면 만료되지 않습니다.</p></div></div>
      <fieldset disabled={creating || !!secret} className="space-y-2"><legend className="mb-2 text-sm font-medium">권한</legend><div className="flex flex-wrap gap-x-6 gap-y-3"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={read} onChange={(event) => setRead(event.target.checked)} className="size-4 accent-primary" />읽기 (read)</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={write} onChange={(event) => setWrite(event.target.checked)} className="size-4 accent-primary" />쓰기 (write)</label></div><p className="text-xs leading-5 text-muted-foreground">읽기와 쓰기는 독립적인 권한입니다. 쓰기만 선택해도 조회 권한은 부여되지 않으며, 계정의 역할과 폴더 접근 규칙은 그대로 적용됩니다.</p></fieldset>
      <ErrorNotice error={createError} /><Button ref={createButton} type="submit" disabled={creating || !!secret || !name.trim() || (!read && !write)}>{creating ? '발급 중…' : createError ? '발급 다시 시도' : '토큰 발급'}</Button>
      {secret && <p className="text-xs text-muted-foreground">표시된 비밀값을 저장하고 지운 뒤 새 토큰을 발급할 수 있습니다.</p>}
    </form>
  </section>
}
