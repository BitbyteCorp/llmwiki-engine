'use client'

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { usePathname, useSearchParams } from 'next/navigation'
import { api } from '@/lib/api'
import { EmptyState, ErrorNotice, Loading } from '@/components/common'
import { Button } from '@/components/ui/button'
import { useWorkspace } from '@/components/workspace/context'
import { EditorGrid } from '@/components/workspace/editor-grid'
import { isViewRoute } from '@/components/workspace/layout'

export function WikiPage() {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const workspace = useWorkspace()
  const [mobile, setMobile] = useState(false)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)')
    const changed = () => setMobile(media.matches)
    changed()
    media.addEventListener('change', changed)
    return () => media.removeEventListener('change', changed)
  }, [])
  const viewRoute = isViewRoute(pathname)
  const tree = useQuery({ queryKey: ['notes/tree'], queryFn: api.tree, enabled: !viewRoute && !workspace.groupOrder.some(id => workspace.groups[id].activePath) })
  const closedAll = searchParams.get('empty') === '1'
  const defaultPath = tree.data?.files.includes('index.md') ? 'index.md' : tree.data?.files[0]
  const empty = <section aria-label="위키 노트 선택" className="h-full min-h-0 min-w-0 space-y-4 overflow-auto p-4">
    <h1 className="sr-only">위키</h1>
    {viewRoute ? <Loading label="화면을 여는 중" /> : tree.isPending && <Loading label="노트 목록을 불러오는 중" />}
    {!viewRoute && tree.isError && <><ErrorNotice error={tree.error} /><Button variant="outline" disabled={tree.isFetching} onClick={() => void tree.refetch()}>다시 시도</Button></>}
    {!viewRoute && tree.data && (tree.data.files.length === 0
      ? <EmptyState title="지식 저장소가 비어 있습니다" description="노트가 추가되면 이곳에서 읽을 수 있습니다." />
      : closedAll
        ? <><EmptyState title="열린 노트가 없습니다" description="탐색 패널에서 노트를 선택하거나 색인을 열어 주세요." /><Button variant="outline" onClick={() => { if (defaultPath) workspace.openNote(defaultPath) }}>색인 열기</Button></>
        : <Loading label="색인 노트를 여는 중" />)}
  </section>
  return <EditorGrid mobile={mobile} empty={empty} />
}
