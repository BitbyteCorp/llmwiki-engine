'use client'

import { useWorkspace } from '@/components/workspace/context'
import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query'
import { opsApi, importKeys, type OpsJob } from '@/lib/api'
import { notify } from '@/components/notifications'
import { confirmEditorLeave } from '@/components/editor/state'

type OpsRunCommand = { kind: 'incremental' | 'full' | 'dream' } | { kind: 'retry' | 'cancel'; job: OpsJob }
export type OpsCommand = OpsRunCommand | { kind: 'import' }
export const opsMutationKey = ['ops', 'command'] as const
const labels = { incremental: '증분 재색인', full: '전체 재색인', dream: '꿈꾸기 수동 실행', cancel: '대기 작업 취소', import: '원문 가져오기' }

function commandLabel(command: OpsCommand): string {
  return command.kind === 'retry' ? command.job.resumable ? '이어서 재시도' : '새 작업으로 재시도' : labels[command.kind]
}

function confirmation(command: OpsCommand): string | null {
  switch (command.kind) {
    case 'full': return '모든 노트의 검색 색인과 임베딩을 다시 만듭니다. 시간이 걸리고 모델 사용 비용이 발생할 수 있습니다. 저장된 노트는 변경하지 않습니다.'
    case 'dream': return '변경 사항과 미학습 대화를 정리하고 일기를 작성한 뒤, 설정된 원격 저장소로 git push합니다. 지식 저장소에 실제 변경이 생길 수 있습니다.'
    case 'retry': return command.job.resumable
      ? `작업 ${command.job.id}의 저장된 진행 상황과 변경을 이어서 처리하도록 새 작업을 대기열에 넣습니다. 원래 실패 이력은 보존됩니다.`
      : `작업 ${command.job.id}를 새 작업으로 다시 대기열에 넣습니다.`
    case 'cancel': return `작업 ${command.job.id}를 취소합니다. 대기 중인 작업만 취소할 수 있습니다.`
    default: return null
  }
}

function actionLink(command: OpsCommand) {
  if (command.kind === 'retry' || command.kind === 'cancel') return { label: '작업 보기', href: `/jobs/${encodeURIComponent(command.job.id)}` }
  if (command.kind === 'dream') return { label: '꿈꾸기 기록 보기', href: '/dreams' }
  return { label: '운영 상태 보기', href: '/settings?tab=ops' }
}

export function useOpsActions(openImport?: () => void) {
  const client = useQueryClient()
  const { openHref } = useWorkspace()
  const busy = useIsMutating({ mutationKey: opsMutationKey, exact: true }) > 0
  const operation = useMutation({
    mutationKey: opsMutationKey,
    mutationFn: async (command: OpsRunCommand) => {
      switch (command.kind) {
        case 'dream': return { dream: await opsApi.runDream() }
        case 'full': await opsApi.reindex(true); return null
        case 'incremental': await opsApi.reindex(false); return null
        case 'retry': return await opsApi.retryJob(command.job.id)
        case 'cancel': return await opsApi.cancelJob(command.job.id)
      }
    },
    onSuccess: (result, command) => {
      const dream = result && 'dream' in result ? result.dream : null
      const job = result && 'job' in result ? result.job : null
      const failed = dream?.status === 'failed'
      notify({
        tone: failed ? 'error' : 'success',
        title: failed ? '꿈꾸기 실행에 실패했습니다.' : `${commandLabel(command)} 요청을 완료했습니다.`,
        description: failed ? dream.error ?? '실행 기록에서 오류를 확인하세요.' : undefined,
        action: dream ? { label: '꿈꾸기 보기', href: `/dreams/${encodeURIComponent(dream.id)}` } : job ? { label: '작업 보기', href: `/jobs/${encodeURIComponent(job.id)}` } : actionLink(command),
      })
    },
    onError: (error, command) => notify({ tone: 'error', title: `${commandLabel(command)} 요청에 실패했습니다.`, description: error instanceof Error ? error.message : String(error), action: actionLink(command) }),
    onSettled: () => {
      for (const key of ['ops', 'ops-ready', 'jobs', 'job', 'audit', 'dreams', 'dream', 'backup', 'activity', 'search']) void client.invalidateQueries({ queryKey: [key] })
    },
  })

  function request(command: OpsCommand) {
    // Read the cache synchronously so two mounted consumers cannot submit before React rerenders.
    if (client.isMutating({ mutationKey: opsMutationKey, exact: true })) return
    if (command.kind === 'import') {
      if (openImport) openImport()
      else if (confirmEditorLeave()) openHref('/imports?new=1')
      return
    }
    const description = confirmation(command)
    if (description && !window.confirm(`${commandLabel(command)}할까요?\n\n${description}`)) return
    if (!client.isMutating({ mutationKey: opsMutationKey, exact: true })) operation.mutate(command)
  }

  function importCreated({ jobIds }: { importId: string; jobIds: string[] }) {
    void client.invalidateQueries({ queryKey: importKeys.lists })
    void client.invalidateQueries({ queryKey: ['ops'] })
    const label = jobIds.length === 1 ? '통합 작업 보기' : `통합 작업 보기 (${jobIds.length}개 배치)`
    notify({ tone: 'success', title: '원문 가져오기 작업을 등록했습니다.', action: { label, href: `/jobs/${encodeURIComponent(jobIds[0])}` } })
  }

  function importFailed() {
    void client.invalidateQueries({ queryKey: importKeys.lists })
    notify({ tone: 'error', title: '원문 가져오기에 실패했습니다.', description: '가져오기 창에서 오류를 확인하고 다시 시도하세요.' })
  }

  return { busy, request, importCreated, importFailed }
}
