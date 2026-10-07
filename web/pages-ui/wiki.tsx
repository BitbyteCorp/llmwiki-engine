'use client'

import { useQuery } from '@tanstack/react-query'
import { useParams, useSearchParams } from 'next/navigation'
import { api } from '@/lib/api'
import { EmptyState, ErrorNotice, Loading } from '@/components/common'
import { Button } from '@/components/ui/button'
import { useWorkspace } from '@/components/workspace/context'
import { NoteReader } from '@/components/workspace/note-reader'

export function WikiPage() {
  const params = useParams<{ path?: string[] }>()
  const searchParams = useSearchParams()
  const { splitPath, openNote } = useWorkspace()
  const path = params.path?.map(segment => decodeURIComponent(segment)).join('/') ?? ''
  const tree = useQuery({ queryKey: ['notes/tree'], queryFn: api.tree, enabled: !path })
  const closedAll = searchParams.get('empty') === '1'
  const defaultPath = tree.data?.files.includes('index.md') ? 'index.md' : tree.data?.files[0]

  return (
    <div className={`grid min-h-full min-w-0 gap-4 md:h-full md:min-h-0 ${splitPath ? 'md:grid-cols-2' : 'grid-cols-1'}`}>
      {path ? <NoteReader path={path} /> : <section aria-label="위키 노트 선택" className="min-w-0 space-y-4">
        <h1 className="sr-only">위키</h1>
        {tree.isPending && <Loading label="노트 목록을 불러오는 중" />}
        {tree.isError && <><ErrorNotice error={tree.error} /><Button variant="outline" disabled={tree.isFetching} onClick={() => void tree.refetch()}>다시 시도</Button></>}
        {tree.data && (tree.data.files.length === 0
          ? <EmptyState title="지식 저장소가 비어 있습니다" description="노트가 추가되면 이곳에서 읽을 수 있습니다." />
          : closedAll
            ? <><EmptyState title="열린 노트가 없습니다" description="탐색 패널에서 노트를 선택하거나 색인을 열어 주세요." /><Button variant="outline" onClick={() => { if (defaultPath) openNote(defaultPath) }}>색인 열기</Button></>
            : <Loading label="색인 노트를 여는 중" />)}
      </section>}
      {splitPath && <NoteReader path={splitPath} split />}
    </div>
  )
}
