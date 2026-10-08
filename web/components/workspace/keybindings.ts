'use client'

import { useEffect, useRef, useState } from 'react'
import { useTheme } from 'next-themes'
import { dispatchEditorCommand, getEditorStatus, type EditorCommand } from '@/components/editor/state'
import { openChat } from '@/lib/chat-context'
import { useWorkspace, type Workspace } from './context'
import type { PaletteMode } from './palettes'
import type { PanelId } from './registry'
import { isViewTab } from './layout'

type Shortcut = { key: string; mod?: boolean; alt?: boolean; shift?: boolean; hint?: string }
type BindingContext = {
  workspace: Workspace
  setMode(mode: PaletteMode): void
  selectPanel(id: PanelId): void
  toggleSidebar(): void
  toggleChat(): void
  openSettings(): void
  toggleTheme(): void
}
type Binding = { id: string; label: string; shortcuts: Shortcut[]; outsideInput?: boolean; scope?: string; run(context: BindingContext, event: KeyboardEvent): void }

function noteCommand(context: BindingContext, command: EditorCommand) {
  const path = isViewTab(context.workspace.activePath) ? '' : context.workspace.activePath
  if (path || command === 'new') dispatchEditorCommand(command, path || undefined, command === 'new' ? undefined : { exactPath: true })
}
function closeActiveTab({ workspace }: BindingContext) {
  if (workspace.activePath) workspace.closeTab(workspace.activePath)
}
function selectTab({ workspace }: BindingContext, index: number) {
  const tab = workspace.groups[workspace.activeGroupId]?.tabs[index]
  if (tab) workspace.openNote(tab.path, { group: workspace.activeGroupId, query: tab.query })
}

export function saveDirtyGroups(workspace: Workspace): void {
  for (const groupId of workspace.groupOrder) {
    const path = workspace.groups[groupId]?.activePath
    if (path && !isViewTab(path) && workspace.isEditorOwner(groupId, path) && getEditorStatus(path)?.dirty) dispatchEditorCommand('save', path, { exactPath: true })
  }
}

/** Binding execution, help rows, and palette hints all use this registry. */
export const workspaceKeybindings: readonly Binding[] = [
  { id: 'editor-save', label: '현재 그룹 노트 저장', shortcuts: [{ key: 's', mod: true }], run: context => noteCommand(context, 'save') },
  { id: 'editor-save-all', label: '열린 그룹의 변경된 노트 모두 저장', shortcuts: [{ key: 's', mod: true, alt: true }], run: context => saveDirtyGroups(context.workspace) },
  { id: 'editor-source', label: '원문 편집 전환', shortcuts: [{ key: 'e', mod: true }], run: context => noteCommand(context, 'source') },
  { id: 'editor-new', label: '새 노트', shortcuts: [{ key: 'n', alt: true }], outsideInput: true, run: context => noteCommand(context, 'new') },
  { id: 'close', label: '현재 탭 닫기', shortcuts: [{ key: 'w', alt: true }], outsideInput: true, run: closeActiveTab },
  { id: 'previous-tab', label: '이전 탭', shortcuts: [{ key: 'ArrowLeft', alt: true }], outsideInput: true, run: context => {
    const group = context.workspace.groups[context.workspace.activeGroupId]
    if (!group?.tabs.length) return
    const index = group.tabs.findIndex(tab => tab.path === group.activePath)
    selectTab(context, (index - 1 + group.tabs.length) % group.tabs.length)
  } },
  { id: 'next-tab', label: '다음 탭', shortcuts: [{ key: 'ArrowRight', alt: true }], outsideInput: true, run: context => {
    const group = context.workspace.groups[context.workspace.activeGroupId]
    if (!group?.tabs.length) return
    const index = group.tabs.findIndex(tab => tab.path === group.activePath)
    selectTab(context, (index + 1) % group.tabs.length)
  } },
  { id: 'select-tab', label: '번호로 탭 선택', shortcuts: Array.from({ length: 9 }, (_, index) => ({ key: String(index + 1), alt: true, hint: '1–9' })), outsideInput: true, run: (context, event) => selectTab(context, Number(event.code.replace('Digit', '') || event.key) - 1) },
  { id: 'reopen', label: '닫은 탭 다시 열기', shortcuts: [{ key: 't', alt: true, shift: true }], outsideInput: true, run: context => context.workspace.reopenClosed() },
  { id: 'sidebar', label: '사이드바 접기 / 펼치기', shortcuts: [{ key: 'b', mod: true }], run: context => context.toggleSidebar() },
  { id: 'chat-toggle', label: '대화 패널 접기 / 펼치기', shortcuts: [{ key: 'b', mod: true, alt: true }], run: context => context.toggleChat() },
  { id: 'chat-open', label: '도니 대화 열기', shortcuts: [{ key: 'i', mod: true, alt: true }], run: () => openChat() },
  { id: 'chat-new', label: '새 대화', shortcuts: [{ key: 'o', mod: true, shift: true }], run: () => openChat({ newThread: true }) },
  { id: 'explorer', label: '탐색기 패널 초점', shortcuts: [{ key: 'e', mod: true, shift: true }], run: context => context.selectPanel('explorer') },
  { id: 'search', label: '검색 패널 초점', shortcuts: [{ key: 'f', mod: true, shift: true }], run: context => context.selectPanel('search') },
  { id: 'history', label: '이력 패널 초점', shortcuts: [{ key: 'h', mod: true, shift: true }], run: context => context.selectPanel('history') },
  { id: 'settings', label: '설정 열기', shortcuts: [{ key: ',', mod: true }], run: context => context.openSettings() },
  { id: 'split', label: '편집 그룹 오른쪽 분할', shortcuts: [{ key: '\\', mod: true }], run: context => context.workspace.splitEditor('right') },
  { id: 'open-side', label: '초점 탭을 분할에 열기', shortcuts: [{ key: 'Enter', mod: true }], scope: '[role="tab"]', run: (context, event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[role="tab"]') : null
    const path = target?.dataset.tabPath || target?.title
    if (path) {
      if (target?.dataset.groupId) context.workspace.setActiveGroup(target.dataset.groupId)
      const tab = context.workspace.groups[target?.dataset.groupId || context.workspace.activeGroupId]?.tabs.find(tab => tab.path === path)
      context.workspace.openNote(path, { group: 'side', query: tab?.query })
    }
  } },
  { id: 'focus-group', label: '번호로 편집 그룹 초점', shortcuts: Array.from({ length: 9 }, (_, index) => ({ key: String(index + 1), mod: true, hint: '1–9' })), run: (context, event) => context.workspace.focusGroup(Number(shortcutKey(event)) - 1) },
  { id: 'quickopen', label: '노트 빠르게 열기', shortcuts: [{ key: 'p', mod: true }], run: context => context.setMode('quickopen') },
  { id: 'commands', label: '명령 팔레트', shortcuts: [{ key: 'k', mod: true }, { key: 'p', mod: true, shift: true }], run: context => context.setMode('commands') },
  { id: 'theme', label: '밝은 / 어두운 테마 전환', shortcuts: [{ key: 't', mod: true, alt: true }], run: context => context.toggleTheme() },
  { id: 'editor-rename', label: '탐색기 / 탭 이름 바꾸기', shortcuts: [{ key: 'F2' }], outsideInput: true, scope: '[role="tab"], [data-explorer-path]', run: (context, event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[role="tab"]') : null
    const path = target?.dataset.tabPath || target?.title
    if (path && !isViewTab(path)) dispatchEditorCommand('rename', path, { exactPath: true })
  } },
  { id: 'help', label: '단축키 도움말', shortcuts: [{ key: '?' }, { key: 'F1' }], run: context => context.setMode('help') },
]

