'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTheme } from 'next-themes'
import { onLiveEvent, useLiveConnection } from '@/lib/events'
import { useWorkspace } from './context'

export function WorkspaceStatus() {
  const { activePath, noteInfo } = useWorkspace()
  const { resolvedTheme, setTheme } = useTheme()
  const connection = useLiveConnection()
  const [mounted, setMounted] = useState(false)
  const [indexStatus, setIndexStatus] = useState<string | null>(null)
  useEffect(() => { setMounted(true); return onLiveEvent('index.updated', event => { if (typeof event.status === 'string') setIndexStatus(event.status) }) }, [])
  const counts = useMemo(() => {
    if (!noteInfo) return null
    return { words: noteInfo.body.trim() ? noteInfo.body.trim().split(/\s+/u).length : 0, lines: noteInfo.body ? noteInfo.body.split('\n').length : 0 }
  }, [noteInfo])
  return <footer aria-label="작업 공간 상태" className="flex h-7 shrink-0 items-center gap-3 overflow-hidden border-t bg-secondary px-3 text-[11px] text-muted-foreground"><span title={activePath} className="min-w-0 flex-1 truncate">{activePath || '노트 미선택'}</span>{noteInfo && <><span title={noteInfo.updatedSha} className="font-mono">{noteInfo.updatedSha.slice(0, 8)}</span><span className="hidden sm:inline">{counts?.words}단어 · {counts?.lines}줄</span></>}<span aria-live="polite" className="hidden md:inline">{connection === 'connected' ? '실시간 연결됨' : connection === 'connecting' ? '실시간 연결 중' : '실시간 재연결 중'}{indexStatus && ` · 색인 ${indexStatus === 'ready' ? '준비됨' : indexStatus === 'syncing' ? '동기화 중' : '오류'}`}</span><button aria-label="테마 전환" disabled={!mounted} onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}>{mounted ? resolvedTheme === 'dark' ? '어두운 테마' : '밝은 테마' : '테마'}</button></footer>
}
