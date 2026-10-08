import { Suspense } from 'react'
import { Loading } from '@/components/common'
import { WikiPage } from '@/pages-ui/wiki'

export default function Page() {
  return <Suspense fallback={<Loading label="줄별 작성자를 불러오는 중" />}><WikiPage /></Suspense>
}
