'use client'

import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { aclApi, api, type AclAccess, type AclCheck, type AclRule, type AclSubjectType, type Role, type User } from '@/lib/api'
import { EmptyState, ErrorNotice, Loading, formatDate } from '@/components/common'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

const roleLabels: Record<Role, string> = { admin: '관리자', editor: '편집자', viewer: '조회자' }
const accessLabels: Record<AclAccess, string> = { none: '접근 차단', read: '읽기', write: '읽기 · 쓰기' }
const subjectLabels: Record<AclSubjectType, string> = { user: '사용자', role: '역할', everyone: '모든 사용자' }

function userLabel(user: User) {
  return `${user.name ? `${user.name} · ` : ''}${user.email} (${roleLabels[user.role]})`
}

function subjectLabel(rule: AclRule, users: User[]) {
  if (rule.subjectType === 'everyone') return subjectLabels.everyone
  if (rule.subjectType === 'role') return `역할: ${roleLabels[rule.subject as Role] ?? rule.subject}`
  const user = users.find(candidate => String(candidate.id) === rule.subject)
  return user ? `사용자: ${userLabel(user)}` : `사용자 ID: ${rule.subject}`
}

function AccessResult({ result, users }: { result: AclCheck; users: User[] }) {
  const user = users.find(candidate => candidate.id === result.userId)
  return <div role="status" className="space-y-3 rounded-lg border bg-muted/20 p-4 text-sm">
    <p className="font-medium">최종 접근 권한: {accessLabels[result.access]}</p>
    <dl className="grid gap-2 sm:grid-cols-[auto_1fr]">
      <dt className="text-muted-foreground">사용자</dt><dd className="break-all">{user ? userLabel(user) : `사용자 ID: ${result.userId}`}</dd>
      <dt className="text-muted-foreground">경로</dt><dd className="break-all font-mono">{result.path}</dd>
      <dt className="text-muted-foreground">판정 근거</dt><dd>{result.reason === 'admin' ? '관리자는 모든 경로를 읽고 쓸 수 있다.' : result.reason === 'role_default' ? '일치하는 규칙이 없어 전역 역할의 기본 권한을 적용했다.' : '가장 구체적인 적용 규칙을 사용했다.'}</dd>
      {result.rule && <><dt className="text-muted-foreground">적용 규칙</dt><dd className="space-y-1"><p className="break-all font-mono">{result.rule.prefix} · 규칙 #{result.rule.id}</p><p>{subjectLabel(result.rule, users)} · {accessLabels[result.rule.access]}</p></dd></>}
    </dl>
    {result.rule?.access === 'write' && result.access === 'read' && <p className="text-muted-foreground">조회자는 쓰기 규칙이 있어도 읽기만 가능하다.</p>}
  </div>
}

export function AclRules() {
  const queryClient = useQueryClient()
  const rules = useQuery({ queryKey: ['acl', 'rules'], queryFn: ({ signal }) => aclApi.rules(signal) })
  const users = useQuery({ queryKey: ['users'], queryFn: api.users })
  const tree = useQuery({ queryKey: ['notes/tree'], queryFn: api.tree })
  const [prefix, setPrefix] = useState('/')
  const [subjectType, setSubjectType] = useState<AclSubjectType>('everyone')
  const [userSubject, setUserSubject] = useState('')
  const [roleSubject, setRoleSubject] = useState<Role>('editor')
  const [access, setAccess] = useState<AclAccess>('read')
  const [deleteRule, setDeleteRule] = useState<AclRule | null>(null)
  const [checkUser, setCheckUser] = useState('')
  const [checkPath, setCheckPath] = useState('')
  const [submittedCheck, setSubmittedCheck] = useState<{ userId: number; path: string } | null>(null)
  const [notice, setNotice] = useState('')
  const userList = users.data?.users ?? []
  const folders = useMemo(() => {
    const paths = new Set(['/'])
    for (const file of tree.data?.files ?? []) {
      const parts = file.split('/')
      for (let index = 1; index < parts.length; index++) paths.add(`${parts.slice(0, index).join('/')}/`)
    }
    return [...paths].sort((left, right) => left.localeCompare(right, 'ko'))
  }, [tree.data])
  const groupedRules = useMemo(() => {
    const groups = new Map<string, AclRule[]>()
    for (const rule of rules.data?.rules ?? []) {
      const group = groups.get(rule.prefix)
      if (group) group.push(rule)
      else groups.set(rule.prefix, [rule])
    }
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right, 'ko'))
  }, [rules.data])
  const check = useQuery({
    queryKey: ['acl', 'check', submittedCheck?.userId, submittedCheck?.path],
    queryFn: ({ signal }) => aclApi.check(submittedCheck!.userId, submittedCheck!.path, signal),
    enabled: submittedCheck !== null,
  })
  const create = useMutation({
    mutationFn: aclApi.create,
    onSuccess: async ({ rule }) => {
      setNotice(`${rule.prefix} 경로의 규칙을 저장했다.`)
      await queryClient.invalidateQueries({ queryKey: ['acl'] })
    },
  })
  const remove = useMutation({
    mutationFn: aclApi.delete,
    onSuccess: async () => {
      setDeleteRule(null)
      setNotice('규칙을 삭제했다.')
      await queryClient.invalidateQueries({ queryKey: ['acl'] })
    },
  })
  const busy = create.isPending || remove.isPending
  const selectedUserExists = userList.some(user => String(user.id) === userSubject)
  const checkUserExists = userList.some(user => String(user.id) === checkUser)
  const currentCheck = submittedCheck !== null && submittedCheck.userId === Number(checkUser) && submittedCheck.path === checkPath

  function submitRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (subjectType === 'user' && !selectedUserExists) return
    setNotice('')
    create.mutate({ prefix, subjectType, subject: subjectType === 'everyone' ? '' : subjectType === 'role' ? roleSubject : userSubject, access })
  }

  function submitCheck(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!checkUserExists || !checkPath.trim()) return
    if (currentCheck) void check.refetch()
    else setSubmittedCheck({ userId: Number(checkUser), path: checkPath })
  }

  return <section className="space-y-6" aria-labelledby="acl-heading">
    <div className="space-y-2">
      <h2 id="acl-heading" className="text-lg font-semibold">폴더 접근 권한</h2>
      <p className="text-sm text-muted-foreground">가장 구체적인 경로의 규칙을 적용하고, 같은 경로에서는 사용자 → 역할 → 모든 사용자 순으로 우선한다. 관리자는 규칙과 관계없이 접근한다.</p>
      <p className="text-sm text-muted-foreground">규칙이 없으면 조회자는 읽기, 편집자는 읽기·쓰기가 가능하다. 쓰기 규칙으로 조회자의 전역 권한을 높일 수 없다.</p>
    </div>

    <div className="space-y-3" aria-labelledby="acl-list-heading">
      <h3 id="acl-list-heading" className="font-medium">접근 규칙</h3>
      {rules.isPending && <Loading label="접근 규칙을 불러오는 중이다." />}
      {rules.isError && <div className="space-y-2"><ErrorNotice error={rules.error} /><Button variant="outline" size="sm" disabled={rules.isFetching} onClick={() => void rules.refetch()}>규칙 다시 불러오기</Button></div>}
      {rules.data && !rules.data.rules.length && <EmptyState title="등록된 접근 규칙이 없다" description="모든 경로에 전역 역할의 기본 권한을 적용한다. 아래에서 폴더나 파일의 접근 규칙을 추가할 수 있다." />}
      {groupedRules.map(([groupPrefix, entries]) => <div key={groupPrefix} className="overflow-hidden rounded-lg border">
        <h4 className="break-all border-b bg-muted/30 px-4 py-3 font-mono text-sm font-medium">{groupPrefix === '/' ? '/ (전체 저장소)' : groupPrefix}</h4>
        <Table className="min-w-[32rem]">
          <TableHeader><TableRow><TableHead scope="col">대상</TableHead><TableHead scope="col">권한</TableHead><TableHead scope="col">등록 시각</TableHead><TableHead scope="col"><span className="sr-only">규칙 삭제</span></TableHead></TableRow></TableHeader>
          <TableBody>{entries.map(rule => <TableRow key={rule.id}>
            <TableCell className="min-w-48 max-w-xs whitespace-normal break-all">{subjectLabel(rule, userList)}</TableCell>
            <TableCell>{accessLabels[rule.access]}</TableCell>
            <TableCell className="text-muted-foreground">{formatDate(rule.createdAt)}</TableCell>
            <TableCell className="text-right"><Button variant="ghost" size="sm" disabled={busy} aria-label={`${rule.prefix} ${subjectLabel(rule, userList)} 규칙 삭제`} onClick={() => { remove.reset(); setNotice(''); setDeleteRule(rule) }}>삭제</Button></TableCell>
          </TableRow>)}</TableBody>
        </Table>
      </div>)}
      {deleteRule && <div role="alert" className="space-y-3 rounded-lg border p-4 text-sm">
        <p className="break-all"><strong>{deleteRule.prefix}</strong>의 {subjectLabel(deleteRule, userList)} 규칙을 삭제할까요? 삭제하면 상위 경로의 규칙 또는 전역 역할의 기본 권한을 적용한다.</p>
        <ErrorNotice error={remove.error} />
        <div className="flex gap-2"><Button variant="outline" disabled={remove.isPending} onClick={() => { setDeleteRule(null); remove.reset() }}>취소</Button><Button variant="destructive" disabled={busy} onClick={() => remove.mutate(deleteRule.id)}>{remove.isPending ? '삭제 중…' : '규칙 삭제 확인'}</Button></div>
      </div>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
    </div>

    <div className="space-y-4 rounded-lg border p-4" aria-labelledby="acl-add-heading">
      <h3 id="acl-add-heading" className="font-medium">규칙 추가 · 변경</h3>
      <p className="text-sm text-muted-foreground">같은 경로와 대상의 규칙을 저장하면 기존 권한을 변경한다. 전체 저장소는 /, 폴더는 끝에 /를 붙이고 파일은 정확한 상대 경로를 입력한다.</p>
      {tree.isPending && <Loading label="폴더 목록을 불러오는 중이다." />}
      {tree.isError && <div className="space-y-2"><ErrorNotice error={tree.error} /><Button variant="outline" size="sm" disabled={tree.isFetching} onClick={() => void tree.refetch()}>폴더 목록 다시 불러오기</Button><p className="text-sm text-muted-foreground">폴더 목록 없이도 경로를 직접 입력할 수 있다.</p></div>}
      {users.isPending && <Loading label="사용자 목록을 불러오는 중이다." />}
      {users.isError && <div className="space-y-2"><ErrorNotice error={users.error} /><Button variant="outline" size="sm" disabled={users.isFetching} onClick={() => void users.refetch()}>사용자 목록 다시 불러오기</Button></div>}
      {users.data && !userList.length && <p className="text-sm text-muted-foreground">선택할 사용자가 없다. 역할이나 모든 사용자 대상 규칙은 저장할 수 있다.</p>}
      <form onSubmit={submitRule} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2"><Label htmlFor="acl-folder">폴더 선택</Label><NativeSelect id="acl-folder" className="w-full" value={folders.includes(prefix) ? prefix : ''} disabled={busy} onChange={event => { if (event.target.value) setPrefix(event.target.value) }}><option value="">직접 입력한 경로</option>{folders.map(folder => <option key={folder} value={folder}>{folder === '/' ? '/ (전체 저장소)' : folder}</option>)}</NativeSelect></div>
          <div className="space-y-2"><Label htmlFor="acl-prefix">폴더 또는 정확한 파일 경로</Label><Input id="acl-prefix" value={prefix} required disabled={busy} aria-describedby="acl-prefix-help" placeholder="team/ 또는 team/note.md" onChange={event => { setPrefix(event.target.value); create.reset() }} /><p id="acl-prefix-help" className="text-xs text-muted-foreground">저장소 상대 경로를 사용한다. 상위 경로(..)와 절대 경로는 사용할 수 없다. /는 전체 저장소를 뜻한다.</p></div>
          <div className="space-y-2"><Label htmlFor="acl-subject-type">대상 유형</Label><NativeSelect id="acl-subject-type" className="w-full" value={subjectType} disabled={busy} onChange={event => { setSubjectType(event.target.value as AclSubjectType); create.reset() }}>{Object.entries(subjectLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</NativeSelect></div>
          {subjectType === 'user' && <div className="space-y-2"><Label htmlFor="acl-user-subject">대상 사용자</Label><NativeSelect id="acl-user-subject" className="w-full" value={userSubject} required disabled={busy || users.isPending || !userList.length} onChange={event => setUserSubject(event.target.value)}><option value="">사용자 선택</option>{userList.map(user => <option key={user.id} value={String(user.id)}>{userLabel(user)}</option>)}</NativeSelect></div>}
          {subjectType === 'role' && <div className="space-y-2"><Label htmlFor="acl-role-subject">대상 역할</Label><NativeSelect id="acl-role-subject" className="w-full" value={roleSubject} disabled={busy} onChange={event => setRoleSubject(event.target.value as Role)}>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</NativeSelect></div>}
          <div className="space-y-2"><Label htmlFor="acl-access">접근 권한</Label><NativeSelect id="acl-access" className="w-full" value={access} disabled={busy} onChange={event => setAccess(event.target.value as AclAccess)}>{Object.entries(accessLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</NativeSelect></div>
        </div>
        <ErrorNotice error={create.error} />
        <Button type="submit" disabled={busy || !prefix.trim() || (subjectType === 'user' && !selectedUserExists)}>{create.isPending ? '저장 중…' : '규칙 저장'}</Button>
      </form>
    </div>

    <div className="space-y-4 rounded-lg border p-4" aria-labelledby="acl-check-heading">
      <h3 id="acl-check-heading" className="font-medium">접근 확인</h3>
      <p className="text-sm text-muted-foreground">사용자와 파일 경로를 선택해 실제 접근 권한과 적용 규칙을 확인한다.</p>
      <form onSubmit={submitCheck} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2"><Label htmlFor="acl-check-user">확인할 사용자</Label><NativeSelect id="acl-check-user" className="w-full" value={checkUser} required disabled={users.isPending || !userList.length} onChange={event => setCheckUser(event.target.value)}><option value="">사용자 선택</option>{userList.map(user => <option key={user.id} value={String(user.id)}>{userLabel(user)}</option>)}</NativeSelect></div>
          <div className="space-y-2"><Label htmlFor="acl-check-path">확인할 파일 경로</Label><Input id="acl-check-path" required value={checkPath} placeholder="team/note.md" onChange={event => setCheckPath(event.target.value)} /></div>
        </div>
        <Button type="submit" variant="outline" disabled={!checkUserExists || !checkPath.trim() || check.isFetching || busy}>{check.isFetching ? '확인 중…' : '접근 확인'}</Button>
      </form>
      {currentCheck && check.isFetching && <Loading label="접근 권한을 확인하는 중이다." />}
      {currentCheck && check.isError && <div className="space-y-2"><ErrorNotice error={check.error} /><Button variant="outline" size="sm" disabled={check.isFetching} onClick={() => void check.refetch()}>접근 확인 다시 시도</Button></div>}
      {currentCheck && check.data && !check.isFetching && !check.isError && <AccessResult result={check.data} users={userList} />}
    </div>
  </section>
}
