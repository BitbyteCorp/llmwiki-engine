'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTheme } from 'next-themes'
import { onLiveEvent, useLiveConnection } from '@/lib/events'
import { useEditorStatus } from '@/components/editor/state'
import { useWorkspace } from './context'

export function WorkspaceStatus() {
  const { activePath, noteInfo } = useWorkspace()
  const editor = useEditorStatus(activePath)
  const { resolvedTheme, setTheme } = useTheme()
  const connection = useLiveConnection()
  const [mounted, setMounted] = useState(false)
  const [indexStatus, setIndexStatus] = useState<string | null>(null)
  useEffect(() => { setMounted(true); return onLiveEvent('index.updated', event => { if (typeof event.status === 'string') setIndexStatus(event.status) }) }, [])
  const counts = useMemo(() => {
    if (!noteInfo) return null
    return { words: noteInfo.body.trim() ? noteInfo.body.trim().split(/\s+/u).length : 0, lines: noteInfo.body ? noteInfo.body.split('\n').length : 0 }
  }, [noteInfo])
  return <footer aria-label="작업 공간 상태" className="flex h-7 shrink-0 items-center gap-2 overflow-hidden border-t bg-secondary px-3 text-[11px] text-muted-foreground sm:gap-3"><span title={activePath} className="min-w-0 flex-1 truncate">{activePath || '노트 미선택'}</span>{editor && <><span className="shrink-0">{editor.mode === 'view' ? '보기' : editor.mode === 'split' ? '분할 편집' : '편집'}</span>{editor.dirty && <span className="shrink-0" title="저장되지 않은 변경">수정됨</span>}<span aria-live="polite" className={editor.phase === 'conflict' ? 'shrink-0 text-destructive' : 'shrink-0'}>{editor.phase === 'saving' ? '저장 중' : editor.phase === 'saved' ? '저장됨' : editor.phase === 'conflict' ? '충돌' : ''}</span>{editor.cursor && <span className="shrink-0 font-mono" title={`${editor.cursor.line}줄 ${editor.cursor.column}열`}>{editor.cursor.line}:{editor.cursor.column}</span>}</>}{noteInfo && <><span title={noteInfo.updatedSha} className="hidden font-mono sm:inline">{noteInfo.updatedSha.slice(0, 8)}</span><span className="hidden sm:inline">{counts?.words}단어 · {counts?.lines}줄</span></>}<span aria-live="polite" className="hidden md:inline">{connection === 'connected' ? '실시간 연결됨' : connection === 'connecting' ? '실시간 연결 중' : '실시간 재연결 중'}{indexStatus && ` · 색인 ${indexStatus === 'ready' ? '준비됨' : indexStatus === 'syncing' ? '동기화 중' : '오류'}`}</span><button className="shrink-0" aria-label="테마 전환" disabled={!mounted} onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}>{mounted ? resolvedTheme === 'dark' ? '어두운 테마' : '밝은 테마' : '테마'}</button></footer>
}
