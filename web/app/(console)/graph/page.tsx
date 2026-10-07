import { Suspense } from 'react'
import { Loading } from '@/components/common'
import { GraphPage } from '@/components/search/graph-page'

export default function Page() {
  return <Suspense fallback={<Loading label="그래프를 불러오는 중" />}><GraphPage /></Suspense>
}
