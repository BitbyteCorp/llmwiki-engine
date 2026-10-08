import { Suspense } from 'react'
import { Loading } from '@/components/common'
import { CommitPage } from '@/pages-ui/commit-history'

export default function Page() {
  return <Suspense fallback={<Loading label="변경 기록을 불러오는 중…"/>}><CommitPage /></Suspense>
}
