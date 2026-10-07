'use client'

import type { ComponentType } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { BookOpen, Search, MessagesSquare, History, Settings, type LucideIcon } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useWorkspace } from './context'
import { Explorer } from './explorer'

export type PanelId = 'explorer' | 'search' | 'chat' | 'history' | 'admin'
type PanelProps = { userId: number }
type PanelDefinition = { id: PanelId; label: string; key: string; href: string; icon: LucideIcon; admin?: boolean; component: ComponentType<PanelProps> }

function SearchPanel() {
  const router = useRouter()
  return <div className="space-y-4 p-3"><h2 className="text-sm font-bold">검색</h2><form className="space-y-2" onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); router.push(`/search?q=${encodeURIComponent(String(form.get('q') || ''))}`) }}><Input name="q" aria-label="전체 노트 검색" placeholder="검색어…" /><Button type="submit" className="w-full">전체 노트 검색</Button></form><p className="text-xs text-muted-foreground">경로로 바로 열기: Ctrl/⌘ P</p></div>
}
function ChatPanel() {
  return <div className="space-y-3 p-3"><h2 className="text-sm font-bold">대화</h2><p className="text-xs text-muted-foreground">Luna와 지식에 관해 대화합니다.</p><Link className="explorer-row" href="/chat"><MessagesSquare className="size-4" />대화 목록 열기</Link></div>
}
function HistoryPanel() {
  const { activePath } = useWorkspace()
  return <div className="space-y-3 p-3"><h2 className="text-sm font-bold">이력</h2><Link className="explorer-row" href="/history">전체 변경 이력</Link>{activePath && <Link className="explorer-row" href={`/history?path=${encodeURIComponent(activePath)}`}>현재 노트 이력</Link>}<Link className="explorer-row" href="/history?tab=jobs">쓰기 작업</Link></div>
}
function AdminPanel() {
  return <div className="space-y-3 p-3"><h2 className="text-sm font-bold">관리</h2><Link className="explorer-row" href="/admin">사용자 및 설정</Link></div>
}

export const panelRegistry: PanelDefinition[] = [
  { id: 'explorer', label: '탐색기', key: 'Explorer', href: '/wiki', icon: BookOpen, component: Explorer },
  { id: 'search', label: '검색', key: 'Search', href: '/search', icon: Search, component: SearchPanel },
  { id: 'chat', label: '대화', key: 'Chat', href: '/chat', icon: MessagesSquare, component: ChatPanel },
  { id: 'history', label: '이력', key: 'History', href: '/history', icon: History, component: HistoryPanel },
  { id: 'admin', label: '관리', key: 'Admin', href: '/admin', icon: Settings, component: AdminPanel, admin: true },
]
