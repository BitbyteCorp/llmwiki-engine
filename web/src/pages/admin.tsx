import { useState, type FormEvent } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api, type Role, type Settings, type User } from "../lib/api"
import { EmptyState, ErrorNotice, Loading, PageHeader, formatDate } from "../components/common"
import { Button } from "../components/ui/button"
import { Input } from "../components/ui/input"
import { Label } from "../components/ui/label"
import { Switch } from "../components/ui/switch"
import { Textarea } from "../components/ui/textarea"

const roleLabels: Record<Role, string> = { admin: "관리자", editor: "편집자", viewer: "뷰어" }
const selectClass = "h-9 rounded-md border bg-background px-3 text-sm disabled:opacity-50"

function RoleSelect({ value, onChange, disabled, id, label }: { value: Role; onChange: (value: Role) => void; disabled?: boolean; id?: string; label: string }) {
  return <select id={id} aria-label={label} value={value} disabled={disabled} className={selectClass} onChange={(event) => onChange(event.target.value as Role)}>{Object.entries(roleLabels).map(([role, title]) => <option key={role} value={role}>{title}</option>)}</select>
}

export function AdminPage() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me })
  if (me.isPending) return <Loading label="관리 권한을 확인하는 중…" />
  if (me.isError) return <ErrorNotice error={me.error} />
  if (me.data.user.role !== "admin") return <div className="space-y-6"><PageHeader title="관리" /><EmptyState title="관리자 권한이 필요합니다" description="사용자와 로그인 설정은 관리자만 변경할 수 있습니다." /></div>
  return <AdminConsole currentUser={me.data.user} />
}

