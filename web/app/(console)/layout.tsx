import type { ReactNode } from 'react'
import { connection } from 'next/server'
import { AppShell } from '@/components/app-shell'

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  await connection()
  return <AppShell publicUrl={process.env.PUBLIC_URL || undefined}>{children}</AppShell>
}
