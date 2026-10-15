'use client'

import type { ComponentType } from 'react'
import { BookOpen, Search, History, Gauge, Link2, Tags, type LucideIcon } from 'lucide-react'
import { SearchPanel } from '@/components/search/search-panel'
import { LinksPanel } from '@/components/links/links-panel'
import { TagsPanel } from '@/components/search/tags-panel'
import { OpsPanel } from '@/components/admin/ops-panel'
import { HistoryPanel } from '@/components/history/history-panel'
import { Explorer } from './explorer'

export type PanelId = 'explorer' | 'search' | 'history' | 'ops' | 'links' | 'tags'
type PanelProps = { userId: number }
type PanelDefinition = { id: PanelId; label: string; key: string; href: string; icon: LucideIcon; admin?: boolean; component: ComponentType<PanelProps> }

export const panelRegistry: PanelDefinition[] = [
  { id: 'explorer', label: '탐색기', key: 'Explorer', href: '/wiki', icon: BookOpen, component: Explorer },
  { id: 'search', label: '검색', key: 'Search', href: '/search', icon: Search, component: SearchPanel },
  { id: 'links', label: '백링크', key: 'Links Backlinks', href: '/wiki', icon: Link2, component: LinksPanel },
  { id: 'tags', label: '태그', key: 'Tags', href: '/tags', icon: Tags, component: TagsPanel },
  { id: 'history', label: '이력', key: 'History', href: '/history', icon: History, component: HistoryPanel },
  { id: 'ops', label: '운영', key: 'Operations', href: '/settings?tab=ops', icon: Gauge, component: OpsPanel, admin: true },
]