function AdminConsole({ currentUser }: { currentUser: User }) {
  const queryClient = useQueryClient()
  const users = useQuery({ queryKey: ["users"], queryFn: api.users })
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings })
  const [email, setEmail] = useState("")
  const [name, setName] = useState("")
  const [role, setRole] = useState<Role>("editor")
  const [deleteId, setDeleteId] = useState<number | null>(null)

  const createUser = useMutation({
    mutationFn: api.createUser,
    onSuccess: () => {
      setEmail("")
      setName("")
      setRole("editor")
      void queryClient.invalidateQueries({ queryKey: ["users"] })
    },
  })
  const updateUser = useMutation({
    mutationFn: ({ id, role }: { id: number; role: Role }) => api.updateUser(id, { role }),
    onSuccess: async ({ user }) => {
      if (user.id === currentUser.id) queryClient.setQueryData(["me"], { user })
      await queryClient.invalidateQueries({ queryKey: ["users"] })
    },
  })
  const deleteUser = useMutation({
    mutationFn: api.deleteUser,
    onSuccess: async (_, id) => {
      setDeleteId(null)
      if (id === currentUser.id) await queryClient.invalidateQueries({ queryKey: ["me"] })
      await queryClient.invalidateQueries({ queryKey: ["users"] })
    },
  })
  const busy = updateUser.isPending || deleteUser.isPending
  const userToDelete = users.data?.users.find((user) => user.id === deleteId)

  function submitUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    createUser.mutate({ email: email.trim(), ...(name.trim() ? { name: name.trim() } : {}), role })
  }

  return (
    <div className="space-y-6">
      <PageHeader title="관리" description="사용자 권한과 로그인 허용 정책을 관리합니다." />
      <section className="space-y-4" aria-labelledby="users-heading">
        <div><h2 id="users-heading" className="text-lg font-semibold">사용자</h2><p className="mt-1 text-sm text-muted-foreground">마지막 관리자는 삭제하거나 다른 역할로 변경할 수 없습니다.</p></div>
        {users.isPending && <Loading label="사용자를 불러오는 중…" />}
        {users.error && <ErrorNotice error={users.error} />}
        {updateUser.error && <ErrorNotice error={updateUser.error} />}
        {deleteUser.error && <ErrorNotice error={deleteUser.error} />}
        {users.data && (users.data.users.length === 0 ? <EmptyState title="등록된 사용자가 없습니다" /> : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-muted/30 text-muted-foreground"><tr><th className="px-4 py-3 font-medium">사용자</th><th className="px-4 py-3 font-medium">역할</th><th className="px-4 py-3 font-medium">최근 로그인</th><th className="px-4 py-3 font-medium"><span className="sr-only">사용자 삭제</span></th></tr></thead>
              <tbody className="divide-y">{users.data.users.map((user) => (
                <tr key={user.id}>
                  <td className="px-4 py-3"><p className="font-medium">{user.name || user.email}{user.id === currentUser.id && <span className="ml-2 text-xs text-muted-foreground">나</span>}</p>{user.name && <p className="mt-1 text-xs text-muted-foreground">{user.email}</p>}</td>
                  <td className="px-4 py-3"><RoleSelect value={user.role} disabled={busy} label={`${user.email} 역할`} onChange={(role) => { updateUser.reset(); deleteUser.reset(); updateUser.mutate({ id: user.id, role }) }} /></td>
                  <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{formatDate(user.lastLoginAt)}</td>
                  <td className="px-4 py-3 text-right"><Button variant="ghost" size="sm" disabled={busy} onClick={() => { deleteUser.reset(); setDeleteId(user.id) }} aria-label={`${user.email} 삭제`}>삭제</Button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ))}
        {userToDelete && <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4 text-sm"><p><strong>{userToDelete.email}</strong> 사용자를 삭제할까요? 이 작업은 되돌릴 수 없습니다.</p><div className="flex gap-2"><Button variant="outline" disabled={deleteUser.isPending} onClick={() => setDeleteId(null)}>취소</Button><Button variant="destructive" disabled={deleteUser.isPending} onClick={() => deleteUser.mutate(userToDelete.id)}>{deleteUser.isPending ? "삭제 중…" : "사용자 삭제"}</Button></div></div>}
      </section>
      <section className="space-y-4 rounded-lg border p-4" aria-labelledby="add-user-heading">
        <h2 id="add-user-heading" className="text-lg font-semibold">사용자 추가</h2>
        <form onSubmit={submitUser} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-2"><Label htmlFor="user-email">이메일</Label><Input id="user-email" type="email" required autoComplete="email" placeholder="name@example.com" value={email} onChange={(event) => setEmail(event.target.value)} disabled={createUser.isPending} /></div>
            <div className="space-y-2"><Label htmlFor="user-name">이름 <span className="text-muted-foreground">(선택)</span></Label><Input id="user-name" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} disabled={createUser.isPending} /></div>
            <div className="flex flex-col gap-2"><Label htmlFor="user-role">역할</Label><RoleSelect id="user-role" label="새 사용자 역할" value={role} onChange={setRole} disabled={createUser.isPending} /></div>
          </div>
          {createUser.error && <ErrorNotice error={createUser.error} />}
          {createUser.isSuccess && <p role="status" className="text-sm text-green-700">사용자를 추가했습니다.</p>}
          <Button type="submit" disabled={createUser.isPending}>{createUser.isPending ? "추가 중…" : "사용자 추가"}</Button>
        </form>
      </section>
      <section className="space-y-4" aria-labelledby="login-settings-heading">
        <h2 id="login-settings-heading" className="text-lg font-semibold">로그인 설정</h2>
        {settings.isPending && <Loading label="로그인 설정을 불러오는 중…" />}
        {settings.error && <ErrorNotice error={settings.error} />}
        {settings.data && <SettingsForm settings={settings.data} />}
      </section>
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
  })

  function submitSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const partial: Partial<Settings> = {}
    if (enabledChanged) partial.allowlistEnabled = allowlistEnabled
    if (domainsChanged) partial.allowedDomains = allowedDomains
    save.mutate(partial)
  }

  return (
    <form onSubmit={submitSettings} className="space-y-5 rounded-lg border p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1"><Label htmlFor="allowlist-enabled">등록된 이메일만 로그인 허용</Label><p className="text-sm leading-6 text-muted-foreground">켜면 허용 도메인에 속한 사용자 중 등록된 이메일만 로그인할 수 있습니다. 꺼도 도메인 검사는 적용됩니다.</p></div>
        <Switch id="allowlist-enabled" checked={allowlistEnabled} disabled={save.isPending} onCheckedChange={(checked) => { setAllowlistEnabled(checked); save.reset() }} />
      </div>
      <div className="max-w-xl space-y-2"><Label htmlFor="allowed-domains">허용 도메인</Label><Textarea id="allowed-domains" rows={5} placeholder={"example.com\nteam.example.com"} value={domainText} disabled={save.isPending} onChange={(event) => { setDomainText(event.target.value); save.reset() }} /><p className="text-xs leading-5 text-muted-foreground">도메인을 한 줄에 하나씩 입력합니다. 이메일 주소나 @는 넣지 않습니다. 목록이 비어 있으면 로그인이 허용되지 않습니다.</p></div>
      {save.error && <ErrorNotice error={save.error} />}
      {save.isSuccess && <p role="status" className="text-sm text-green-700">로그인 설정을 저장했습니다.</p>}
      <Button type="submit" disabled={save.isPending || (!domainsChanged && !enabledChanged)}>{save.isPending ? "저장 중…" : "설정 저장"}</Button>
    </form>
  )
}
