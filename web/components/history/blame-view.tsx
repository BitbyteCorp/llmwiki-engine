"use client"

import { useQuery } from "@tanstack/react-query"
import Link from "next/link"
import { Fragment, useEffect, useId, useRef, useState, type JSX } from "react"
import { createPortal } from "react-dom"
import { request } from "@/lib/api"
import { cn } from "@/lib/utils"
import { ErrorNotice, Loading, formatDate } from "@/components/common"
import { Button } from "@/components/ui/button"
import styles from "./history.module.css"

type Range = { start: number; end: number; sha: string; authorName: string; date: string; summary: string; jobId?: string; source?: string }
const relativeTime = new Intl.RelativeTimeFormat("ko", { numeric: "auto" })
function age(date: string) { return relativeTime.format(Math.round((new Date(date).getTime() - Date.now()) / 86400000), "day") }

export function BlameView({ path, ref, content, className }: { path: string; ref?: string; content: string; className?: string }): JSX.Element {
  const blame = useQuery({ queryKey: ["history", "blame", path, ref], queryFn: () => request<{ ref: string; ranges: Range[] }>(`/api/notes/blame?${new URLSearchParams({ path, ...(ref ? { ref } : {}) })}`) })
  const [hover, setHover] = useState<{ range: Range; left: number; top: number } | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const popoverId = useId()
  function keepOpen() { window.clearTimeout(timer.current) }
  function closeLater() { keepOpen(); timer.current = window.setTimeout(() => setHover(null), 160) }
  function show(range: Range, element: HTMLElement) {
    keepOpen()
    const rect = element.getBoundingClientRect()
    setHover({ range, left: Math.max(8, Math.min(rect.left, window.innerWidth - 296)), top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 220)) })
  }
  useEffect(() => {
    const close = () => setHover(null)
    window.addEventListener("resize", close)
    return () => { window.removeEventListener("resize", close); window.clearTimeout(timer.current) }
  }, [])
  if (blame.isPending) return <div className={cn("min-h-0 flex-1 p-4", className)}><Loading/></div>
  if (blame.isError) return <div className={cn("space-y-3 p-4", className)}><ErrorNotice error={blame.error}/><Button variant="outline" onClick={() => blame.refetch()}>다시 시도</Button></div>
  const lines = content.replace(/\n$/, "").split("\n")
  const dates = blame.data.ranges.map(range => new Date(range.date).getTime())
  const oldest = Math.min(...dates), newest = Math.max(...dates)
  return <div className={cn(styles.blameScroll, className)} tabIndex={0} aria-label="줄별 이력 스크롤 영역" onScroll={() => setHover(null)} onKeyDown={event => { if (event.key === "Escape") setHover(null) }}>
    <table className={styles.blame} aria-label="줄별 작성 이력"><tbody>{blame.data.ranges.map(range => <Fragment key={range.start}>{Array.from({ length: range.end - range.start + 1 }, (_, offset) => <tr key={`${range.start}-${offset}`}>
      {offset === 0 && <td rowSpan={range.end - range.start + 1} className={styles.gutter} style={{ borderLeftColor: `color-mix(in srgb, var(--link) ${Math.round(35 + 65 * ((new Date(range.date).getTime() - oldest) / (newest - oldest || 1)))}%, var(--warning))` }}><div className={styles.blameMeta} onMouseEnter={event => show(range, event.currentTarget)} onMouseLeave={closeLater} onFocus={event => show(range, event.currentTarget)} onBlur={closeLater}>
        <Link href={`/history/commits/${range.sha}`} className="shrink-0 font-mono underline underline-offset-2" aria-describedby={hover?.range.start === range.start ? popoverId : undefined}>{range.sha.slice(0, 7)}</Link><span className="min-w-0 flex-1 truncate" title={range.authorName}>{range.authorName}</span><time className="shrink-0 text-muted-foreground" dateTime={range.date} title={formatDate(range.date)}>{age(range.date)}</time>
      </div></td>}
      <td className={styles.blameNumber}>{range.start + offset}</td><td className={styles.blameContent}>{lines[range.start + offset - 1] || " "}</td>
    </tr>)}</Fragment>)}</tbody></table>
    {hover && createPortal(<div id={popoverId} role="dialog" aria-label="줄 작성 커밋 정보" className={styles.blamePopover} style={{ left: hover.left, top: hover.top }} onMouseEnter={keepOpen} onMouseLeave={closeLater} onFocus={keepOpen} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) closeLater() }} onKeyDown={event => { if (event.key === "Escape") setHover(null) }}><p className="font-semibold">{hover.range.summary}</p><p className="text-muted-foreground">{hover.range.authorName} · {formatDate(hover.range.date)}</p><p className="text-muted-foreground">출처: {hover.range.source || "git"}</p><div className="flex flex-wrap gap-3"><Link className="underline" href={`/history/commits/${hover.range.sha}`}>커밋 보기</Link>{hover.range.jobId && <Link className="underline" href={`/jobs/${hover.range.jobId}`}>연결된 작업</Link>}</div></div>, document.body)}
  </div>
}
