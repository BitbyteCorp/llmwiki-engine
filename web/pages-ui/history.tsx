"use client"

import { useSearchParams } from "next/navigation"
import { ActivityPage } from "@/pages-ui/activity"
import { NoteHistory } from "@/pages-ui/note-history"

export function HistoryPage() {
  const params = useSearchParams()
  const path = params.get("path") || undefined
  if (!path || params.get("view") === "activity") return <ActivityPage/>
  return <NoteHistory key={path} path={path}/>
}
