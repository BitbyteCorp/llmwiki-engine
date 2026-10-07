'use client'

import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { api, opsApi } from '@/lib/api'
import { confirmEditorLeave } from '@/components/editor/state'
import { useOpsActions } from './ops-actions'

export interface OpsPaletteCommand { id: string; label: string; keywords: string[]; action: () => void; disabled?: boolean }

export function useOpsCommands(): OpsPaletteCommand[] {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false })
  const admin = me.data?.user.role === 'admin'
  const ops = useQuery({ queryKey: ['ops'], queryFn: ({ signal }) => opsApi.status(signal), enabled: admin })
  const actions = useOpsActions()
  const router = useRouter()
  if (!admin) return []
  const unavailable = actions.busy || !ops.data
  return [
    { id: 'admin-ops', label: '운영 설정 열기', keywords: ['Operations Queue Index Dream Settings'], action: () => { if (confirmEditorLeave()) router.push('/settings?tab=ops') } },
    { id: 'ops-dream', label: '지금 dreaming 실행', keywords: ['Dream Now Luna Journal'], disabled: unavailable || Boolean(ops.data?.dreams.running), action: () => actions.request({ kind: 'dream' }) },
    { id: 'ops-incremental', label: '증분 재색인', keywords: ['Incremental Reindex Search'], disabled: unavailable || Boolean(ops.data?.index.syncing), action: () => actions.request({ kind: 'incremental' }) },
    { id: 'ops-full', label: '전체 재색인', keywords: ['Full Rebuild Reindex Search'], disabled: unavailable || Boolean(ops.data?.index.syncing), action: () => actions.request({ kind: 'full' }) },
    { id: 'ops-import', label: '원문 가져오기 시작', keywords: ['Import URL Text File Obsidian Notion'], disabled: actions.busy, action: () => actions.request({ kind: 'import' }) },
  ]
}
