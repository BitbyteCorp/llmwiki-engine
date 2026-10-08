'use client'

import { createContext, useContext, type ReactNode } from 'react'
import type { GroupId } from './layout'

export type ViewLocation = {
  groupId: GroupId
  pathname: string
  searchParams: URLSearchParams
  push(href: string): void
  replace(href: string): void
}

const ViewLocationContext = createContext<ViewLocation | null>(null)

export function ViewLocationProvider({ value, children }: { value: ViewLocation; children: ReactNode }) {
  return <ViewLocationContext value={value}>{children}</ViewLocationContext>
}

export function useViewLocation(): ViewLocation {
  const location = useContext(ViewLocationContext)
  if (!location) throw new Error('useViewLocation requires ViewLocationProvider')
  return location
}
