import { Suspense } from 'react'
import { Loading } from '@/components/common'
import { WikiPage } from '@/pages-ui/wiki'

export default function Page() {
  return <Suspense fallback={<Loading label="작업 목록을 불러오는 중" />}><WikiPage /></Suspense>
}