export function isTextInput(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .cm-editor'))
}
function shortcutKey(event: KeyboardEvent): string {
  if (event.key === '?') return '?'
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase()
  if (/^Digit[1-9]$/.test(event.code)) return event.code.slice(5)
  if (event.code === 'Backslash') return '\\'
  if (event.code === 'Comma') return ','
  return event.key.length === 1 ? event.key.toLowerCase() : event.key
}
export function matchingWorkspaceBinding(event: KeyboardEvent): Binding | undefined {
  if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return undefined
  const key = shortcutKey(event)
  return workspaceKeybindings.find(binding => {
    if ((binding.outsideInput || key === '?') && isTextInput(event.target)) return false
    if (binding.scope && !(event.target instanceof Element && event.target.closest(binding.scope))) return false
    return binding.shortcuts.some(shortcut => shortcut.key === key && Boolean(shortcut.mod) === (event.ctrlKey || event.metaKey) && Boolean(shortcut.alt) === event.altKey && (key === '?' || Boolean(shortcut.shift) === event.shiftKey))
  })
}

export function useShortcutPlatform(): 'mac' | 'ctrl' {
  const [platform, setPlatform] = useState<'mac' | 'ctrl'>('ctrl')
  useEffect(() => { setPlatform(/Mac|iPhone|iPad|iPod/.test(navigator.platform) ? 'mac' : 'ctrl') }, [])
  return platform
}
const keyLabels: Record<string, string> = { ArrowLeft: '←', ArrowRight: '→' }

export function shortcutHint(id: string, platform: 'mac' | 'ctrl' = 'ctrl'): string | undefined {
  const binding = workspaceKeybindings.find(binding => binding.id === id)
  if (!binding) return undefined
  return [...new Set(binding.shortcuts.map(shortcut => [
    shortcut.mod ? platform === 'mac' ? '⌘' : 'Ctrl' : '',
    shortcut.alt ? platform === 'mac' ? '⌥' : 'Alt' : '',
    shortcut.shift ? platform === 'mac' ? '⇧' : 'Shift' : '',
    shortcut.hint ?? keyLabels[shortcut.key] ?? shortcut.key.toUpperCase(),
  ].filter(Boolean).join(' ')))].join(' · ')
}

export function useWorkspaceKeybindings(options: { setMode(mode: PaletteMode): void; selectPanel(id: PanelId): void; toggleSidebar(): void; toggleChat(): void; mobile: boolean }): void {
  const workspace = useWorkspace()
  const { resolvedTheme, setTheme } = useTheme()
  const context: BindingContext = {
    ...options, workspace,
    openSettings: () => workspace.openHref('/settings'),
    toggleTheme: () => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'),
  }
  const current = useRef(context)
  current.current = context
  useEffect(() => {
    let composing = false
    const start = () => { composing = true }
    const end = () => { composing = false }
    const keydown = (event: KeyboardEvent) => {
      if (composing) return
      const binding = matchingWorkspaceBinding(event)
      if (!binding) return
      // Explorer owns inline rename; tabs use the file-operation command.
      if (binding.id === 'editor-rename' && event.target instanceof Element && event.target.closest('[data-explorer-path]')) return
      event.preventDefault()
      event.stopPropagation()
      binding.run(current.current, event)
    }
    window.addEventListener('compositionstart', start, true)
    window.addEventListener('compositionend', end, true)
    window.addEventListener('keydown', keydown, true)
    return () => {
      window.removeEventListener('compositionstart', start, true)
      window.removeEventListener('compositionend', end, true)
      window.removeEventListener('keydown', keydown, true)
    }
  }, [])
}
