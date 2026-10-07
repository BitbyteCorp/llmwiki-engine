'use client'

import { useEffect, useRef, useState } from 'react'
import { Command } from 'cmdk'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useTheme } from 'next-themes'
import { api } from '@/lib/api'
import { ErrorNotice, Loading } from '@/components/common'
import { useWorkspace } from './context'
import { panelRegistry, type PanelId } from './registry'

export type PaletteMode = 'quickopen' | 'commands' | 'help' | null

export function Palettes({ mode, setMode, admin, selectPanel, toggleSidebar }: { mode: PaletteMode; setMode(mode: PaletteMode): void; admin: boolean; selectPanel(id: PanelId): void; toggleSidebar(): void }) {
  const workspace = useWorkspace()
  const router = useRouter()
  const { resolvedTheme, setTheme } = useTheme()
  const tree = useQuery({ queryKey: ['notes/tree'], queryFn: api.tree })
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const composing = useRef(false)
  useEffect(() => {
    if (!mode) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const element = dialog.current
    element?.showModal()
    input.current?.focus()
    return () => { composing.current = false; element?.close(); previousFocus?.focus() }
  }, [mode])
  useEffect(() => { setQuery('') }, [mode])
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (composing.current || event.isComposing || event.keyCode === 229) return
      const modifier = event.metaKey || event.ctrlKey
      const target = event.target instanceof HTMLElement ? event.target : null
      const editable = Boolean(target?.closest('input, textarea, select') || target?.isContentEditable)
      if (modifier && (event.key.toLowerCase() === 'p' || event.key.toLowerCase() === 'k')) {
        event.preventDefault()
        setMode(event.shiftKey || event.key.toLowerCase() === 'k' ? 'commands' : 'quickopen')
      } else if (modifier && event.shiftKey && event.key.toLowerCase() === 't') { event.preventDefault(); workspace.reopenClosed() }
      else if (modifier && event.key === '\\') { event.preventDefault(); workspace.toggleSplit() }
      else if (event.key === 'F1' || (event.key === '?' && !modifier && !event.altKey && !editable)) { event.preventDefault(); setMode('help') }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [setMode, workspace.reopenClosed, workspace.toggleSplit])
  function run(action: () => void) { if (composing.current) return; setMode(null); action() }
  if (!mode) return null
  const commands = [
    ...panelRegistry.filter(panel => !panel.admin || admin).map(panel => ({ id: panel.id, label: `${panel.label} 열기`, keywords: [panel.key], action: () => { selectPanel(panel.id); router.push(panel.href) } })),
    { id: 'sidebar', label: '사이드바 접기 / 펼치기', keywords: ['Toggle Sidebar'], action: toggleSidebar },
    { id: 'split', label: '노트 분할 보기 전환', keywords: ['Split Editor'], action: workspace.toggleSplit },
    { id: 'reopen', label: '닫은 탭 다시 열기', keywords: ['Reopen Closed Tab'], action: workspace.reopenClosed },
    { id: 'pin', label: '현재 탭 고정', keywords: ['Pin Tab'], action: () => workspace.pinTab(workspace.activePath) },
    { id: 'close', label: '현재 탭 닫기', keywords: ['Close Tab'], action: () => workspace.closeTab(workspace.activePath) },
    { id: 'close-others', label: '다른 탭 모두 닫기', keywords: ['Close Other Tabs'], action: () => workspace.closeOthers(workspace.activePath) },
    { id: 'note-history', label: '현재 노트 변경 이력 열기', keywords: ['Note History'], action: () => router.push(`/history?path=${encodeURIComponent(workspace.activePath)}`) },
    { id: 'favorite', label: '현재 노트 즐겨찾기 전환', keywords: ['Favorite'], action: () => workspace.toggleFavorite(workspace.activePath) },
    { id: 'reveal', label: '현재 노트 탐색기에서 표시', keywords: ['Reveal Explorer'], action: () => workspace.revealFolder(workspace.activePath) },
    { id: 'theme', label: '밝은 / 어두운 테마 전환', keywords: ['Toggle Theme Dark Light'], action: () => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark') },
    { id: 'system-theme', label: '시스템 테마 사용', keywords: ['System Theme'], action: () => setTheme('system') },
    { id: 'help', label: '단축키 도움말', keywords: ['Keyboard Help'], action: () => setMode('help') },
  ].filter(command => workspace.activePath || !['pin', 'close', 'close-others', 'note-history', 'favorite', 'reveal'].includes(command.id))
  const files = [...new Set([...workspace.recentPaths, ...tree.data?.files ?? []])]
  return <dialog ref={dialog} aria-label={mode === 'quickopen' ? '노트 빠르게 열기' : mode === 'help' ? '단축키 도움말' : '명령 팔레트'} className="workspace-dialog w-[min(36rem,calc(100vw-2rem))] rounded-lg border bg-popover p-0 text-popover-foreground shadow-xl" onCancel={event => { event.preventDefault(); if (!composing.current) setMode(null) }} onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) setMode(null) } }}>
    {mode === 'help' ? <div className="p-5"><div className="mb-4 flex justify-between"><h2 className="font-bold">단축키 도움말</h2><button aria-label="도움말 닫기" onClick={() => setMode(null)}>닫기</button></div><dl className="grid grid-cols-2 gap-3 text-sm"><dt>단축키 도움말</dt><dd><kbd>?</kbd> 또는 <kbd>F1</kbd></dd><dt>노트 빠르게 열기</dt><dd><kbd>Ctrl/⌘ P</kbd></dd><dt>명령 팔레트</dt><dd><kbd>Ctrl/⌘ K</kbd> 또는 <kbd>Ctrl/⌘ Shift P</kbd></dd><dt>닫은 탭 다시 열기</dt><dd><kbd>Ctrl/⌘ Shift T</kbd></dd><dt>분할 보기</dt><dd><kbd>Ctrl/⌘ \</kbd></dd><dt>선택 / 열기 / 닫기</dt><dd><kbd>↑ ↓ / Enter / Esc</kbd></dd><dt>노트 고정 / 분할 열기</dt><dd>두 번 클릭 / Alt 클릭</dd></dl></div> : <Command loop label={mode === 'quickopen' ? '노트 빠르게 열기' : '명령 팔레트'} onKeyDownCapture={event => { if ((composing.current || event.nativeEvent.isComposing || event.keyCode === 229) && ['Enter', 'Escape', 'ArrowUp', 'ArrowDown'].includes(event.key)) event.stopPropagation() }}><Command.Input ref={input} value={query} onValueChange={setQuery} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} placeholder={mode === 'quickopen' ? '노트 경로 또는 제목…' : '명령 검색…'} aria-label={mode === 'quickopen' ? '경로·제목 검색' : '명령 검색'} className="w-full border-b bg-transparent px-4 py-4 text-sm outline-none" /><Command.List className="max-h-[min(24rem,60vh)] overflow-y-auto p-2"><Command.Empty className="p-5 text-sm text-muted-foreground">일치하는 항목이 없습니다.</Command.Empty>{mode === 'quickopen' ? <>{tree.isPending && <Loading label="노트 목록 불러오는 중…" />}{tree.error && <div className="p-2"><ErrorNotice error={tree.error} /><button className="explorer-row" onClick={() => void tree.refetch()}>다시 시도</button></div>}<Command.Group heading="노트 · 최근 항목 우선">{files.map(path => <Command.Item key={path} value={path} keywords={[workspace.knownTitles[path] || '']} onSelect={() => run(() => workspace.openNote(path))}><span className="truncate">{workspace.knownTitles[path] || path.split('/').pop()}</span><span className="ml-auto truncate text-xs text-muted-foreground">{path}</span></Command.Item>)}</Command.Group></> : <Command.Group heading="작업 공간 명령">{commands.map(command => <Command.Item key={command.id} value={command.label} keywords={command.keywords} onSelect={() => run(command.action)}>{command.label}</Command.Item>)}</Command.Group>}</Command.List><div className="border-t px-4 py-2 text-xs text-muted-foreground">↑↓ 선택 · Enter 열기 · Esc 닫기 · ? / F1 도움말</div></Command>}
  </dialog>
}
