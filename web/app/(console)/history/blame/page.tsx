import { Suspense } from 'react'
import { Loading } from '@/components/common'
import { BlamePage } from '@/pages-ui/history'

export default function Page() {
  return <Suspense fallback={<Loading label="줄별 이력을 불러오는 중…"/>}><BlamePage /></Suspense>
}
