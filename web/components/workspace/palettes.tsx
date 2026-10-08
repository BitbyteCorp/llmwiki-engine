'use client'

import { Fragment, useEffect, useRef, useState } from 'react'
import { Command } from 'cmdk'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { usePathname, useSearchParams } from 'next/navigation'
import { useTheme } from 'next-themes'
import { api, type Note } from '@/lib/api'
import { askAgent, openChat } from '@/lib/chat-context'
import { ErrorNotice, Loading } from '@/components/common'
import { useOpsCommands } from '@/components/admin/ops-commands'
import { dispatchEditorCommand, type EditorCommand } from '@/components/editor/state'
import { useWorkspace } from './context'
import { GRAPH_TAB_PATH, isViewTab } from './layout'
import { saveDirtyGroups, shortcutHint, useShortcutPlatform, workspaceKeybindings } from './keybindings'
import { panelRegistry, type PanelId } from './registry'

export type PaletteMode = 'quickopen' | 'commands' | 'help' | null

function paletteScore(value: string, search: string, keywords?: string[]) {
  const needle = search.replace(/^[>#]/, '').trim().toLocaleLowerCase()
  if (!needle) return 1
  const text = [value, ...(keywords ?? [])].join(' ').toLocaleLowerCase()
  if (text.includes(needle)) return 1
  let position = 0
  for (const character of needle) {
    position = text.indexOf(character, position)
    if (position < 0) return 0
    position++
  }
  return 0.5
}

export function Palettes({ mode, setMode, admin, selectPanel, toggleSidebar, toggleChat }: { mode: PaletteMode; setMode(mode: PaletteMode): void; admin: boolean; selectPanel(id: PanelId): void; toggleSidebar(): void; toggleChat(): void }) {
  const workspace = useWorkspace()
  const platform = useShortcutPlatform()
  const opsCommands = useOpsCommands()
  const queryClient = useQueryClient()
  const activePath = workspace.activePath
  const activeNotePath = isViewTab(activePath) ? '' : activePath
  const activeTab = workspace.groups[workspace.activeGroupId]?.tabs.find(tab => tab.path === activePath)
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const isHistoryRoute = pathname === '/history' || pathname.startsWith('/history/')
  const historyRoutePath = isHistoryRoute ? searchParams.get('path') : null
  const historyNotePath = historyRoutePath || activeNotePath
  const { resolvedTheme, setTheme } = useTheme()
  const tree = useQuery({ queryKey: ['notes/tree'], queryFn: api.tree })
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false })
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const composing = useRef(false)
  const splitSelection = useRef(false)
  const lastMode = useRef<Exclude<PaletteMode, null>>('quickopen')
  if (mode) lastMode.current = mode
  const renderedMode = mode ?? lastMode.current
  const [settledQuery, setSettledQuery] = useState('')
  useEffect(() => {
    const timer = window.setTimeout(() => setSettledQuery(query), 200)
    return () => window.clearTimeout(timer)
  }, [query])
  const commandMode = renderedMode === 'commands' || (renderedMode === 'quickopen' && query.startsWith('>'))
  const headingMode = renderedMode === 'quickopen' && query.startsWith('#')
  const headingQuery = settledQuery.startsWith('#') ? settledQuery.slice(1).trim() : ''
  const suggestions = useQuery({ queryKey: ['search/suggest', settledQuery], queryFn: ({ signal }) => api.suggest(settledQuery, signal), enabled: mode === 'quickopen' && !commandMode && !headingMode && settledQuery.length <= 200 })
  const headings = useQuery({ queryKey: ['search', 'palette-headings', headingQuery], queryFn: ({ signal }) => api.search(headingQuery, { limit: 100 }, signal), enabled: Boolean(mode) && headingMode && Boolean(headingQuery) })
  useEffect(() => {
    if (!mode) { dialog.current?.close(); return }
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const element = dialog.current
    element?.showModal()
    input.current?.focus()
    return () => { composing.current = false; element?.close(); previousFocus?.focus() }
  }, [mode])
  useEffect(() => { if (mode) { setQuery(''); splitSelection.current = false } }, [mode])
  function run(action: () => void) { if (composing.current) return; setMode(null); action() }
  function openResult(path: string, fragment?: string) {
    workspace.openNote(path, { fragment, pin: true, group: splitSelection.current ? 'side' : workspace.activeGroupId })
  }
  const commands: { id: string; label: string; keywords: string[]; action(): void; disabled?: boolean }[] = [
    ...([
      { id: 'editor-new', command: 'new', label: '새 노트', keywords: ['New Note'], mutating: true },
      { id: 'editor-source', command: 'source', label: '원문 편집 전환', keywords: ['Source Markdown Edit Toggle'], mutating: true },
      { id: 'editor-save', command: 'save', label: '저장', keywords: ['Save Note'], mutating: true },
      { id: 'editor-rename', command: 'rename', label: '이름 바꾸기', keywords: ['Rename Move Note'], mutating: true },
      { id: 'editor-delete', command: 'delete', label: '삭제', keywords: ['Delete Note'], mutating: true },
      { id: 'editor-blame', command: 'blame', label: '줄별 작성자 보기', keywords: ['blame', '이력', '작성자', 'Author History'], mutating: false },
      { id: 'editor-ask', command: 'ask', label: '도니에게 묻기', keywords: ['Ask Dony', '도니'], mutating: false },
    ] satisfies { id: string; command: EditorCommand; label: string; keywords: string[]; mutating: boolean }[])
      .filter(command => (!command.mutating || me.data?.user.role === 'editor' || me.data?.user.role === 'admin') && (command.command === 'new' || (command.command === 'blame' ? historyNotePath : activeNotePath)))
      .map(command => ({ ...command, action: () => {
        if (command.command === 'blame' && isHistoryRoute) {
          const params = new URLSearchParams({ path: historyNotePath })
          if (historyRoutePath) {
            const ref = searchParams.get('ref')
            const current = searchParams.get('current')
            if (ref) params.set('ref', ref)
            if (current) params.set('current', current)
          }
          workspace.openHref(`/history/blame?${params}`)
          return
        }
        dispatchEditorCommand(command.command, command.command === 'new' ? undefined : activeNotePath, command.command === 'new' ? undefined : { exactPath: true })
      } })),
    ...(me.data?.user.role === 'editor' || me.data?.user.role === 'admin' ? [{
      id: 'editor-save-all', label: '열린 그룹의 변경된 노트 모두 저장', keywords: ['Save All Dirty Groups'], action: () => {
        saveDirtyGroups(workspace)
      },
    }] : []),
    ...panelRegistry.filter(panel => !panel.admin || admin).map(panel => ({ id: panel.id, label: panel.id === 'history' ? '이력 패널 열기' : `${panel.label} 열기`, keywords: [panel.key], action: () => selectPanel(panel.id) })),
    { id: 'chat-open', label: '도니 대화 열기', keywords: ['Open Chat Dony', '도니'], action: () => openChat() },
    { id: 'chat-new', label: '새 대화', keywords: ['New Chat Dony', '도니'], action: () => openChat({ newThread: true }) },
    { id: 'chat-search', label: '대화 검색', keywords: ['Search Conversations Messages'], action: () => openChat({ focusSearch: true }) },
    ...(activeNotePath ? [{ id: 'chat-note', label: '현재 노트로 대화 시작', keywords: ['Ask Dony Current Note Context', '도니'], action: () => {
      const note = workspace.noteInfo?.path === activeNotePath ? workspace.noteInfo : queryClient.getQueryData<Note>(['notes/content', activeNotePath])
      askAgent({ notePath: activeNotePath, ...(note ? { ref: note.updatedSha } : {}) })
    } }] : []),
    { id: 'graph-open', label: '그래프 열기', keywords: ['Graph'], action: () => workspace.openNote(GRAPH_TAB_PATH) },
    { id: 'tags-view', label: '태그 보기', keywords: ['Tags'], action: () => workspace.openHref('/tags') },
    { id: 'backlinks-panel', label: '백링크 패널', keywords: ['Links Backlinks'], action: () => selectPanel('links') },
    { id: 'duplicates-open', label: '중복 후보', keywords: ['Duplicates'], action: () => workspace.openHref('/search/duplicates') },
    { id: 'settings', label: '설정 열기', keywords: ['Settings Profile Theme'], action: () => workspace.openHref('/settings') },
    { id: 'api-tokens', label: 'API 토큰 관리', keywords: ['API Tokens Credentials'], action: () => workspace.openHref('/settings?tab=tokens') },
    { id: 'imports', label: '가져오기 열기', keywords: ['Import URL Text PDF Obsidian Notion'], action: () => workspace.openHref('/imports') },
    { id: 'export', label: '내보내기', keywords: ['Export ZIP Bundle Backup'], action: () => workspace.openHref('/settings?tab=export') },
    ...opsCommands,
    { id: 'sidebar', label: '사이드바 접기 / 펼치기', keywords: ['Toggle Sidebar'], action: toggleSidebar },
    { id: 'chat-toggle', label: '대화 패널 접기 / 펼치기', keywords: ['Toggle Chat Panel'], action: toggleChat },
    { id: 'split', label: '편집 그룹 오른쪽 분할', keywords: ['Split Editor Right'], action: () => workspace.splitEditor('right') },
    { id: 'split-bottom', label: '편집 그룹 아래 분할', keywords: ['Split Editor Bottom Down'], action: () => workspace.splitEditor('bottom') },
    { id: 'reopen', label: '닫은 탭 다시 열기', keywords: ['Reopen Closed Tab'], action: workspace.reopenClosed },
    { id: 'pin', label: '현재 탭 고정', keywords: ['Pin Tab'], action: () => workspace.pinTab(activePath) },
    { id: 'close', label: '현재 탭 닫기', keywords: ['Close Active Tab'], action: () => workspace.closeTab(activePath) },
    { id: 'close-group', label: '현재 편집 그룹 닫기', keywords: ['Close Active Editor Group'], action: () => workspace.closeGroup(workspace.activeGroupId) },
    { id: 'close-other-groups', label: '다른 편집 그룹 모두 닫기', keywords: ['Close Other Editor Groups'], disabled: workspace.groupOrder.length < 2, action: () => { for (const groupId of workspace.groupOrder) if (groupId !== workspace.activeGroupId) workspace.closeGroup(groupId) } },
    { id: 'open-side', label: '현재 탭 옆 그룹에 열기', keywords: ['Open Tab Side Group'], action: () => workspace.openNote(activePath, { group: 'side', query: activeTab?.query }) },
    { id: 'close-others', label: '다른 탭 모두 닫기', keywords: ['Close Other Tabs'], action: () => workspace.closeOthers(activePath) },
    { id: 'note-history', label: '이 노트의 변경 이력', keywords: ['Note History Follow Rename'], action: () => workspace.openHref(`/history?path=${encodeURIComponent(historyNotePath)}&follow=1`) },
    { id: 'activity-timeline', label: '전체 변경 활동', keywords: ['Activity Timeline History', '이력'], action: () => workspace.openHref('/history') },
    { id: 'history-journal', label: '일기', keywords: ['Journal Diary'], action: () => workspace.openHref('/journal') },
    { id: 'history-dreams', label: '꿈꾸기 기록', keywords: ['Dreaming Runs'], action: () => workspace.openHref('/dreams') },
    { id: 'favorite', label: '현재 노트 즐겨찾기 전환', keywords: ['Favorite'], action: () => workspace.toggleFavorite(activePath) },
    { id: 'reveal', label: '현재 노트 탐색기에서 표시', keywords: ['Reveal Explorer'], action: () => { selectPanel('explorer'); workspace.revealFolder(activePath) } },
    { id: 'theme', label: '밝은 / 어두운 테마 전환', keywords: ['Toggle Theme Dark Light'], action: () => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark') },
    { id: 'system-theme', label: '시스템 테마 사용', keywords: ['System Theme'], action: () => setTheme('system') },
    { id: 'help', label: '단축키 도움말', keywords: ['Keyboard Help'], action: () => setMode('help') },
  ].filter(command => (activePath || !['pin', 'close', 'close-others', 'open-side'].includes(command.id)) && (activeNotePath || !['favorite', 'reveal'].includes(command.id)) && (historyNotePath || command.id !== 'note-history'))
  const suggestedTitles = new Map(suggestions.data?.filter(note => !isViewTab(note.path)).map(note => [note.path, note.title]) ?? [])
  const files = [...new Set([...suggestions.data?.map(note => note.path) ?? [], ...workspace.recentPaths, ...tree.data?.files ?? []])].filter(path => !isViewTab(path))
  return <dialog ref={dialog} aria-label={renderedMode === 'quickopen' ? '노트 빠르게 열기' : renderedMode === 'help' ? '단축키 도움말' : '명령 팔레트'} className="workspace-dialog w-[min(36rem,calc(100vw-2rem))] rounded-lg border bg-popover p-0 text-popover-foreground shadow-xl" onCancel={event => { event.preventDefault(); if (!composing.current) setMode(null) }} onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) setMode(null) } }}>
    {renderedMode === 'help' ? <div className="max-h-[80vh] overflow-y-auto p-5"><div className="mb-4 flex justify-between"><h2 className="font-bold">단축키 도움말</h2><button aria-label="도움말 닫기" onClick={() => setMode(null)}>닫기</button></div><dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-3 text-sm">{workspaceKeybindings.map(binding => <Fragment key={binding.id}><dt>{binding.label}</dt><dd className="text-right"><kbd className="text-xs text-muted-foreground">{shortcutHint(binding.id, platform)}</kbd></dd></Fragment>)}<dt>선택 / 열기 / 닫기</dt><dd><kbd>↑ ↓ / Enter / Esc</kbd></dd><dt>검색 결과 옆 그룹에 열기</dt><dd><kbd>{platform === 'mac' ? '⌘' : 'Ctrl'} Enter</kbd></dd><dt>노트 고정 / 옆 그룹에 열기</dt><dd>두 번 클릭 / {platform === 'mac' ? '⌥' : 'Alt'} 클릭</dd></dl><p className="mt-4 text-xs text-muted-foreground">Alt 노트·탭 단축키와 ?는 입력 영역 밖에서만 동작합니다. 빠른 열기: # 소제목 · &gt; 명령</p></div> : <Command loop filter={headingMode ? () => 1 : paletteScore} label={commandMode ? '명령 팔레트' : '노트 빠르게 열기'} onKeyDownCapture={event => {
      splitSelection.current = event.key === 'Enter' && (event.ctrlKey || event.metaKey)
      if ((composing.current || event.nativeEvent.isComposing || event.keyCode === 229) && ['Enter', 'Escape', 'ArrowUp', 'ArrowDown'].includes(event.key)) event.stopPropagation()
    }}>
      <Command.Input ref={input} value={query} onValueChange={setQuery} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} placeholder={renderedMode === 'quickopen' ? '경로·제목, # 소제목, > 명령…' : '명령 검색…'} aria-label={renderedMode === 'quickopen' ? '경로·제목 검색' : '명령 검색'} className="w-full border-b bg-transparent px-4 py-4 text-sm outline-none" />
      <Command.List className="max-h-[min(24rem,60vh)] overflow-y-auto p-2">
        <Command.Empty className="p-5 text-sm text-muted-foreground">{headingMode && !headingQuery ? '# 뒤에 소제목 검색어를 입력하세요.' : '일치하는 항목이 없습니다.'}</Command.Empty>
        {commandMode ? <Command.Group heading="작업 공간 명령">{commands.map(command => <Command.Item key={command.id} value={command.label} keywords={command.keywords} disabled={command.disabled} onSelect={() => run(command.action)}><span>{command.label}</span>{shortcutHint(command.id, platform) && <kbd className="ml-auto shrink-0 pl-4 text-xs text-muted-foreground">{shortcutHint(command.id, platform)}</kbd>}</Command.Item>)}</Command.Group> : headingMode ? <>
          {headings.isFetching && <Loading label="소제목 검색 중…" />}
          {headings.error && <div className="p-2"><ErrorNotice error={headings.error} /><button className="explorer-row" onClick={() => void headings.refetch()}>다시 시도</button></div>}
          <Command.Group heading="노트 소제목">{headings.data?.hits.filter(hit => hit.anchor && !isViewTab(hit.path)).map((hit, index) => <Command.Item key={`${hit.path}:${hit.anchor}:${index}`} value={`${hit.path}:${hit.anchor}:${index}`} onSelect={() => run(() => openResult(hit.path, hit.anchor ?? undefined))}><span className="truncate">{hit.heading}</span><span className="ml-auto truncate text-xs text-muted-foreground">{hit.title} · {hit.path}</span></Command.Item>)}</Command.Group>
        </> : <>
          {(tree.isPending || suggestions.isFetching) && <Loading label="노트 목록 불러오는 중…" />}
          {(tree.error || suggestions.error) && <div className="p-2"><ErrorNotice error={tree.error || suggestions.error} /><button className="explorer-row" onClick={() => { void tree.refetch(); void suggestions.refetch() }}>다시 시도</button></div>}
          <Command.Group heading="노트 · 제목 추천 및 최근 항목">{files.map(path => <Command.Item key={`${path}:${suggestedTitles.get(path) || workspace.knownTitles[path] || ''}`} value={path} keywords={[suggestedTitles.get(path) || workspace.knownTitles[path] || '']} onSelect={() => run(() => openResult(path))}><span className="truncate">{suggestedTitles.get(path) || workspace.knownTitles[path] || path.split('/').pop()}</span><span className="ml-auto truncate text-xs text-muted-foreground">{path}</span></Command.Item>)}</Command.Group>
        </>}
      </Command.List><div className="border-t px-4 py-2 text-xs text-muted-foreground">↑↓ 선택 · Enter 열기 · {platform === 'mac' ? '⌘' : 'Ctrl'} Enter 분할 · Esc 닫기</div>
    </Command>}
  </dialog>
}
