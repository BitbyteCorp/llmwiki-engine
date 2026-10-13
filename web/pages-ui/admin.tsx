"use client"

import { useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api, type Role, type Settings, type User } from "../lib/api"
import { passwordErrorMessage, validateNewPassword } from "../lib/password"
import { EmptyState, ErrorNotice, Loading, formatDate } from "../components/common"
import { Button } from "../components/ui/button"
import { Badge } from "../components/ui/badge"
import { Input } from "../components/ui/input"
import { Label } from "../components/ui/label"
import { Switch } from "../components/ui/switch"
import { Textarea } from "../components/ui/textarea"

const roleLabels: Record<Role, string> = { admin: "관리자", editor: "편집자", viewer: "뷰어" }
const selectClass = "h-9 rounded-md border bg-background px-3 text-sm disabled:opacity-50"

function RoleSelect({ value, onChange, disabled, id, label }: { value: Role; onChange: (value: Role) => void; disabled?: boolean; id?: string; label: string }) {
  return <select id={id} aria-label={label} value={value} disabled={disabled} className={selectClass} onChange={(event) => onChange(event.target.value as Role)}>{Object.entries(roleLabels).map(([role, title]) => <option key={role} value={role}>{title}</option>)}</select>
}


export function UsersAndSettings({ currentUser, tab }: { currentUser: User; tab: "users" | "login" }) {
  const queryClient = useQueryClient()
  const users = useQuery({ queryKey: ["users"], queryFn: api.users, enabled: tab === "users" })
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, enabled: tab === "login" })
  const [email, setEmail] = useState("")
  const [name, setName] = useState("")
  const [role, setRole] = useState<Role>("editor")
  const [createPassword, setCreatePassword] = useState("")
  const [createPasswordError, setCreatePasswordError] = useState<string | null>(null)
  const [passwordAction, setPasswordAction] = useState<{ id: number; kind: "set" | "clear" } | null>(null)
  const [newPassword, setNewPassword] = useState("")
  const [passwordConfirmation, setPasswordConfirmation] = useState("")
  const [passwordValidationError, setPasswordValidationError] = useState<string | null>(null)
  const [passwordNotice, setPasswordNotice] = useState("")
  const [deleteId, setDeleteId] = useState<number | null>(null)

  const createUser = useMutation({
    mutationFn: () => api.createUser({ email: email.trim(), ...(name.trim() ? { name: name.trim() } : {}), role, ...(createPassword !== "" ? { password: createPassword } : {}) }),
    onSuccess: () => {
      setEmail("")
      setName("")
      setRole("editor")
      setCreatePassword("")
      setCreatePasswordError(null)
      void queryClient.invalidateQueries({ queryKey: ["users"] })
    },
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ["audit"] }) },
  })
  const updateUser = useMutation({
    mutationFn: ({ id, role }: { id: number; role: Role }) => api.updateUser(id, { role }),
    onSuccess: async ({ user }) => {
      if (user.id === currentUser.id) queryClient.setQueryData(["me"], { user })
      await queryClient.invalidateQueries({ queryKey: ["users"] })
    },
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ["audit"] }) },
  })
  const deleteUser = useMutation({
    mutationFn: api.deleteUser,
    onSuccess: async (_, id) => {
      setDeleteId(null)
      if (id === currentUser.id) await queryClient.invalidateQueries({ queryKey: ["me"] })
      await queryClient.invalidateQueries({ queryKey: ["users"] })
    },
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ["audit"] }) },
  })
  const setUserPassword = useMutation({
    mutationFn: (id: number) => api.setUserPassword(id, newPassword),
    onSuccess: async (_, id) => {
      setNewPassword("")
      setPasswordConfirmation("")
      setPasswordAction(null)
      setPasswordNotice("비밀번호를 저장했습니다. 해당 사용자의 모든 로그인 세션이 종료되었습니다.")
      if (id === currentUser.id) await queryClient.invalidateQueries({ queryKey: ["me"] })
      await queryClient.invalidateQueries({ queryKey: ["users"] })
    },
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ["audit"] }) },
  })
  const clearUserPassword = useMutation({
    mutationFn: api.clearUserPassword,
    onSuccess: async (_, id) => {
      setNewPassword("")
      setPasswordConfirmation("")
      setPasswordAction(null)
      setPasswordNotice("비밀번호를 삭제했습니다. 해당 사용자의 모든 로그인 세션이 종료되었습니다.")
      if (id === currentUser.id) await queryClient.invalidateQueries({ queryKey: ["me"] })
      await queryClient.invalidateQueries({ queryKey: ["users"] })
    },
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ["audit"] }) },
  })
  const busy = createUser.isPending || updateUser.isPending || deleteUser.isPending || setUserPassword.isPending || clearUserPassword.isPending
  const userToDelete = users.data?.users.find((user) => user.id === deleteId)
  const passwordUser = users.data?.users.find((user) => user.id === passwordAction?.id)

  function submitUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const error = createPassword !== "" ? validateNewPassword(createPassword) : null
    setCreatePasswordError(error)
    createUser.reset()
    if (error) return
    createUser.mutate()
  }

  function choosePasswordAction(id: number, kind: "set" | "clear") {
    setDeleteId(null)
    setNewPassword("")
    setPasswordConfirmation("")
    setPasswordValidationError(null)
    setPasswordNotice("")
    setUserPassword.reset()
    clearUserPassword.reset()
    setPasswordAction({ id, kind })
  }

  function closePasswordAction() {
    setPasswordAction(null)
    setNewPassword("")
    setPasswordConfirmation("")
    setPasswordValidationError(null)
    setUserPassword.reset()
    clearUserPassword.reset()
  }

  function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || !passwordUser) return
    const error = validateNewPassword(newPassword, passwordConfirmation)
    setPasswordValidationError(error)
    setUserPassword.reset()
    if (error) return
    setUserPassword.mutate(passwordUser.id)
  }

  return (
    <div className="space-y-4">
      {tab === "users" && <>
      <section className="space-y-2" aria-labelledby="users-heading">
        <div><h2 id="users-heading" className="flex h-7 items-center gap-1.5 border-b text-label-13 font-semibold">사용자</h2><p className="mt-1 text-label-13 text-muted-foreground">마지막 관리자는 삭제하거나 다른 역할로 변경할 수 없습니다.</p></div>
        {users.isPending && <Loading label="사용자를 불러오는 중…" />}
        {users.error && <div className="space-y-2"><ErrorNotice error={users.error} /><Button variant="outline" onClick={() => void users.refetch()}>사용자 다시 불러오기</Button></div>}
        {updateUser.error && <ErrorNotice error={updateUser.error} />}
        {deleteUser.error && <ErrorNotice error={deleteUser.error} />}
        {users.data && (users.data.users.length === 0 ? <EmptyState title="등록된 사용자가 없습니다" /> : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[600px] text-left text-label-13">
              <thead className="whitespace-nowrap border-b bg-muted/30 text-xs text-muted-foreground"><tr><th className="px-2 py-1.5 font-medium">사용자</th><th className="px-2 py-1.5 font-medium">역할</th><th className="px-2 py-1.5 font-medium">최근 로그인</th><th className="px-2 py-1.5 font-medium"><span className="sr-only">사용자 관리</span></th></tr></thead>
              <tbody className="divide-y">{users.data.users.map((user) => (
                <tr key={user.id}>
                  <td className="px-2 py-1.5"><div className="flex flex-wrap items-center gap-1.5"><p className="font-medium">{user.name || user.email}{user.id === currentUser.id && <span className="ml-2 text-xs text-muted-foreground">나</span>}</p>{user.hasPassword && <Badge variant="secondary">비밀번호</Badge>}</div>{user.name && <p className="mt-0.5 text-xs text-muted-foreground">{user.email}</p>}</td>
                  <td className="px-2 py-1.5"><RoleSelect value={user.role} disabled={busy} label={`${user.email} 역할`} onChange={(role) => { updateUser.reset(); deleteUser.reset(); updateUser.mutate({ id: user.id, role }) }} /></td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-xs text-muted-foreground">{formatDate(user.lastLoginAt)}</td>
                  <td className="px-2 py-1.5"><div className="flex flex-wrap justify-end gap-1"><Button variant="ghost" size="sm" disabled={busy} aria-label={`${user.email} 비밀번호 ${user.hasPassword ? "재설정" : "설정"}`} onClick={() => choosePasswordAction(user.id, "set")}>비밀번호 {user.hasPassword ? "재설정" : "설정"}</Button>{user.hasPassword && <Button variant="ghost" size="sm" disabled={busy} aria-label={`${user.email} 비밀번호 삭제`} onClick={() => choosePasswordAction(user.id, "clear")}>비밀번호 삭제</Button>}<Button variant="ghost" size="sm" disabled={busy} onClick={() => { closePasswordAction(); deleteUser.reset(); setDeleteId(user.id) }} aria-label={`${user.email} 삭제`}>삭제</Button></div></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ))}
        {userToDelete && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-label-13"><p><strong>{userToDelete.email}</strong> 사용자를 삭제할까요? 이 작업은 되돌릴 수 없습니다.</p><div className="flex gap-2"><Button variant="outline" disabled={busy} onClick={() => setDeleteId(null)}>취소</Button><Button variant="destructive" disabled={busy} onClick={() => deleteUser.mutate(userToDelete.id)}>{deleteUser.isPending ? "삭제 중…" : "사용자 삭제"}</Button></div></div>}
        {passwordUser && passwordAction?.kind === "set" && <form onSubmit={submitPassword} className="space-y-2 rounded-lg border px-3 py-2" aria-labelledby="admin-password-heading">
          <h3 id="admin-password-heading" className="text-label-13 font-semibold">{passwordUser.email} 비밀번호 {passwordUser.hasPassword ? "재설정" : "설정"}</h3>
          <p id="admin-password-policy" className="text-xs leading-5 text-muted-foreground">비밀번호는 8~128자이며 공백도 포함됩니다. 저장하면 해당 사용자의 모든 로그인 세션이 종료됩니다.{passwordUser.id === currentUser.id && " 내 계정이므로 저장 후 다시 로그인해야 합니다."}</p>
          <div className="grid gap-x-6 gap-y-2 @2xl/settings-panel:grid-cols-2">
            <div className="space-y-2"><Label htmlFor="admin-new-password">새 비밀번호</Label><Input id="admin-new-password" type="password" required autoComplete="new-password" spellCheck={false} value={newPassword} disabled={busy} aria-describedby="admin-password-policy" aria-invalid={!!passwordValidationError} onChange={(event) => { setNewPassword(event.target.value); setPasswordValidationError(null); setUserPassword.reset() }} /></div>
            <div className="space-y-2"><Label htmlFor="admin-password-confirmation">새 비밀번호 확인</Label><Input id="admin-password-confirmation" type="password" required autoComplete="new-password" spellCheck={false} value={passwordConfirmation} disabled={busy} aria-invalid={!!passwordValidationError} onChange={(event) => { setPasswordConfirmation(event.target.value); setPasswordValidationError(null); setUserPassword.reset() }} /></div>
          </div>
          {passwordValidationError && <ErrorNotice error={passwordValidationError} />}
          {setUserPassword.error && <ErrorNotice error={passwordErrorMessage(setUserPassword.error)} />}
          <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={busy} onClick={closePasswordAction}>취소</Button><Button type="submit" disabled={busy}>{setUserPassword.isPending ? "저장 중…" : "비밀번호 저장"}</Button></div>
        </form>}
        {passwordUser && passwordAction?.kind === "clear" && <div role="alert" className="space-y-2 rounded-lg border px-3 py-2 text-label-13">
          <p><strong>{passwordUser.email}</strong> 사용자의 비밀번호를 삭제할까요? 이메일·비밀번호로 더 이상 로그인할 수 없으며 모든 로그인 세션이 종료됩니다. 계정과 Google 로그인은 유지됩니다.{passwordUser.id === currentUser.id && " 내 계정이므로 삭제 후 다시 로그인해야 합니다."}</p>
          {clearUserPassword.error && <ErrorNotice error={passwordErrorMessage(clearUserPassword.error)} />}
          <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={closePasswordAction}>취소</Button><Button variant="destructive" disabled={busy} onClick={() => clearUserPassword.mutate(passwordUser.id)}>{clearUserPassword.isPending ? "삭제 중…" : "비밀번호 삭제 확인"}</Button></div>
        </div>}
        {passwordNotice && <p role="status" className="text-label-13 text-success">{passwordNotice}</p>}
      </section>
      <section className="space-y-2" aria-labelledby="add-user-heading">
        <h2 id="add-user-heading" className="flex h-7 items-center gap-1.5 border-b text-label-13 font-semibold">사용자 추가</h2>
        <form onSubmit={submitUser} className="space-y-2">
          <div className="grid grid-cols-1 gap-x-6 gap-y-1.5 @2xl/settings-panel:grid-cols-2 @4xl/settings-panel:grid-cols-3">
            <div className="space-y-2"><Label htmlFor="user-email">이메일</Label><Input id="user-email" type="email" required autoComplete="email" placeholder="name@example.com" value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy} /></div>
            <div className="space-y-2"><Label htmlFor="user-name">이름 <span className="text-muted-foreground">(선택)</span></Label><Input id="user-name" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} disabled={busy} /></div>
            <div className="flex flex-col gap-2"><Label htmlFor="user-role">역할</Label><RoleSelect id="user-role" label="새 사용자 역할" value={role} onChange={setRole} disabled={busy} /></div>
            <div className="space-y-2"><Label htmlFor="user-password">비밀번호 <span className="text-muted-foreground">(선택)</span></Label><Input id="user-password" type="password" autoComplete="new-password" spellCheck={false} value={createPassword} disabled={busy} aria-describedby="user-password-policy" aria-invalid={!!createPasswordError} onChange={(event) => { setCreatePassword(event.target.value); setCreatePasswordError(null); createUser.reset() }} /><p id="user-password-policy" className="text-xs leading-5 text-muted-foreground">8~128자이며 공백도 포함됩니다. 비워 두면 Google 로그인만 사용할 수 있습니다.</p></div>
          </div>
          {createPasswordError && <ErrorNotice error={createPasswordError} />}
          {createUser.error && <ErrorNotice error={passwordErrorMessage(createUser.error)} />}
          {createUser.isSuccess && <p role="status" className="text-label-13 text-success">사용자를 추가했습니다.</p>}
          <Button type="submit" disabled={busy}>{createUser.isPending ? "추가 중…" : "사용자 추가"}</Button>
        </form>
      </section>
      </>}
      {tab === "login" &&
      <section className="space-y-2" aria-labelledby="login-settings-heading">
        <h2 id="login-settings-heading" className="flex h-7 items-center gap-1.5 border-b text-label-13 font-semibold">로그인 설정</h2>
        {settings.isPending && <Loading label="로그인 설정을 불러오는 중…" />}
        {settings.error && <div className="space-y-2"><ErrorNotice error={settings.error} /><Button variant="outline" onClick={() => void settings.refetch()}>로그인 설정 다시 불러오기</Button></div>}
        {settings.data && <SettingsForm settings={settings.data} />}
      </section>}
    </div>
  )
}

