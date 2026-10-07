import { Suspense } from 'react'
import { JobsPage } from '@/pages-ui/jobs'
import { Loading } from '@/components/common'

export default function Page() {
  return <Suspense fallback={<Loading label="작업 목록을 불러오는 중…" />}><JobsPage /></Suspense>
}
