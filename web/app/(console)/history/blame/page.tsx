import { Suspense } from 'react'
import { Loading } from '@/components/common'
import { BlamePage } from '@/pages-ui/history-blame'

export default function Page() {
  return <Suspense fallback={<Loading label="줄별 작성자를 불러오는 중…"/>}><BlamePage /></Suspense>
}
