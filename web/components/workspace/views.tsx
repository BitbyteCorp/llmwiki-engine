'use client'

import { Suspense, useMemo, type ReactNode } from 'react'
import dynamic from 'next/dynamic'
import { Files, GitCompareArrows, GitCommitHorizontal, Hash, History, Import, ListTodo, Moon, Network, Search, Settings, NotebookPen, TextSelect } from 'lucide-react'
import { Loading } from '@/components/common'
import { useWorkspace } from './context'
import { viewTabPathname, type GroupId } from './layout'
import { ViewLocationProvider } from './view-location'

const loading = () => <Loading label="화면을 준비하는 중…" />
const GraphView = dynamic(() => import('@/components/search/graph-view').then(module => module.GraphView), { ssr: false, loading })
const SearchPage = dynamic(() => import('@/pages-ui/search').then(module => module.SearchPage), { ssr: false, loading })
const DuplicatesPage = dynamic(() => import('@/components/search/duplicates-page').then(module => module.DuplicatesPage), { ssr: false, loading })
const TagsPage = dynamic(() => import('@/components/search/tags-view').then(module => module.TagsPage), { ssr: false, loading })
const TagNotesPage = dynamic(() => import('@/components/search/tags-view').then(module => module.TagNotesPage), { ssr: false, loading })
const HistoryPage = dynamic(() => import('@/pages-ui/history').then(module => module.HistoryPage), { ssr: false, loading })
const CommitPage = dynamic(() => import('@/pages-ui/commit-history').then(module => module.CommitPage), { ssr: false, loading })
const ComparePage = dynamic(() => import('@/pages-ui/history-compare').then(module => module.ComparePage), { ssr: false, loading })
const BlamePage = dynamic(() => import('@/pages-ui/history-blame').then(module => module.BlamePage), { ssr: false, loading })
const JobsPage = dynamic(() => import('@/pages-ui/jobs').then(module => module.JobsPage), { ssr: false, loading })
const JobPage = dynamic(() => import('@/pages-ui/jobs').then(module => module.JobPage), { ssr: false, loading })
const DreamsPage = dynamic(() => import('@/pages-ui/dreams').then(module => module.DreamsPage), { ssr: false, loading })
const DreamPage = dynamic(() => import('@/pages-ui/dreams').then(module => module.DreamPage), { ssr: false, loading })
const JournalPage = dynamic(() => import('@/pages-ui/journal').then(module => module.JournalPage), { ssr: false, loading })
const ImportsPage = dynamic(() => import('@/pages-ui/imports').then(module => module.ImportsPage), { ssr: false, loading })
const SettingsPage = dynamic(() => import('@/pages-ui/settings').then(module => module.SettingsPage), { ssr: false, loading })

const routes = {
  '/graph': { title: '그래프', icon: Network, screen: GraphView },
  '/search': { title: '검색', icon: Search, screen: SearchPage },
  '/search/duplicates': { title: '중복 노트', icon: Files, screen: DuplicatesPage },
  '/tags': { title: '태그', icon: Hash, screen: TagsPage },
  '/history': { title: '변경 이력', icon: History, screen: HistoryPage },
  '/history/compare': { title: '버전 비교', icon: GitCompareArrows, screen: ComparePage },
  '/history/blame': { title: '줄별 작성자', icon: TextSelect, screen: BlamePage },
  '/jobs': { title: '쓰기 작업', icon: ListTodo, screen: JobsPage },
  '/dreams': { title: '꿈꾸기', icon: Moon, screen: DreamsPage },
  '/journal': { title: '일기', icon: NotebookPen, screen: JournalPage },
  '/imports': { title: '원문 가져오기', icon: Import, screen: ImportsPage },
  '/settings': { title: '설정', icon: Settings, screen: SettingsPage },
} as const

function resolveView(pathname: string) {
  if (Object.hasOwn(routes, pathname)) return routes[pathname as keyof typeof routes]
  const segments = pathname.split('/')
  if (segments.length === 3 && segments[2]) {
    let segment = segments[2]
    try { segment = decodeURIComponent(segment) } catch { /* Keep malformed paths readable in tab labels. */ }
    if (segments[1] === 'tags') return { title: `#${segment}`, icon: Hash, screen: TagNotesPage }
    if (segments[1] === 'jobs') return { title: `작업 ${segment.slice(0, 8)}`, icon: ListTodo, screen: JobPage }
    if (segments[1] === 'dreams') return { title: `꿈꾸기 ${segment.slice(0, 8)}`, icon: Moon, screen: DreamPage }
  }
  if (segments.length === 4 && segments[1] === 'history' && segments[2] === 'commits' && segments[3]) {
    return { title: `변경 ${decodeURIComponent(segments[3]).slice(0, 8)}`, icon: GitCommitHorizontal, screen: CommitPage }
  }
  return undefined
}

export function viewTabTitle(path: string, query?: string): string {
  const pathname = viewTabPathname(path)
  const view = resolveView(pathname)
  if (pathname === '/history') {
    const params = new URLSearchParams(query)
    const notePath = params.get('path')
    if (notePath && params.get('view') !== 'activity') return `${notePath.split('/').at(-1)} · 변경 이력`
  }
  return view?.title ?? '알 수 없는 화면'
}

export function ViewTabIcon({ path, className }: { path: string; className?: string }): ReactNode {
  const Icon = resolveView(viewTabPathname(path))?.icon ?? Files
  return <Icon aria-hidden="true" className={className} />
}

export function ViewTabContent({ path, query, groupId }: { path: string; query?: string; groupId: GroupId }): ReactNode {
  const { openHref } = useWorkspace()
  const pathname = viewTabPathname(path)
  const location = useMemo(() => ({
    groupId,
    pathname,
    searchParams: new URLSearchParams(query),
    push: (href: string) => openHref(href, { group: groupId }),
    replace: (href: string) => openHref(href, { group: groupId, replace: true }),
  }), [groupId, pathname, query, openHref])
  const view = resolveView(pathname)
  let screen: ReactNode
  if (pathname === '/graph') screen = <GraphView groupId={groupId} />
  else if (view) {
    const Screen = view.screen
    screen = <Screen groupId={groupId} />
  } else screen = <p role="alert" className="py-3 text-label-13 text-muted-foreground">이 화면을 찾을 수 없습니다.</p>
  return <ViewLocationProvider value={location}><div className="h-full min-h-0 min-w-0 overflow-auto">
    <Suspense fallback={loading()}>{pathname === '/graph' ? screen : <div className="mx-auto h-full w-full max-w-6xl px-5 py-4">{screen}</div>}</Suspense>
  </div></ViewLocationProvider>
}
