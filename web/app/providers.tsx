'use client'

import { useState, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider, environmentManager } from '@tanstack/react-query'
import { useLiveEvents } from '../lib/events'

function LiveEvents() {
  useLiveEvents()
  return null
}

export function Providers({ children }: { children: ReactNode }) {
  // SSR에서 gcTime 타이머를 만들면 Node 24 AsyncContextFrame이 요청 렌더 전체를 타이머 만료까지 붙잡으므로 서버는 TanStack 기본값(Infinity)을 쓴다.
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, gcTime: environmentManager.isServer() ? Infinity : 10 * 60_000, refetchOnWindowFocus: false, structuralSharing: true } } }))
  return <QueryClientProvider client={queryClient}><LiveEvents />{children}</QueryClientProvider>
}
