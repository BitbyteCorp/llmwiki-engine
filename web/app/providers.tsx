'use client'

import { useState, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useLiveEvents } from '../lib/events'

function LiveEvents() {
  useLiveEvents()
  return null
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15_000, refetchOnWindowFocus: true } } }))
  return <QueryClientProvider client={queryClient}><LiveEvents />{children}</QueryClientProvider>
}
