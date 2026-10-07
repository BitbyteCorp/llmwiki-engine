'use client'

import { useState, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useLiveEvents } from '../lib/events'

function LiveEvents() {
  useLiveEvents()
  return null
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, gcTime: 10 * 60_000, refetchOnWindowFocus: false, structuralSharing: true } } }))
  return <QueryClientProvider client={queryClient}><LiveEvents />{children}</QueryClientProvider>
}
