import { redirect } from 'next/navigation'

const legacyTabs: Record<string, string> = { overview: 'ops', users: 'users', settings: 'login', audit: 'audit', acl: 'acl', export: 'export' }

export default async function Page({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const params = await searchParams
  const tab = Array.isArray(params.tab) ? params.tab[0] : params.tab
  redirect(`/settings?tab=${legacyTabs[tab ?? ''] ?? 'ops'}`)
}
