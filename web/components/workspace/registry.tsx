'use client'

import type { ComponentType } from 'react'
import { BookOpen, Search, MessagesSquare, History, Settings, Link2, Tags, type LucideIcon } from 'lucide-react'
import { SearchPanel } from '@/components/search/search-panel'
import { LinksPanel } from '@/components/links/links-panel'
import { TagsPanel } from '@/components/search/tags-panel'
import { AdminPanel } from '@/components/admin/admin-panel'
import { ThreadsPanel } from '@/components/chat/threads'
import { HistoryPanel } from '@/components/history/history-panel'
import { Explorer } from './explorer'

export type PanelId = 'explorer' | 'search' | 'chat' | 'history' | 'admin' | 'links' | 'tags'
type PanelProps = { userId: number }
type PanelDefinition = { id: PanelId; label: string; key: string; href: string; icon: LucideIcon; admin?: boolean; component: ComponentType<PanelProps> }

export const panelRegistry: PanelDefinition[] = [
  { id: 'explorer', label: '탐색기', key: 'Explorer', href: '/wiki', icon: BookOpen, component: Explorer },
  { id: 'search', label: '검색', key: 'Search', href: '/search', icon: Search, component: SearchPanel },
  { id: 'links', label: '백링크', key: 'Links Backlinks', href: '/wiki', icon: Link2, component: LinksPanel },
  { id: 'tags', label: '태그', key: 'Tags', href: '/tags', icon: Tags, component: TagsPanel },
  { id: 'chat', label: '대화', key: 'Chat', href: '/chat', icon: MessagesSquare, component: ThreadsPanel },
  { id: 'history', label: '이력', key: 'History', href: '/history', icon: History, component: HistoryPanel },
  { id: 'admin', label: '관리', key: 'Admin', href: '/admin', icon: Settings, component: AdminPanel, admin: true },
]
