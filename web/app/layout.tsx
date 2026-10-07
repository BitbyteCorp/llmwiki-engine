import type { Metadata, Viewport } from 'next'
import { Suspense, type ReactNode } from 'react'
import { Providers } from './providers'
import './globals.css'

export const metadata: Metadata = { title: 'LLM Wiki', description: '팀의 위키를 탐색하고, Luna에게 질문한다.' }
export const viewport: Viewport = { themeColor: '#ffffff' }

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="ko"><body><Providers><Suspense fallback={<div className="px-6 py-20 text-sm text-muted-foreground">불러오는 중…</div>}>{children}</Suspense></Providers></body></html>
}
