import { SettingsPage } from '@/pages-ui/settings'

export default async function Page({ searchParams }: { searchParams: Promise<{ section?: string | string[] }> }) {
  const params = await searchParams
  const section = Array.isArray(params.section) ? params.section[0] : params.section
  return <SettingsPage publicUrl={process.env.PUBLIC_URL || undefined} section={section} />
}
