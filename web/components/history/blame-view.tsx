"use client"

import { useQuery } from "@tanstack/react-query"
import Link from "next/link"
import { Fragment, useEffect, useId, useRef, useState, type JSX } from "react"
import { createPortal } from "react-dom"
import { request } from "@/lib/api"
import { cn } from "@/lib/utils"
import { ErrorNotice, Loading, formatDate } from "@/components/common"
import { Button } from "@/components/ui/button"
import { sourceLabel } from "./commit-meta"
import styles from "./history.module.css"

type Range = { start: number; end: number; sha: string; authorName: string; date: string; summary: string; jobId?: string; source?: string }
const relativeTime = new Intl.RelativeTimeFormat("ko", { numeric: "auto" })
function age(date: string) { return relativeTime.format(Math.round((new Date(date).getTime() - Date.now()) / 86400000), "day") }

export function BlameView({ path, ref, content, className }: { path: string; ref?: string; content: string; className?: string }): JSX.Element {
  const blame = useQuery({ queryKey: ["history", "blame", path, ref], queryFn: () => request<{ ref: string; ranges: Range[] }>(`/api/notes/blame?${new URLSearchParams({ path, ...(ref ? { ref } : {}) })}`) })
  const [hover, setHover] = useState<{ range: Range; left: number; top: number; pinned: boolean } | null>(null)
  const [mobile, setMobile] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const trigger = useRef<HTMLElement | null>(null)
  const popover = useRef<HTMLDivElement | null>(null)
  const popoverId = useId()
  function keepOpen() { window.clearTimeout(timer.current) }
  function closeLater() { keepOpen(); timer.current = window.setTimeout(() => setHover(current => current?.pinned ? current : null), 160) }
  function show(range: Range, element: HTMLElement, pinned = false) {
    if (hover?.pinned && !pinned) return
    keepOpen()
    trigger.current = element
    const rect = element.getBoundingClientRect()
    setHover({ range, left: Math.max(8, Math.min(rect.left, window.innerWidth - 296)), top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 220)), pinned })
  }
  function toggleInfo(range: Range, element: HTMLElement) {
    if (hover?.range.start === range.start && hover.pinned) setHover(null)
    else show(range, element, true)
  }
  useEffect(() => {
    const media = window.matchMedia("(max-width: 640px)")
    const updateWidth = () => setMobile(media.matches)
    const close = () => setHover(null)
    updateWidth()
    media.addEventListener("change", updateWidth)
    window.addEventListener("resize", close)
    return () => { media.removeEventListener("change", updateWidth); window.removeEventListener("resize", close); window.clearTimeout(timer.current) }
  }, [])
  useEffect(() => {
    if (!hover) return
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { if (hover.pinned) trigger.current?.focus(); setHover(null) } }
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !popover.current?.contains(event.target) && !trigger.current?.contains(event.target)) setHover(null)
    }
    document.addEventListener("keydown", onKeyDown)
    document.addEventListener("pointerdown", onPointerDown)
    return () => { document.removeEventListener("keydown", onKeyDown); document.removeEventListener("pointerdown", onPointerDown) }
  }, [hover])
  if (blame.isPending) return <div className={cn("min-h-0 flex-1 p-2", className)}><Loading/></div>
  if (blame.isError) return <div className={cn("space-y-3 p-2", className)}><ErrorNotice error={blame.error}/><Button variant="outline" onClick={() => blame.refetch()}>다시 시도</Button></div>
  const lines = content.replace(/\n$/, "").split("\n")
  const dates = blame.data.ranges.map(range => new Date(range.date).getTime())
  const oldest = Math.min(...dates), newest = Math.max(...dates)
  return <div className={cn(styles.blameScroll, className)} tabIndex={0} aria-label="줄별 작성자 스크롤 영역" onScroll={() => setHover(null)}>
    <table className={styles.blame} aria-label="줄별 작성자"><colgroup>{!mobile && <col style={{ width: "212px" }}/>}<col style={{ width: mobile ? "2.5rem" : "3rem" }}/><col/></colgroup><tbody>{blame.data.ranges.map(range => {
      const color = `color-mix(in srgb, var(--link) ${Math.round(35 + 65 * ((new Date(range.date).getTime() - oldest) / (newest - oldest || 1)))}%, var(--warning))`
      const infoButton = <Button size="xs" variant="ghost" className="h-6 px-1 text-[11px]" aria-haspopup="dialog" aria-expanded={hover?.range.start === range.start} aria-controls={hover?.range.start === range.start ? popoverId : undefined} onClick={event => toggleInfo(range, event.currentTarget)}>작성 정보</Button>
      const meta = <><span className="min-w-0 flex-1 truncate" title={range.authorName}>{range.authorName}</span><time className="shrink-0 text-muted-foreground" dateTime={range.date} title={formatDate(range.date)}>{age(range.date)}</time>{infoButton}</>
      return <Fragment key={range.start}>
        {mobile && <tr className={styles.blameGroupHeader}><td colSpan={2} style={{ borderLeftColor: color }}><div className={styles.blameGroupMeta}>{meta}</div></td></tr>}
        {Array.from({ length: range.end - range.start + 1 }, (_, offset) => <tr key={`${range.start}-${offset}`}>
          {!mobile && offset === 0 && <td rowSpan={range.end - range.start + 1} className={styles.gutter} style={{ borderLeftColor: color }}><div className={styles.blameMeta} onMouseEnter={event => show(range, event.currentTarget)} onMouseLeave={closeLater} onFocus={event => show(range, event.currentTarget)} onBlur={closeLater}>{meta}</div></td>}
          <td className={styles.blameNumber}>{range.start + offset}</td><td className={styles.blameContent}>{lines[range.start + offset - 1] || " "}</td>
        </tr>)}
      </Fragment>
    })}</tbody></table>
    {hover && createPortal(<div ref={popover} id={popoverId} role="dialog" aria-label="줄별 작성 정보" className={styles.blamePopover} style={{ left: hover.left, top: hover.top }} onMouseEnter={keepOpen} onMouseLeave={closeLater} onFocus={keepOpen} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) closeLater() }}><p className="font-semibold">{hover.range.summary}</p><p className="text-muted-foreground">{hover.range.authorName} · {formatDate(hover.range.date)}</p><p className="text-muted-foreground">출처: {sourceLabel(hover.range.source ? { "Wiki-Source": hover.range.source } : {})}</p><div className="flex flex-wrap gap-3"><Link className="underline" href={`/history/commits/${hover.range.sha}`}>변경 내용 보기</Link>{hover.range.jobId && <Link className="underline" href={`/jobs/${hover.range.jobId}`}>관련 작업 보기</Link>}</div></div>, document.body)}
  </div>
}
