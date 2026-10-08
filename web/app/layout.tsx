import type { Metadata, Viewport } from 'next'
import { Suspense, type ReactNode } from 'react'
import { Providers } from './providers'
import { ThemeProvider } from '@/components/theme-provider'
import { SplashScreen } from '@/components/common'
import 'katex/dist/katex.min.css'
import './globals.css'

export const metadata: Metadata = {
  title: 'LLM Wiki',
  description: '팀의 위키를 탐색하고, 도니에게 질문한다.',
  applicationName: 'LLM Wiki',
  appleWebApp: { capable: true, title: 'LLM Wiki', statusBarStyle: 'default' },
}
export const viewport: Viewport = { themeColor: [{ media: '(prefers-color-scheme: light)', color: '#ffffff' }, { media: '(prefers-color-scheme: dark)', color: '#171717' }] }

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="ko" suppressHydrationWarning><body><ThemeProvider><Providers><Suspense fallback={<SplashScreen />}>{children}</Suspense></Providers></ThemeProvider></body></html>
}
