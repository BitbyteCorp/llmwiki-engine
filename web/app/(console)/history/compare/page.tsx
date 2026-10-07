import { Suspense } from 'react'
import { Loading } from '@/components/common'
import { ComparePage } from '@/pages-ui/history'

export default function Page() {
  return <Suspense fallback={<Loading label="비교 화면을 불러오는 중…"/>}><ComparePage /></Suspense>
}
