'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTheme } from 'next-themes'
import { onLiveEvent, useLiveConnection } from '@/lib/events'
import { useEditorStatus } from '@/components/editor/state'
import { useWorkspace } from './context'
import { isGraphTab } from './layout'

export function WorkspaceStatus() {
  const { activePath, noteInfo } = useWorkspace()
  const graphActive = isGraphTab(activePath)
  const activeEditor = useEditorStatus(graphActive ? '' : activePath)
  const editor = graphActive ? undefined : activeEditor
  const { theme, resolvedTheme, setTheme } = useTheme()
  const connection = useLiveConnection()
  const [mounted, setMounted] = useState(false)
  const [indexStatus, setIndexStatus] = useState<string | null>(null)
  useEffect(() => { setMounted(true); return onLiveEvent('index.updated', event => { if (typeof event.status === 'string') setIndexStatus(event.status) }) }, [])
  const info = !graphActive && noteInfo?.path === activePath ? noteInfo : null
  const counts = useMemo(() => {
    if (!info) return null
    return { words: info.body.trim() ? info.body.trim().split(/\s+/u).length : 0, lines: info.body ? info.body.split('\n').length : 0 }
  }, [info])
  return <footer aria-label="작업 공간 상태" className="flex h-6 shrink-0 items-center gap-2 overflow-hidden border-t bg-secondary px-3 text-xs text-muted-foreground sm:gap-3"><span title={graphActive ? '그래프' : activePath} className="min-w-0 flex-1 truncate">{graphActive ? '그래프' : activePath || '노트 미선택'}</span>{editor && <><span className="shrink-0">{editor.mode === 'view' ? '보기' : editor.mode === 'split' ? '미리보기 편집' : '편집'}</span>{editor.dirty && <span className="shrink-0" title="저장되지 않은 변경">수정됨</span>}<span aria-live="polite" className={editor.phase === 'conflict' ? 'shrink-0 text-destructive' : 'shrink-0'}>{editor.phase === 'saving' ? '저장 중' : editor.phase === 'saved' ? '저장됨' : editor.phase === 'conflict' ? '충돌' : ''}</span>{editor.cursor && <span className="shrink-0 font-mono" title={`${editor.cursor.line}줄 ${editor.cursor.column}열`}>{editor.cursor.line}:{editor.cursor.column}</span>}</>}{info && <><span title={info.updatedSha} className="hidden font-mono sm:inline">{info.updatedSha.slice(0, 8)}</span><span className="hidden sm:inline">{counts?.words}단어 · {counts?.lines}줄</span></>}<span aria-live="polite" className="hidden md:inline">{connection === 'connected' ? '실시간 연결됨' : connection === 'connecting' ? '실시간 연결 중' : '실시간 재연결 중'}{indexStatus && ` · 색인 ${indexStatus === 'ready' ? '준비됨' : indexStatus === 'syncing' ? '동기화 중' : '오류'}`}</span><button className="h-full shrink-0 px-1 hover:bg-accent hover:text-foreground" aria-label="테마 전환" title="시스템 → 밝게 → 어둡게" disabled={!mounted} onClick={() => setTheme(theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system')}>{mounted ? theme === 'system' ? '시스템 테마' : resolvedTheme === 'dark' ? '어두운 테마' : '밝은 테마' : '테마'}</button></footer>
}
