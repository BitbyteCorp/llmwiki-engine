import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { Loading } from '@/components/common'
import { WikiPage } from '@/pages-ui/wiki'

export default async function Page({ searchParams }: { searchParams: Promise<{ section?: string | string[] }> }) {
  const params = await searchParams
  const section = Array.isArray(params.section) ? params.section[0] : params.section
  if (section === 'tokens' || section === 'export') redirect(`/settings?tab=${section}`)
  return <Suspense fallback={<Loading label="설정을 불러오는 중" />}><WikiPage /></Suspense>
}
