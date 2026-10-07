import { Suspense } from 'react'
import { Loading } from '@/components/common'
import { CommitPage } from '@/pages-ui/history'

export default function Page() {
  return <Suspense fallback={<Loading label="커밋을 불러오는 중…"/>}><CommitPage /></Suspense>
}
