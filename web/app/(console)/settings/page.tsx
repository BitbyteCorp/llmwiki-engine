import { redirect } from 'next/navigation'
import { SettingsPage } from '@/pages-ui/settings'

export default async function Page({ searchParams }: { searchParams: Promise<{ section?: string | string[] }> }) {
  const params = await searchParams
  const section = Array.isArray(params.section) ? params.section[0] : params.section
  if (section === 'tokens' || section === 'export') redirect(`/settings?tab=${section}`)
  return <SettingsPage publicUrl={process.env.PUBLIC_URL || undefined} />
}