function SettingsForm({ settings }: { settings: Settings }) {
  const queryClient = useQueryClient()
  const [allowlistEnabled, setAllowlistEnabled] = useState(settings.allowlistEnabled)
  const [domainText, setDomainText] = useState(settings.allowedDomains.join("\n"))
  const allowedDomains = domainText.split("\n").map((domain) => domain.trim()).filter(Boolean)
  const domainsChanged = JSON.stringify(allowedDomains) !== JSON.stringify(settings.allowedDomains)
  const enabledChanged = allowlistEnabled !== settings.allowlistEnabled
  const save = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: (nextSettings) => {
      setAllowlistEnabled(nextSettings.allowlistEnabled)
      setDomainText(nextSettings.allowedDomains.join("\n"))
      queryClient.setQueryData(["settings"], nextSettings)
    },
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: ["audit"] }) },
  })

  function submitSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const partial: Partial<Settings> = {}
    if (enabledChanged) partial.allowlistEnabled = allowlistEnabled
    if (domainsChanged) partial.allowedDomains = allowedDomains
    save.mutate(partial)
  }

  return (
    <form onSubmit={submitSettings} className="space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1"><Label htmlFor="allowlist-enabled">Google 로그인 시 등록된 이메일만 허용</Label><p className="text-label-13 leading-5 text-muted-foreground">이 설정은 Google 로그인의 신규 사용자 자동 등록만 변경합니다. 켜면 등록된 이메일만 Google 로그인할 수 있고, 끄면 허용 도메인 검사를 통과한 신규 사용자를 뷰어로 자동 등록합니다. 이메일·비밀번호 로그인은 항상 관리자가 미리 등록하고 비밀번호를 설정한 계정만 사용할 수 있습니다.</p></div>
        <Switch id="allowlist-enabled" checked={allowlistEnabled} disabled={save.isPending} onCheckedChange={(checked) => { setAllowlistEnabled(checked); save.reset() }} />
      </div>
      <div className="max-w-xl space-y-2"><Label htmlFor="allowed-domains">허용 도메인</Label><Textarea id="allowed-domains" rows={5} placeholder={"example.com\nteam.example.com"} value={domainText} disabled={save.isPending} onChange={(event) => { setDomainText(event.target.value); save.reset() }} /><p className="text-xs leading-5 text-muted-foreground">Google 로그인과 이메일·비밀번호 로그인 모두 이메일 도메인을 검사합니다. Google 로그인은 Workspace 도메인도 확인합니다. 도메인을 한 줄에 하나씩 입력하며 이메일 주소나 @는 넣지 않습니다. 목록이 비어 있으면 도메인 제한을 적용하지 않습니다.</p></div>
      {save.error && <ErrorNotice error={save.error} />}
      {save.isSuccess && <p role="status" className="text-label-13 text-success">로그인 설정을 저장했습니다.</p>}
      <Button type="submit" disabled={save.isPending || (!domainsChanged && !enabledChanged)}>{save.isPending ? "저장 중…" : "설정 저장"}</Button>
    </form>
  )
}
